import { open } from "node:fs/promises";
import { resolve } from "node:path";

const secretNames = [
  "HUNSU_GITHUB_CLIENT_SECRET",
  "HUNSU_GITHUB_PRIVATE_KEY",
  "HUNSU_GITHUB_WEBHOOK_SECRET",
  "HUNSU_SESSION_SECRET"
];

const outputIndex = process.argv.indexOf("--output");
const outputValue = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
if (process.argv.length !== 4 || outputIndex !== 2 || outputValue === undefined) {
  console.error("Usage: node write-wrangler-secrets.mjs --output <path>");
  process.exitCode = 1;
} else {
  const missing = secretNames.filter(name => !process.env[name]?.trim());
  if (missing.length > 0) {
    console.error(`Refusing to write Wrangler secrets file; missing: ${missing.join(", ")}.`);
    process.exitCode = 1;
  } else {
    const contents = Object.fromEntries(secretNames.map(name => [name, process.env[name]]));
    let handle;
    try {
      handle = await open(resolve(outputValue), "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(contents)}\n`, "utf8");
      console.log("Wrote the temporary Wrangler secrets file with mode 0600.");
    } catch (error) {
      console.error(error instanceof Error ? `Could not write Wrangler secrets file: ${error.message}` : "Could not write Wrangler secrets file.");
      process.exitCode = 1;
    } finally {
      await handle?.close();
    }
  }
}
