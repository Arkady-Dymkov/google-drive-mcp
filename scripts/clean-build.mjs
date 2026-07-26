import { rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const projectRoot = resolve(process.cwd());
const buildPath = resolve(projectRoot, "build");

if (basename(buildPath) !== "build" || dirname(buildPath) !== projectRoot) {
  throw new Error(`Refusing to clean unexpected path: ${buildPath}`);
}

rmSync(buildPath, { recursive: true, force: true });
