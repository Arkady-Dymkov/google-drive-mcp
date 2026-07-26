import { existsSync, readFileSync } from "node:fs";

const forbiddenPaths = ["build/defaults.json"];
const found = forbiddenPaths.filter((path) => existsSync(path));
if (found.length > 0) {
  throw new Error(
    `Refusing to package embedded OAuth credentials: ${found.join(", ")}`,
  );
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
if (packageJson.dependencies?.["@modelcontextprotocol/sdk"]) {
  throw new Error("The MCP SDK must be bundled, not installed in consumers");
}
if (packageJson.dependencies?.cheerio) {
  throw new Error("Cheerio must not return to the production dependency tree");
}
if (packageJson.bundleDependencies || packageJson.bundledDependencies) {
  throw new Error("Whole dependency packages must not be bundled");
}
if (packageJson.devDependencies?.["@modelcontextprotocol/sdk"] !== "1.29.0") {
  throw new Error("The bundled MCP SDK source must be pinned to 1.29.0");
}
if (packageJson.dependencies?.["googleapis-common"] !== "8.0.1") {
  throw new Error("googleapis-common must remain pinned to consumer-safe 8.0.1");
}

const expectedFiles = new Set([
  "build/index.js",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
]);
const actualFiles = new Set(packageJson.files ?? []);
if (
  expectedFiles.size !== actualFiles.size ||
  [...expectedFiles].some((path) => !actualFiles.has(path))
) {
  throw new Error("The npm files list must expose only the bundled CLI and docs");
}

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const lockedPackages = lock.packages ?? {};
const requiredVersions = [
  ["node_modules/@hono/node-server", "2.0.12"],
  ["node_modules/googleapis-common", "8.0.1"],
];
for (const [path, expectedVersion] of requiredVersions) {
  const actualVersion = lockedPackages[path]?.version;
  if (actualVersion !== expectedVersion) {
    throw new Error(`${path} must be ${expectedVersion}, found ${actualVersion}`);
  }
}
for (const forbidden of [
  "node_modules/glob",
  "node_modules/brace-expansion",
  "node_modules/whatwg-encoding",
]) {
  if (lockedPackages[forbidden]) {
    throw new Error(`${forbidden} must not be present in the release lockfile`);
  }
}

if (!existsSync("build/index.js")) {
  throw new Error("The bundled build/index.js is missing");
}
const bundle = readFileSync("build/index.js", "utf8");
if (bundle.includes("@hono/node-server")) {
  throw new Error("The server-only Hono adapter leaked into the MCP bundle");
}
const notice = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
if (!notice.includes("@modelcontextprotocol/sdk 1.29.0")) {
  throw new Error("The bundled MCP SDK license notice is missing");
}
