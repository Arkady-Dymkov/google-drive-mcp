import { existsSync } from "node:fs";

const forbiddenPaths = ["build/defaults.json"];
const found = forbiddenPaths.filter((path) => existsSync(path));

if (found.length > 0) {
  throw new Error(
    `Refusing to package embedded OAuth credentials: ${found.join(", ")}`,
  );
}
