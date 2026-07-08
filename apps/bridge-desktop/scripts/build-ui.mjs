import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const source = join(root, "src-ui");
const target = join(root, "dist-ui");

rmSync(target, { recursive: true, force: true });
copyDirectory(source, target);

function copyDirectory(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const sourcePath = join(from, entry);
    const targetPath = join(to, entry);
    if (statSync(sourcePath).isDirectory()) {
      copyDirectory(sourcePath, targetPath);
      continue;
    }
    copyFileSync(sourcePath, targetPath);
  }
}
