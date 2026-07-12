import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(packageRoot, "dist");
const cliSource = resolve(packageRoot, "src", "cli.ts");
const bareNodeBuiltins = new Set(builtinModules
  .filter(name => !name.startsWith("node:"))
  .map(name => name.replace(/^node:/u, "")));
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24.18",
  conditions: ["development", "node", "import", "default"],
  legalComments: "eof",
  minify: true,
  sourcemap: false,
  treeShaking: true,
  logLevel: "info"
};

const canonicalNodeBuiltinsPlugin = {
  name: "canonical-node-builtins",
  setup(context) {
    context.onResolve({ filter: /^[a-z][a-z0-9_/-]*$/ }, args => bareNodeBuiltins.has(args.path)
      ? { path: `node:${args.path}`, external: true }
      : undefined);
  }
};

const packagedCliPlugin = {
  name: "packaged-cli-entry",
  setup(context) {
    context.onLoad({ filter: /[/\\]src[/\\]cli\.ts$/ }, async args => {
      if (resolve(args.path) !== cliSource) return undefined;
      const source = await readFile(args.path, "utf8");
      const contents = source.replace(
        /\nif \(process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href\) \{[\s\S]*\n\}\s*$/u,
        "\n"
      );
      if (contents === source) throw new Error("The packaged CLI main guard could not be isolated.");
      return { contents, loader: "ts" };
    });
  }
};

await Promise.all([
  build({
    ...common,
    entryPoints: [resolve(packageRoot, "src", "package-api.ts")],
    outfile: resolve(dist, "index.js"),
    plugins: [canonicalNodeBuiltinsPlugin]
  }),
  build({
    ...common,
    stdin: {
      contents: `
        import { runBridgeCli } from "./src/cli.ts";
        runBridgeCli().then(code => {
          process.exitCode = code;
        }).catch(() => {
          process.stderr.write("Hunsu Bridge command failed unexpectedly.\\n");
          process.exitCode = 1;
        });
      `,
      resolveDir: packageRoot,
      sourcefile: "packaged-cli.mjs"
    },
    outfile: resolve(dist, "cli.js"),
    banner: { js: "#!/usr/bin/env node" },
    plugins: [canonicalNodeBuiltinsPlugin, packagedCliPlugin]
  })
]);

await copyFile(resolve(packageRoot, "src", "package-types.d.ts"), resolve(dist, "index.d.ts"));
