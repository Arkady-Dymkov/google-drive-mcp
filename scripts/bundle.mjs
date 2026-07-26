import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const external = Object.keys(packageJson.dependencies).flatMap((name) => [
  name,
  `${name}/*`,
]);

const result = await build({
  absWorkingDir: projectRoot,
  entryPoints: ["src/index.ts"],
  outfile: "build/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external,
  legalComments: "eof",
  metafile: true,
  logLevel: "info",
});

const bundledThirdParty = Object.keys(result.metafile.inputs)
  .map((path) => path.replaceAll("\\", "/"))
  .filter((path) => path.startsWith("node_modules/"));
const unexpected = bundledThirdParty.filter(
  (path) => !path.startsWith("node_modules/@modelcontextprotocol/sdk/"),
);
if (unexpected.length > 0) {
  throw new Error(`Unexpected bundled dependencies:\n${unexpected.join("\n")}`);
}
if (
  !bundledThirdParty.some((path) =>
    path.startsWith("node_modules/@modelcontextprotocol/sdk/"),
  )
) {
  throw new Error("MCP SDK was not bundled into build/index.js");
}
