import { google } from "googleapis";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { execSync } from "child_process";
import { URL } from "url";
import open from "open";
import * as clack from "@clack/prompts";
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
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

const OAUTH_PORT = 3000;
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const PKG_NAME = "adw-google-mcp";

// ── Helpers ──────────────────────────────────────────────────

function bail(msg?: string): never {
  clack.cancel(msg || "Setup cancelled.");
  process.exit(0);
}

function cancelled(value: unknown): value is symbol {
  if (clack.isCancel(value)) bail();
  return false;
}

function copyToClipboard(text: string): boolean {
  try {
    const cmd =
      process.platform === "win32"
        ? "clip"
        : process.platform === "darwin"
          ? "pbcopy"
          : "xclip -selection clipboard";
    execSync(cmd, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function configDir(): string {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listAccounts(): string[] {
  try {
    return fs
      .readdirSync(configDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

function accountPath(name: string): string {
  return path.join(configDir(), `${name}.json`);
}

function loadAccount(name: string): AppConfig | null {
  try {
    const p = accountPath(name);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {}
  return null;
}

function saveAccount(name: string, config: AppConfig): void {
  fs.writeFileSync(accountPath(name), JSON.stringify(config, null, 2));
}

// ── Built-in defaults ────────────────────────────────────────

function loadBuiltInDefaults(): {
  clientId: string;
  clientSecret: string;
} | null {
  try {
    const dir = new URL(".", import.meta.url).pathname;
    const p = path.join(dir, "defaults.json");
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
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
    const creds = JSON.parse(data);
    const src = creds.installed || creds.web;
    if (!src) return null;
    return { clientId: src.client_id, clientSecret: src.client_secret };
  } catch {
    return null;
  }
}

// ── OAuth flow ───────────────────────────────────────────────

function waitForOAuthCallback(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url!, `http://localhost:${port}`);
      const code = u.searchParams.get("code");
      const error = u.searchParams.get("error");

      const successHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorized</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1a1b26;color:#c0caf5;font-family:'SF Mono',SFMono-Regular,ui-monospace,Menlo,Consolas,monospace}
.page{max-width:520px;width:100%;padding:40px}
.line{height:1px;background:#2a2b3d;margin:32px 0}
.dot{width:10px;height:10px;border-radius:50%;background:#9ece6a;display:inline-block;margin-right:12px;vertical-align:middle}
h1{font-size:32px;font-weight:600;margin-bottom:8px;color:#c0caf5}
h1 span{color:#9ece6a}
.sub{color:#565f89;font-size:15px;margin-bottom:0}
.steps{margin-top:0}
.steps li{color:#787c99;font-size:14px;line-height:2.2;list-style:none}
.steps li::before{content:"";display:inline-block;width:6px;height:6px;border:1px solid #3b3d57;border-radius:1px;margin-right:10px;vertical-align:middle;transform:rotate(45deg)}
.steps code{color:#7aa2f7;background:#1e1f2e;padding:2px 6px;border-radius:3px;font-size:13px}
.footer{color:#3b3d57;font-size:12px;margin-top:32px}
</style></head>
<body><div class="page">
  <div><span class="dot"></span><span style="color:#9ece6a;font-size:14px">authorized</span></div>
  <div class="line"></div>
  <h1>You<span>'</span>re connected<span>.</span></h1>
  <p class="sub">Return to the terminal to finish setup.</p>
  <div class="line"></div>
  <ul class="steps">
    <li>The setup wizard will show your MCP configuration</li>
    <li>Copy it with one click</li>
    <li>Paste into your AI client and restart</li>
  </ul>
  <div class="line"></div>
  <p class="footer">adw-google-mcp &middot; you can close this tab</p>
</div></body></html>`;

      const errorHtml = (msg: string) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Failed</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1a1b26;color:#c0caf5;font-family:'SF Mono',SFMono-Regular,ui-monospace,Menlo,Consolas,monospace}
.page{max-width:520px;width:100%;padding:40px}
.line{height:1px;background:#2a2b3d;margin:32px 0}
.dot{width:10px;height:10px;border-radius:50%;background:#f7768e;display:inline-block;margin-right:12px;vertical-align:middle}
h1{font-size:32px;font-weight:600;color:#c0caf5}
.err{color:#f7768e;font-size:14px;margin-top:12px;font-family:inherit}
.hint{color:#565f89;font-size:14px;margin-top:20px}
.footer{color:#3b3d57;font-size:12px;margin-top:32px}
</style></head>
<body><div class="page">
  <div><span class="dot"></span><span style="color:#f7768e;font-size:14px">failed</span></div>
  <div class="line"></div>
  <h1>Authorization failed.</h1>
  <p class="err">${msg}</p>
  <p class="hint">Close this tab and try running setup again.</p>
  <div class="line"></div>
  <p class="footer">adw-google-mcp</p>
</div></body></html>`;

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(errorHtml(escapeHtml(error)));
        server.close();
        reject(new Error(`Authorization error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(successHtml);
        server.close();
        resolve(code);
      }
    });

    server.listen(port, "127.0.0.1");

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
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: OAUTH_SCOPES,
    prompt: "consent",
  });

  const s = clack.spinner();

  try {
    await open(authUrl);
  } catch {}

  s.start("Waiting for browser authorization...");
  const code = await waitForOAuthCallback(OAUTH_PORT);
  s.message("Exchanging tokens...");

  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    s.stop("Failed.");
    throw new Error(
      "No refresh token. Go to https://myaccount.google.com/permissions, remove this app, and retry.",
    );
  }

  s.stop("Authorized!");
  return tokens.refresh_token;
}

// ── Config output ────────────────────────────────────────────

function getMcpConfigJson(
  name: string,
  clientId: string,
  clientSecret: string,
  hasBuiltIn: boolean,
): string {
  const env: Record<string, string> = {
    GOOGLE_DRIVE_PROFILE: name,
    GOOGLE_DRIVE_SERVER_NAME: `google-workspace-${name}`,
  };
  if (!hasBuiltIn) {
    env.GOOGLE_CLIENT_ID = clientId;
    env.GOOGLE_CLIENT_SECRET = clientSecret;
  }
  return JSON.stringify(
    {
      mcpServers: {
        [`google-workspace-${name}`]: {
          command: "npx",
          args: ["-y", PKG_NAME],
          env,
        },
      },
    },
    null,
    2,
  );
}

function getClaudeCodeCmd(
  name: string,
  clientId: string,
  clientSecret: string,
  hasBuiltIn: boolean,
): string {
  const envParts = [
    `GOOGLE_DRIVE_PROFILE=${name}`,
    `GOOGLE_DRIVE_SERVER_NAME=google-workspace-${name}`,
  ];
  if (!hasBuiltIn) {
    envParts.push(`GOOGLE_CLIENT_ID=${clientId}`);
    envParts.push(`GOOGLE_CLIENT_SECRET=${clientSecret}`);
  }
  return `claude mcp add google-workspace-${name} -e ${envParts.join(" -e ")} -- npx -y ${PKG_NAME}`;
}

async function showAccountConfig(
  name: string,
  clientId: string,
  clientSecret: string,
  hasBuiltIn: boolean,
): Promise<void> {
  const mcpJson = getMcpConfigJson(name, clientId, clientSecret, hasBuiltIn);
  const claudeCmd = getClaudeCodeCmd(name, clientId, clientSecret, hasBuiltIn);

  clack.note(mcpJson, "MCP config (Claude Desktop / Air.dev / Cursor)");
  clack.note(claudeCmd, "Claude Code command");

  const action = await clack.select({
    message: "Copy to clipboard?",
    options: [
      { value: "mcp", label: "Copy MCP config JSON" },
      { value: "claude", label: "Copy Claude Code command" },
      { value: "skip", label: "Skip" },
    ],
  });
  if (cancelled(action)) return;

  if (action === "mcp") {
    if (copyToClipboard(mcpJson)) {
      clack.log.success("MCP config copied to clipboard!");
    } else {
      clack.log.warning("Could not copy — please select and copy manually.");
    }
  } else if (action === "claude") {
    if (copyToClipboard(claudeCmd)) {
      clack.log.success("Claude Code command copied to clipboard!");
    } else {
      clack.log.warning("Could not copy — please select and copy manually.");
    }
  }
}

// ── Credential resolution ────────────────────────────────────

async function resolveCredentials(): Promise<{
  clientId: string;
  clientSecret: string;
  isBuiltIn: boolean;
}> {
  // Env vars take priority (silent)
  const envId = process.env.GOOGLE_CLIENT_ID;
  const envSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret, isBuiltIn: false };
  }

  // Check built-in defaults
  const builtIn = loadBuiltInDefaults();

  if (builtIn) {
    const choice = await clack.select({
      message: "How do you want to connect?",
      options: [
        {
          value: "builtin",
          label: "Use built-in credentials",
          hint: "recommended",
        },
        { value: "own", label: "Use my own Google Cloud project" },
      ],
    });
    if (cancelled(choice)) return null!;

    if (choice === "builtin") {
      return { ...builtIn, isBuiltIn: true };
    }
  }

  // Own credentials
  const method = await clack.select({
    message: "How do you want to provide credentials?",
    options: [
      { value: "json", label: "OAuth JSON file", hint: "downloaded from Google Cloud" },
      { value: "manual", label: "Enter Client ID & Secret manually" },
    ],
  });
  if (cancelled(method)) return null!;

  if (method === "json") {
    const jsonPath = await clack.text({
      message: "Path to OAuth JSON file (drag & drop works)",
      validate: (v) => {
        if (!v?.trim()) return "Path is required";
        const clean = v.trim().replace(/^['"]|['"]$/g, "");
        if (!fs.existsSync(clean)) return "File not found";
        return undefined;
      },
    });
    if (cancelled(jsonPath)) return null!;

    const clean = (jsonPath as string).trim().replace(/^['"]|['"]$/g, "");
    const creds = extractCredentialsFromJson(clean);
    if (creds) {
      clack.log.success(`Loaded credentials from JSON file`);
      return { ...creds, isBuiltIn: false };
    }
    clack.log.error("Could not parse JSON file.");
    bail("Invalid credentials file.");
  }

  // Manual entry
  const clientId = await clack.text({
    message: "Client ID",
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });
  if (cancelled(clientId)) return null!;

  const clientSecret = await clack.text({
    message: "Client Secret",
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });
  if (cancelled(clientSecret)) return null!;

  return {
    clientId: (clientId as string).trim(),
    clientSecret: (clientSecret as string).trim(),
    isBuiltIn: false,
  };
}

// ── Main ─────────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
  clack.intro("Google Workspace MCP — Setup");

  const { clientId, clientSecret, isBuiltIn } = await resolveCredentials();

  // Account management loop
  while (true) {
    const accounts = listAccounts();

    const accountOptions: Array<{
      value: string;
      label: string;
      hint?: string;
    }> = accounts.map((name) => ({
      value: `account:${name}`,
      label: name,
      hint: "configured",
    }));

    const actionOptions: Array<{
      value: string;
      label: string;
      hint?: string;
    }> = [{ value: "__add", label: "Add new account" }];

    if (accounts.length > 0) {
      actionOptions.push({
        value: "__quit",
        label: "Done",
        hint: "exit setup",
      });
    }

    const options =
      accountOptions.length > 0
        ? [
            ...accountOptions,
            { value: "__sep", label: "─".repeat(30), hint: "" },
            ...actionOptions,
          ]
        : actionOptions;

    const choice = await clack.select({
      message:
        accounts.length > 0
          ? `${accounts.length} account(s) configured`
          : "No accounts yet. Let's add one:",
      options,
    });
    if (cancelled(choice)) break;
    if (choice === "__sep") continue;

    // ── Add account ──
    if (choice === "__add") {
      const name = await clack.text({
        message: "Account name",
        placeholder: "e.g., work, personal, client-acme",
        validate: (v) => {
          const clean = (v || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
          if (!clean) return "Name is required";
          if (clean.length > 30) return "Name too long (max 30 chars)";
          return undefined;
        },
      });
      if (cancelled(name)) continue;

      const cleanName = (name as string)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-");

      if (accounts.includes(cleanName)) {
        const overwrite = await clack.confirm({
          message: `"${cleanName}" already exists. Re-authorize?`,
        });
        if (cancelled(overwrite) || !overwrite) continue;
      }

      try {
        const refreshToken = await performOAuth(clientId, clientSecret);

        saveAccount(cleanName, {
          clientId,
          clientSecret,
          redirectUri: `http://localhost:${OAUTH_PORT}`,
          refreshToken,
        });

        clack.log.success(`Account "${cleanName}" saved!`);
        await showAccountConfig(cleanName, clientId, clientSecret, isBuiltIn);
      } catch (err: unknown) {
        clack.log.error(err instanceof Error ? err.message : String(err));
      }
      continue;
    }

    // ── Quit ──
    if (choice === "__quit") break;

    // ── Manage existing account ──
    const accountName = (choice as string).replace("account:", "");
    const cfg = loadAccount(accountName);

    const action = await clack.select({
      message: `Account: ${accountName}`,
      options: [
        { value: "config", label: "Show configuration" },
        {
          value: "reauth",
          label: "Re-authorize",
          hint: "new browser OAuth flow",
        },
        { value: "delete", label: "Delete account", hint: "cannot be undone" },
        { value: "back", label: "Back" },
      ],
    });
    if (cancelled(action)) continue;

    if (action === "config" && cfg) {
      await showAccountConfig(accountName, cfg.clientId, cfg.clientSecret, isBuiltIn);
    }

    if (action === "reauth") {
      try {
        const refreshToken = await performOAuth(clientId, clientSecret);
        saveAccount(accountName, {
          clientId,
          clientSecret,
          redirectUri: `http://localhost:${OAUTH_PORT}`,
          refreshToken,
        });
        clack.log.success(`Account "${accountName}" re-authorized!`);
      } catch (err: unknown) {
        clack.log.error(err instanceof Error ? err.message : String(err));
      }
    }

    if (action === "delete") {
      const confirm = await clack.confirm({
        message: `Delete "${accountName}"? This cannot be undone.`,
      });
      if (!cancelled(confirm) && confirm) {
        const p = accountPath(accountName);
        if (fs.existsSync(p)) fs.unlinkSync(p);
        clack.log.success(`Account "${accountName}" deleted.`);
      }
    }
  }

  const finalCount = listAccounts().length;
  const msg =
    finalCount > 0
      ? `${finalCount} account(s) ready. Restart your AI client to use them.`
      : "No accounts configured. Run --setup again to add one.";
  console.log();
  clack.outro(msg);
  process.exit(0);
}
