import { google } from "googleapis";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as http from "http";
import { URL } from "url";
import open from "open";
import { getConfigPath, getConfigDir, saveConfig } from "./auth.js";
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

function question(
  rl: readline.Interface,
  query: string,
): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

function printBanner(profileName: string, configPath: string): void {
  console.clear();
  console.log("================================================");
  console.log("  Google Workspace MCP Server - Setup Wizard");
  console.log("================================================\n");
  if (profileName !== "default") {
    console.log(`Profile: ${profileName}`);
    console.log(`Config will be saved to: ${configPath}\n`);
  }
}

function waitForOAuthCallback(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url!, `http://localhost:${port}`);
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`
          <html><head><title>Authorization Failed</title>
          <style>body{font-family:system-ui;padding:60px;text-align:center;background:#f5f5f5}
          .c{background:#fff;padding:40px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);max-width:500px;margin:0 auto}
          h1{color:#d32f2f}p{color:#666}</style></head>
          <body><div class="c"><h1>Authorization Failed</h1>
          <p>Error: ${escapeHtml(error)}</p>
          <p>Please close this window and try again.</p></div></body></html>
        `);
        server.close();
        reject(new Error(`Authorization error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html><head><title>Authorization Successful</title>
          <style>body{font-family:system-ui;padding:60px;text-align:center;background:#f5f5f5}
          .c{background:#fff;padding:40px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);max-width:500px;margin:0 auto}
          h1{color:#4caf50}p{color:#666}</style></head>
          <body><div class="c"><h1>Authorization Successful!</h1>
          <p>You can close this window and return to the terminal.</p></div></body></html>
        `);
        server.close();
        resolve(code);
      }
    });

    server.listen(port, () => {
      console.log(`\nLocal server started on port ${port}`);
      console.log("  Waiting for authorization...\n");
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. Please close other applications using this port.`,
          ),
        );
      } else {
        reject(err);
      }
    });

    setTimeout(() => {
      server.close();
      reject(
        new Error("Authorization timeout (5 minutes). Please try again."),
      );
    }, OAUTH_TIMEOUT_MS);
  });
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
  } catch {
    // defaults.json doesn't exist or is invalid — that's fine
  }
  return null;
}

// ── Credential resolution ─────────────────────────────────
// Priority: 1) env vars  2) built-in defaults  3) existing config  4) JSON file  5) manual input

async function resolveCredentials(
  rl: readline.Interface,
  configPath: string,
): Promise<{ clientId: string; clientSecret: string }> {
  // 1) Environment variables
  const envClientId = process.env.GOOGLE_CLIENT_ID;
  const envClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (envClientId && envClientSecret) {
    console.log("Using credentials from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars.");
    console.log(`  Client ID: ${envClientId.substring(0, 20)}...\n`);
    return { clientId: envClientId, clientSecret: envClientSecret };
  }

  // 2) Built-in defaults (baked into the npm package by CI)
  const builtIn = loadBuiltInDefaults();
  if (builtIn) {
    console.log("Using built-in credentials.");
    console.log(`  Client ID: ${builtIn.clientId.substring(0, 20)}...\n`);
    return builtIn;
  }

  // 2) Existing config (re-authorization with same credentials)
  try {
    if (fs.existsSync(configPath)) {
      const existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (existing.clientId && existing.clientSecret) {
        const reuse = await question(
          rl,
          `Existing credentials found. Re-authorize with same credentials? (y/n): `,
        );
        if (reuse.toLowerCase() === "y") {
          console.log(`  Client ID: ${existing.clientId.substring(0, 20)}...\n`);
          return {
            clientId: existing.clientId,
            clientSecret: existing.clientSecret,
          };
        }
      }
    }
  } catch {
    // ignore parse errors
  }

  // 3) JSON file or manual input
  console.log("You need Google OAuth 2.0 credentials.");
  console.log("Options:");
  console.log("  a) Provide a downloaded OAuth JSON file");
  console.log("  b) Enter Client ID and Secret manually");
  console.log(
    "  c) Ask your admin for GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars\n",
  );

  const hasJson = await question(
    rl,
    "Do you have a Google OAuth JSON file? (y/n): ",
  );

  if (hasJson.toLowerCase() === "y") {
    const jsonPath = await question(
      rl,
      "Enter the path to your JSON file (or drag & drop): ",
    );
    const cleanPath = jsonPath.trim().replace(/^['"]|['"]$/g, "");
    const creds = extractCredentialsFromJson(cleanPath);

    if (creds) {
      console.log("\nSuccessfully extracted credentials from JSON file");
      console.log(`  Client ID: ${creds.clientId.substring(0, 20)}...`);
      return creds;
    }
    console.log(
      "\nCould not parse JSON file. Please enter credentials manually.\n",
    );
  }

  const clientId = await question(rl, "Client ID: ");
  const clientSecret = await question(rl, "Client Secret: ");
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

// ── Main setup flow ───────────────────────────────────────

export async function runSetup(): Promise<void> {
  const configPath = getConfigPath();
  const configDir = getConfigDir();
  const profileName = process.env.GOOGLE_DRIVE_PROFILE || "default";

  // Check if credentials are pre-configured (env vars or built-in defaults)
  const hasEnvCreds =
    (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) ||
    loadBuiltInDefaults() !== null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    printBanner(profileName, configPath);

    if (!hasEnvCreds) {
      console.log("This wizard will help you connect to Google Workspace.\n");
    }

    const { clientId, clientSecret } = await resolveCredentials(
      rl,
      configPath,
    );
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

    console.log("\n================================================");
    console.log("  Authorize Access");
    console.log("================================================\n");
    console.log("Opening your browser for authorization...");
    console.log("If it doesn't open automatically, visit this URL:\n");
    console.log(authUrl);
    console.log("");

    try {
      await open(authUrl);
    } catch {
      console.log(
        "Could not open browser automatically. Please copy the URL above.",
      );
    }

    const code = await waitForOAuthCallback(OAUTH_PORT);

    console.log("Authorization code received!");
    console.log("\n  Exchanging code for tokens...\n");

    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      console.log("\nError: No refresh token received.");
      console.log("  This can happen if you've already authorized this app.");
      console.log("  To fix this:");
      console.log("  1. Go to: https://myaccount.google.com/permissions");
      console.log("  2. Remove this app");
      console.log("  3. Run this setup again\n");
      process.exit(1);
    }

    const config: AppConfig = {
      clientId,
      clientSecret,
      redirectUri,
      refreshToken: tokens.refresh_token,
    };

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    saveConfig(configPath, config);

    console.log("================================================");
    console.log("  Setup Complete!");
    console.log("================================================\n");
    console.log(`Configuration saved to: ${configPath}\n`);
    console.log("Next steps - Add to your MCP client configuration:\n");

    // Build the MCP config example
    const mcpEnv: Record<string, string> = {};
    if (hasEnvCreds) {
      mcpEnv.GOOGLE_CLIENT_ID = clientId;
      mcpEnv.GOOGLE_CLIENT_SECRET = clientSecret;
    }

    if (profileName !== "default") {
      mcpEnv.GOOGLE_DRIVE_PROFILE = profileName;
      mcpEnv.GOOGLE_DRIVE_SERVER_NAME = `google-workspace-${profileName}`;
      console.log(`For profile "${profileName}":\n`);
      console.log(
        JSON.stringify(
          {
            mcpServers: {
              [`google-workspace-${profileName}`]: {
                command: "npx",
                args: ["-y", "adw-google-mcp"],
                ...(Object.keys(mcpEnv).length > 0
                  ? { env: mcpEnv }
                  : {}),
              },
            },
          },
          null,
          2,
        ),
      );
      console.log(
        "\nTip: Run setup with different GOOGLE_DRIVE_PROFILE values to add more accounts.\n",
      );
    } else {
      console.log(
        JSON.stringify(
          {
            mcpServers: {
              "google-workspace": {
                command: "npx",
                args: ["-y", "adw-google-mcp"],
                ...(Object.keys(mcpEnv).length > 0
                  ? { env: mcpEnv }
                  : {}),
              },
            },
          },
          null,
          2,
        ),
      );
      console.log(
        "\nTip: For multiple Google accounts, run setup with a profile:",
      );
      console.log("  GOOGLE_DRIVE_PROFILE=work npx adw-google-mcp --setup");
      console.log(
        "  GOOGLE_DRIVE_PROFILE=personal npx adw-google-mcp --setup\n",
      );
    }

    console.log(
      "Then restart your AI client to start using Google Workspace tools!\n",
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("\nError during setup:", message);
    console.error("Please try again.\n");
    process.exit(1);
  } finally {
    rl.close();
  }
}
