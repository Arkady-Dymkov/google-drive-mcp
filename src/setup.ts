import { google } from "googleapis";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
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

      const style = `body{font-family:system-ui;padding:60px;text-align:center;background:#f5f5f5}.c{background:#fff;padding:40px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);max-width:500px;margin:0 auto}p{color:#666}`;

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<html><head><style>${style}</style></head><body><div class="c"><h1 style="color:#d32f2f">Authorization Failed</h1><p>${escapeHtml(error)}</p></div></body></html>`,
        );
        server.close();
        reject(new Error(`Authorization error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><head><style>${style}</style></head><body><div class="c"><h1 style="color:#4caf50">Authorized!</h1><p>You can close this window.</p></div></body></html>`,
        );
        server.close();
        resolve(code);
      }
    });

    server.listen(port);

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

function showAccountConfig(
  name: string,
  clientId: string,
  clientSecret: string,
  hasBuiltIn: boolean,
): void {
  clack.note(
    getMcpConfigJson(name, clientId, clientSecret, hasBuiltIn),
    "MCP config (Claude Desktop / Air.dev / Cursor)",
  );

  clack.note(
    getClaudeCodeCmd(name, clientId, clientSecret, hasBuiltIn),
    "Claude Code command",
  );
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
  console.clear();
  clack.intro("Google Workspace MCP — Setup");

  const { clientId, clientSecret, isBuiltIn } = await resolveCredentials();

  // Account management loop
  while (true) {
    const accounts = listAccounts();

    const options: Array<{
      value: string;
      label: string;
      hint?: string;
    }> = [];

    for (const name of accounts) {
      options.push({ value: `account:${name}`, label: name, hint: "configured" });
    }

    options.push({ value: "__add", label: "Add new account" });
    if (accounts.length > 0) {
      options.push({ value: "__quit", label: "Done", hint: "exit setup" });
    }

    const choice = await clack.select({
      message:
        accounts.length > 0
          ? `${accounts.length} account(s) configured. Select to manage or add new:`
          : "No accounts yet. Let's add one:",
      options,
    });
    if (cancelled(choice)) break;

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
        showAccountConfig(cleanName, clientId, clientSecret, isBuiltIn);
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
      showAccountConfig(accountName, cfg.clientId, cfg.clientSecret, isBuiltIn);
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
  if (finalCount > 0) {
    clack.outro(
      `${finalCount} account(s) ready. Restart your AI client to use them.`,
    );
  } else {
    clack.outro("No accounts configured. Run --setup again to add one.");
  }
}
