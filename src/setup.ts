import { google } from "googleapis";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as http from "http";
import { URL } from "url";
import open from "open";
import { getConfigDir } from "./auth.js";
import { escapeHtml } from "./utils.js";
import type { AppConfig } from "./types.js";

const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

const OAUTH_PORT = 3000;
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const PKG_NAME = "adw-google-mcp";

// ── Helpers ──────────────────────────────────────────────────

function ask(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

function line(ch = "─", len = 50): string {
  return ch.repeat(len);
}

function configDir(): string {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listAccounts(): string[] {
  const dir = configDir();
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json") && f !== "credentials.json")
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

function accountConfigPath(name: string): string {
  return path.join(configDir(), `${name}.json`);
}

function loadAccount(name: string): AppConfig | null {
  try {
    const p = accountConfigPath(name);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {}
  return null;
}

function saveAccount(name: string, config: AppConfig): void {
  fs.writeFileSync(accountConfigPath(name), JSON.stringify(config, null, 2));
}

function deleteAccount(name: string): void {
  const p = accountConfigPath(name);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ── Built-in defaults (injected at publish time by CI) ────

function loadBuiltInDefaults(): {
  clientId: string;
  clientSecret: string;
} | null {
  try {
    const dir = new URL(".", import.meta.url).pathname;
    const defaultsPath = path.join(dir, "defaults.json");
    if (fs.existsSync(defaultsPath)) {
      const data = JSON.parse(fs.readFileSync(defaultsPath, "utf-8"));
      if (data.clientId && data.clientSecret) return data;
    }
  } catch {}
  return null;
}

function extractCredentialsFromJson(
  jsonPath: string,
): { clientId: string; clientSecret: string } | null {
  try {
    const data = fs.readFileSync(jsonPath, "utf-8");
    const credentials = JSON.parse(data);
    const source = credentials.installed || credentials.web;
    if (!source) return null;
    return { clientId: source.client_id, clientSecret: source.client_secret };
  } catch {
    return null;
  }
}

// ── OAuth flow ───────────────────────────────────────────────

function waitForOAuthCallback(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url!, `http://localhost:${port}`);
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><head><title>Failed</title>
          <style>body{font-family:system-ui;padding:60px;text-align:center;background:#f5f5f5}
          .c{background:#fff;padding:40px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);max-width:500px;margin:0 auto}
          h1{color:#d32f2f}p{color:#666}</style></head>
          <body><div class="c"><h1>Authorization Failed</h1>
          <p>${escapeHtml(error)}</p></div></body></html>`);
        server.close();
        reject(new Error(`Authorization error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><head><title>Success</title>
          <style>body{font-family:system-ui;padding:60px;text-align:center;background:#f5f5f5}
          .c{background:#fff;padding:40px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);max-width:500px;margin:0 auto}
          h1{color:#4caf50}p{color:#666}</style></head>
          <body><div class="c"><h1>Authorization Successful!</h1>
          <p>You can close this window.</p></div></body></html>`);
        server.close();
        resolve(code);
      }
    });

    server.listen(port, () => {
      console.log(`  Waiting for authorization on port ${port}...`);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is in use. Close other apps and retry.`));
      } else {
        reject(err);
      }
    });

    setTimeout(() => {
      server.close();
      reject(new Error("Authorization timeout (5 min). Try again."));
    }, OAUTH_TIMEOUT_MS);
  });
}

async function performOAuth(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const redirectUri = `http://localhost:${OAUTH_PORT}`;
  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri,
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: OAUTH_SCOPES,
    prompt: "consent",
  });

  console.log("\n  Opening browser for authorization...");
  console.log(`  If it doesn't open, visit: ${authUrl}\n`);

  try {
    await open(authUrl);
  } catch {}

  const code = await waitForOAuthCallback(OAUTH_PORT);
  console.log("  Authorization received! Exchanging tokens...\n");

  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "No refresh token received. Go to https://myaccount.google.com/permissions, remove this app, and try again.",
    );
  }

  return tokens.refresh_token;
}

// ── MCP config output ────────────────────────────────────────

function getMcpConfig(
  accountName: string,
  clientId: string,
  clientSecret: string,
  hasBuiltIn: boolean,
): Record<string, unknown> {
  const env: Record<string, string> = {
    GOOGLE_DRIVE_PROFILE: accountName,
    GOOGLE_DRIVE_SERVER_NAME: `google-workspace-${accountName}`,
  };
  if (!hasBuiltIn) {
    env.GOOGLE_CLIENT_ID = clientId;
    env.GOOGLE_CLIENT_SECRET = clientSecret;
  }
  return {
    command: "npx",
    args: ["-y", PKG_NAME],
    env,
  };
}

function getClaudeCodeCommand(
  accountName: string,
  clientId: string,
  clientSecret: string,
  hasBuiltIn: boolean,
): string {
  const envParts = [
    `GOOGLE_DRIVE_PROFILE=${accountName}`,
    `GOOGLE_DRIVE_SERVER_NAME=google-workspace-${accountName}`,
  ];
  if (!hasBuiltIn) {
    envParts.push(`GOOGLE_CLIENT_ID=${clientId}`);
    envParts.push(`GOOGLE_CLIENT_SECRET=${clientSecret}`);
  }
  return `claude mcp add google-workspace-${accountName} -e ${envParts.join(" -e ")} -- npx -y ${PKG_NAME}`;
}

function printAccountConfig(
  accountName: string,
  clientId: string,
  clientSecret: string,
  hasBuiltIn: boolean,
): void {
  const mcpConfig = getMcpConfig(accountName, clientId, clientSecret, hasBuiltIn);

  console.log(`\n  MCP client config (Claude Desktop / Air.dev / Cursor):\n`);
  console.log(
    `  ${JSON.stringify({ mcpServers: { [`google-workspace-${accountName}`]: mcpConfig } }, null, 2).split("\n").join("\n  ")}`,
  );

  console.log(`\n  Claude Code command:\n`);
  console.log(`  ${getClaudeCodeCommand(accountName, clientId, clientSecret, hasBuiltIn)}`);
  console.log();
}

// ── Credential resolution ────────────────────────────────────

async function resolveCredentials(
  rl: readline.Interface,
): Promise<{ clientId: string; clientSecret: string; isBuiltIn: boolean }> {
  // Check env vars first
  const envId = process.env.GOOGLE_CLIENT_ID;
  const envSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret, isBuiltIn: false };
  }

  // Check built-in defaults
  const builtIn = loadBuiltInDefaults();

  if (builtIn) {
    console.log("\n  How do you want to connect?\n");
    console.log("  1) Use built-in credentials (recommended)");
    console.log("  2) Use my own Google Cloud project\n");
    const choice = await ask(rl, "  Choose [1]: ");

    if (choice.trim() === "2") {
      return { ...(await askForOwnCredentials(rl)), isBuiltIn: false };
    }
    return { ...builtIn, isBuiltIn: true };
  }

  // No built-in — must provide own
  return { ...(await askForOwnCredentials(rl)), isBuiltIn: false };
}

async function askForOwnCredentials(
  rl: readline.Interface,
): Promise<{ clientId: string; clientSecret: string }> {
  console.log("\n  You need a Google Cloud project with OAuth credentials.");
  console.log("  See README for setup instructions.\n");

  const hasJson = await ask(rl, "  Have an OAuth JSON file? (y/n): ");
  if (hasJson.toLowerCase() === "y") {
    const jsonPath = await ask(rl, "  Path to JSON file: ");
    const creds = extractCredentialsFromJson(
      jsonPath.trim().replace(/^['"]|['"]$/g, ""),
    );
    if (creds) {
      console.log(`  Loaded: ${creds.clientId.substring(0, 25)}...`);
      return creds;
    }
    console.log("  Could not parse file. Enter manually:\n");
  }

  const clientId = (await ask(rl, "  Client ID: ")).trim();
  const clientSecret = (await ask(rl, "  Client Secret: ")).trim();
  return { clientId, clientSecret };
}

// ── Main menu ────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // Step 1: Resolve credentials
    console.clear();
    console.log(line("="));
    console.log("  Google Workspace MCP — Setup");
    console.log(line("="));

    const { clientId, clientSecret, isBuiltIn } =
      await resolveCredentials(rl);

    // Step 2: Account management loop
    while (true) {
      const accounts = listAccounts();

      console.log(`\n${line()}`);
      console.log("  Accounts");
      console.log(line());

      if (accounts.length === 0) {
        console.log("\n  No accounts configured yet.\n");
      } else {
        console.log();
        accounts.forEach((name, i) => {
          console.log(`  ${i + 1}) ${name}`);
        });
        console.log();
      }

      console.log(`  a) Add new account`);
      if (accounts.length > 0) {
        console.log(`  v) View account config`);
        console.log(`  d) Delete account`);
      }
      console.log(`  q) Quit\n`);

      const choice = (await ask(rl, "  Choose: ")).trim().toLowerCase();

      // ── Add account ──
      if (choice === "a") {
        console.log(`\n${line()}`);
        console.log("  Add Account");
        console.log(line());

        const name = (
          await ask(rl, "\n  Account name (e.g., work, personal): ")
        )
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, "-");

        if (!name) {
          console.log("  Invalid name.");
          continue;
        }

        if (accounts.includes(name)) {
          const overwrite = await ask(
            rl,
            `  "${name}" already exists. Re-authorize? (y/n): `,
          );
          if (overwrite.toLowerCase() !== "y") continue;
        }

        try {
          console.log(`\n  Authorizing "${name}"...`);
          const refreshToken = await performOAuth(clientId, clientSecret);

          saveAccount(name, {
            clientId,
            clientSecret,
            redirectUri: `http://localhost:${OAUTH_PORT}`,
            refreshToken,
          });

          console.log(`  Account "${name}" saved!\n`);
          console.log(line());
          console.log("  Configuration for your AI client:");
          printAccountConfig(name, clientId, clientSecret, isBuiltIn);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`\n  Error: ${msg}`);
        }
        continue;
      }

      // ── View account ──
      if (choice === "v" && accounts.length > 0) {
        const idx = await ask(rl, "  Account number: ");
        const account = accounts[parseInt(idx) - 1];
        if (!account) {
          console.log("  Invalid selection.");
          continue;
        }
        const cfg = loadAccount(account);
        if (cfg) {
          console.log(`\n${line()}`);
          console.log(`  Account: ${account}`);
          console.log(line());
          printAccountConfig(
            account,
            cfg.clientId,
            cfg.clientSecret,
            isBuiltIn,
          );
        }
        continue;
      }

      // ── Delete account ──
      if (choice === "d" && accounts.length > 0) {
        const idx = await ask(rl, "  Account number to delete: ");
        const account = accounts[parseInt(idx) - 1];
        if (!account) {
          console.log("  Invalid selection.");
          continue;
        }
        const confirm = await ask(
          rl,
          `  Delete "${account}"? This cannot be undone. (y/n): `,
        );
        if (confirm.toLowerCase() === "y") {
          deleteAccount(account);
          console.log(`  Account "${account}" deleted.`);
        }
        continue;
      }

      // ── Quit ──
      if (choice === "q") {
        const accounts2 = listAccounts();
        if (accounts2.length === 0) {
          console.log("\n  No accounts configured. Run --setup again to add one.\n");
        } else {
          console.log(
            `\n  ${accounts2.length} account(s) configured. Restart your AI client to use them.\n`,
          );
        }
        break;
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n  Error: ${message}\n`);
    process.exit(1);
  } finally {
    rl.close();
  }
}
