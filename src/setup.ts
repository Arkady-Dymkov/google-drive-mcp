import { google } from "googleapis";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { execSync } from "child_process";
import { randomBytes, timingSafeEqual } from "crypto";
import { URL } from "url";
import open from "open";
import * as clack from "@clack/prompts";
import { CodeChallengeMethod } from "google-auth-library";
import { getConfigDir, loadConfig, saveConfig } from "./auth.js";
import { escapeHtml } from "./utils.js";
import type { AppConfig } from "./types.js";
import {
  LEGACY_SERVICE_IDS,
  SERVICE_LABELS,
  WORKSPACE_SERVICE_IDS,
  scopesForServices,
  type WorkspaceServiceId,
} from "./scopes.js";

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

function oauthPort(): number {
  const value = Number(process.env.GOOGLE_OAUTH_PORT ?? 3000);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(
      "GOOGLE_OAUTH_PORT must be an integer between 1024 and 65535",
    );
  }
  return value;
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
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
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
  return loadConfig(accountPath(name));
}

function saveAccount(name: string, config: AppConfig): void {
  saveConfig(accountPath(name), config);
}

function extractCredentialsFromJson(
  jsonPath: string,
): { clientId: string; clientSecret: string } | null {
  try {
    const data = fs.readFileSync(jsonPath, "utf-8");
    const creds = JSON.parse(data) as {
      installed?: { client_id?: unknown; client_secret?: unknown };
    };
    const src = creds.installed;
    if (
      typeof src?.client_id !== "string" ||
      !src.client_id ||
      typeof src.client_secret !== "string" ||
      !src.client_secret
    ) {
      return null;
    }
    return { clientId: src.client_id, clientSecret: src.client_secret };
  } catch {
    return null;
  }
}

// ── OAuth flow ───────────────────────────────────────────────

function statesMatch(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function startOAuthCallbackServer(
  port: number,
  expectedState: string,
): { ready: Promise<void>; code: Promise<string> } {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const code = new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (server.listening) server.close();
      callback();
    };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url!, `http://localhost:${port}`);
      if (u.pathname !== "/" && u.pathname !== "/oauth2callback") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const code = u.searchParams.get("code");
      const error = u.searchParams.get("error");
      const state = u.searchParams.get("state");

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

      if (!statesMatch(state, expectedState)) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorHtml("Invalid OAuth state. Please restart setup."));
        finish(() => reject(new Error("OAuth state validation failed")));
        return;
      }

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(errorHtml(escapeHtml(error)));
        finish(() => reject(new Error(`Authorization error: ${error}`)));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(successHtml);
        finish(() => resolve(code));
        return;
      }

      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Missing authorization code");
    });

    server.once("listening", resolveReady);

    server.on("error", (err: NodeJS.ErrnoException) => {
      const error =
        err.code === "EADDRINUSE"
          ? new Error(`Port ${port} is in use. Close other apps and retry.`)
          : err;
      rejectReady(error);
      finish(() => reject(error));
    });

    server.listen(port, "127.0.0.1");

    timer = setTimeout(() => {
      finish(() => reject(new Error("Authorization timeout (5 min). Try again.")));
    }, OAUTH_TIMEOUT_MS);
  });
  // The readiness promise is awaited first. Attach a handler immediately so a
  // listen error cannot become an unhandled rejection on the code promise.
  void code.catch(() => undefined);
  return { ready, code };
}

async function performOAuth(
  clientId: string,
  clientSecret: string,
  services: readonly WorkspaceServiceId[],
): Promise<{ refreshToken: string; redirectUri: string; scopes: string[] }> {
  const port = oauthPort();
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const state = randomBytes(32).toString("base64url");
  const { codeVerifier, codeChallenge } =
    await client.generateCodeVerifierAsync();
  const scopes = scopesForServices(services);

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent",
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });

  const s = clack.spinner();
  const callback = startOAuthCallbackServer(port, state);
  await callback.ready;

  try {
    await open(authUrl);
  } catch {
    clack.log.info(`Open this URL in your browser:\n${authUrl}`);
  }

  s.start("Waiting for browser authorization...");
  const code = await callback.code;
  s.message("Exchanging tokens...");

  const { tokens } = await client.getToken({ code, codeVerifier });

  if (!tokens.refresh_token) {
    s.stop("Failed.");
    throw new Error(
      "No refresh token. Go to https://myaccount.google.com/permissions, remove this app, and retry.",
    );
  }

  s.stop("Authorized!");
  const grantedScopes = tokens.scope?.split(/\s+/).filter(Boolean);
  return {
    refreshToken: tokens.refresh_token,
    redirectUri,
    scopes: grantedScopes?.length ? grantedScopes : scopes,
  };
}

// ── Config output ────────────────────────────────────────────

function getMcpConfigJson(
  name: string,
): string {
  const env: Record<string, string> = {
    GOOGLE_WORKSPACE_PROFILE: name,
    GOOGLE_WORKSPACE_SERVER_NAME: `google-workspace-${name}`,
  };
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
): string {
  const envParts = [
    `GOOGLE_WORKSPACE_PROFILE=${name}`,
    `GOOGLE_WORKSPACE_SERVER_NAME=google-workspace-${name}`,
  ];
  return `claude mcp add google-workspace-${name} -e ${envParts.join(" -e ")} -- npx -y ${PKG_NAME}`;
}

async function showAccountConfig(
  name: string,
): Promise<void> {
  const mcpJson = getMcpConfigJson(name);
  const claudeCmd = getClaudeCodeCmd(name);

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
}> {
  // Env vars take priority (silent)
  const envId = process.env.GOOGLE_CLIENT_ID;
  const envSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret };
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
      return creds;
    }
    clack.log.error("Could not parse a Desktop OAuth client JSON file.");
    bail("Invalid Desktop OAuth credentials file.");
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
  };
}

async function chooseServices(
  initialValues: readonly WorkspaceServiceId[] = WORKSPACE_SERVICE_IDS,
): Promise<WorkspaceServiceId[]> {
  const selected = await clack.multiselect({
    message: "Which Google Workspace services should this profile access?",
    options: WORKSPACE_SERVICE_IDS.map((value) => ({
      value,
      label: SERVICE_LABELS[value],
    })),
    initialValues: [...initialValues],
    required: true,
  });
  if (cancelled(selected)) return [];
  return selected as WorkspaceServiceId[];
}

async function revokeAccount(config: AppConfig): Promise<void> {
  if (!config.refreshToken) return;
  const client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    config.redirectUri,
  );
  await client.revokeToken(config.refreshToken);
}

// ── Main ─────────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
  oauthPort();
  clack.intro("Google Workspace MCP — Setup");

  // Account management loop
  while (true) {
    const accounts = listAccounts();

    const accountOptions: Array<{
      value: string;
      label: string;
      hint?: string;
    }> = accounts.map((name) => {
      const services = loadAccount(name)?.services ?? LEGACY_SERVICE_IDS;
      return {
        value: `account:${name}`,
        label: name,
        hint: services.join(", "),
      };
    });

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
        clack.log.info(
          `"${cleanName}" already exists. Select it and choose Re-authorize.`,
        );
        continue;
      }

      try {
        const services = await chooseServices();
        const { clientId, clientSecret } = await resolveCredentials();
        const authorization = await performOAuth(
          clientId,
          clientSecret,
          services,
        );

        saveAccount(cleanName, {
          clientId,
          clientSecret,
          redirectUri: authorization.redirectUri,
          refreshToken: authorization.refreshToken,
          services,
          scopes: authorization.scopes,
        });

        clack.log.success(`Account "${cleanName}" saved!`);
        await showAccountConfig(cleanName);
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
    if (!cfg) {
      clack.log.error(`Could not load account "${accountName}".`);
      continue;
    }

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

    if (action === "config") {
      const services = cfg.services ?? LEGACY_SERVICE_IDS;
      clack.note(
        services.map((service) => SERVICE_LABELS[service]).join("\n"),
        "Enabled services",
      );
      await showAccountConfig(accountName);
    }

    if (action === "reauth") {
      try {
        const services = await chooseServices(cfg.services ?? LEGACY_SERVICE_IDS);
        const authorization = await performOAuth(
          cfg.clientId,
          cfg.clientSecret,
          services,
        );
        saveAccount(accountName, {
          ...cfg,
          redirectUri: authorization.redirectUri,
          refreshToken: authorization.refreshToken,
          services,
          scopes: authorization.scopes,
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
        try {
          await revokeAccount(cfg);
          clack.log.success("Google OAuth grant revoked.");
        } catch (error: unknown) {
          clack.log.warning(
            `Could not revoke the Google token: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
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
}
