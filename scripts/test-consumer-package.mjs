import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const projectRoot = process.cwd();
const packageJson = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf8"),
);
const temporaryRoot = mkdtempSync(join(tmpdir(), "adw-consumer-check-"));
const packDirectory = join(temporaryRoot, "pack");
const consumerDirectory = join(temporaryRoot, "consumer");
mkdirSync(packDirectory);
mkdirSync(consumerDirectory);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    env: { ...process.env, npm_config_dry_run: "false" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.error?.message ?? "signal"})\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function hasPackage(lock, packageName) {
  const suffix = `node_modules/${packageName}`;
  return Object.keys(lock.packages ?? {}).some(
    (path) => path === suffix || path.endsWith(`/${suffix}`),
  );
}

function smokeMcp(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      cwd: consumerDirectory,
      env: {
        ...process.env,
        GOOGLE_WORKSPACE_CONFIG: join(temporaryRoot, "missing-profile.json"),
        GOOGLE_WORKSPACE_SERVICES: "all",
        GOOGLE_WORKSPACE_TOOL_MODE: "all",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (error) reject(error);
      else resolve();
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(
      () => finish(new Error(`Packed MCP smoke test timed out\n${stderr}`)),
      10_000,
    );

    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        finish(new Error(`Packed MCP returned invalid JSON: ${error}\n${line}`));
        return;
      }
      if (message.id === 1) {
        if (message.result?.serverInfo?.version !== packageJson.version) {
          finish(new Error("Packed MCP initialize returned the wrong version"));
          return;
        }
        send({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      } else if (message.id === 2) {
        const tools = message.result?.tools;
        const names = new Set(tools?.map((tool) => tool.name));
        if (
          !Array.isArray(tools) ||
          tools.length !== 170 ||
          !names.has("list_document_tabs") ||
          !names.has("format_code_block_in_document")
        ) {
          finish(new Error("Packed MCP tools/list did not return all 170 tools"));
          return;
        }
        finish();
      }
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(
          new Error(
            `Packed MCP exited before tools/list (${code ?? signal})\n${stderr}`,
          ),
        );
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "consumer-check", version: "1.0.0" },
      },
    });
  });
}

try {
  const packed = JSON.parse(
    run(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        packDirectory,
      ],
      projectRoot,
    ),
  )[0];
  if (packed.bundled?.length) {
    throw new Error("The tarball must not contain whole bundled dependencies");
  }
  if (packed.size > 2 * 1024 * 1024) {
    throw new Error(`The packed tarball unexpectedly grew to ${packed.size} bytes`);
  }
  const expectedFiles = new Set([
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "build/index.js",
    "package.json",
  ]);
  const actualFiles = new Set(packed.files.map(({ path }) => path));
  if (
    expectedFiles.size !== actualFiles.size ||
    [...expectedFiles].some((path) => !actualFiles.has(path))
  ) {
    throw new Error("The tarball contains an unexpected file set");
  }

  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "adw-google-mcp-consumer-check",
        version: "1.0.0",
        private: true,
      },
      null,
      2,
    )}\n`,
  );
  const tarball = join(packDirectory, packed.filename);
  run(
    "npm",
    ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"],
    consumerDirectory,
  );
  run("npm", ["ls", "--all"], consumerDirectory);

  const consumerLock = JSON.parse(
    readFileSync(join(consumerDirectory, "package-lock.json"), "utf8"),
  );
  for (const forbidden of [
    "@modelcontextprotocol/sdk",
    "@hono/node-server",
    "glob",
    "brace-expansion",
    "cheerio",
    "whatwg-encoding",
  ]) {
    if (hasPackage(consumerLock, forbidden)) {
      throw new Error(`${forbidden} must not be installed for consumers`);
    }
  }
  const common = consumerLock.packages?.["node_modules/googleapis-common"];
  if (common?.version !== "8.0.1") {
    throw new Error("Consumers must receive googleapis-common 8.0.1");
  }

  const audit = JSON.parse(
    run("npm", ["audit", "--omit=dev", "--json"], consumerDirectory),
  );
  if (audit.metadata?.vulnerabilities?.total !== 0) {
    throw new Error("The packed consumer dependency tree contains vulnerabilities");
  }

  const executable = join(
    consumerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${packageJson.name}.cmd` : packageJson.name,
  );
  if (!existsSync(executable)) {
    throw new Error("The packed CLI executable is missing");
  }
  const reportedVersion = run(executable, ["--version"], consumerDirectory).trim();
  if (reportedVersion !== packageJson.version) {
    throw new Error(
      `Packed CLI reported ${reportedVersion}; expected ${packageJson.version}`,
    );
  }
  if (!run(executable, ["--help"], consumerDirectory).includes("Google Workspace MCP Server")) {
    throw new Error("The packed CLI help smoke test failed");
  }
  await smokeMcp(executable);

  console.log(
    `Consumer package verified: ${packageJson.name}@${packageJson.version}, ${packed.size} bytes, 170 MCP tools, 0 vulnerabilities`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
