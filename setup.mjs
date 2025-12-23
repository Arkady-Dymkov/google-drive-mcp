#!/usr/bin/env node

import { google } from "googleapis";
import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
import * as readline from "readline";
import * as http from "http";
import { URL } from "url";
import open from "open";

const CONFIG_DIR = path.join(homedir(), ".google-drive-mcp");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

function printBanner() {
  console.clear();
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║                                                           ║");
  console.log("║         Google Drive MCP Server - Setup Wizard           ║");
  console.log("║                                                           ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  console.log("");
}

function waitForOAuthCallback(port = 3000) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, `http://localhost:${port}`);
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`
          <html>
            <head>
              <title>Authorization Failed</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                       padding: 60px; text-align: center; background: #f5f5f5; }
                .container { background: white; padding: 40px; border-radius: 8px;
                           box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto; }
                h1 { color: #d32f2f; margin-bottom: 20px; }
                p { color: #666; line-height: 1.6; }
              </style>
            </head>
            <body>
              <div class="container">
                <h1>❌ Authorization Failed</h1>
                <p>Error: ${error}</p>
                <p>Please close this window and try again.</p>
              </div>
            </body>
          </html>
        `);
        server.close();
        reject(new Error(`Authorization error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html>
            <head>
              <title>Authorization Successful</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                       padding: 60px; text-align: center; background: #f5f5f5; }
                .container { background: white; padding: 40px; border-radius: 8px;
                           box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto; }
                h1 { color: #4caf50; margin-bottom: 20px; }
                p { color: #666; line-height: 1.6; }
                .success { font-size: 48px; margin-bottom: 20px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="success">✅</div>
                <h1>Authorization Successful!</h1>
                <p>You have successfully authorized Google Drive access.</p>
                <p>You can close this window and return to the terminal.</p>
              </div>
            </body>
          </html>
        `);
        server.close();
        resolve(code);
      }
    });

    server.listen(port, () => {
      console.log(`\n✓ Local server started on port ${port}`);
      console.log("  Waiting for authorization...\n");
    });

    server.on("error", (err) => {
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

    // Timeout after 5 minutes
    setTimeout(
      () => {
        server.close();
        reject(
          new Error("Authorization timeout (5 minutes). Please try again."),
        );
      },
      5 * 60 * 1000,
    );
  });
}

async function extractCredentialsFromJson(jsonPath) {
  try {
    const data = fs.readFileSync(jsonPath, "utf-8");
    const credentials = JSON.parse(data);

    let clientId, clientSecret, redirectUris;

    if (credentials.installed) {
      clientId = credentials.installed.client_id;
      clientSecret = credentials.installed.client_secret;
      redirectUris = credentials.installed.redirect_uris;
    } else if (credentials.web) {
      clientId = credentials.web.client_id;
      clientSecret = credentials.web.client_secret;
      redirectUris = credentials.web.redirect_uris;
    } else {
      return null;
    }

    return { clientId, clientSecret, redirectUris };
  } catch (error) {
    return null;
  }
}

async function main() {
  printBanner();

  console.log("This wizard will help you set up Google Drive access.\n");
  console.log("Prerequisites:");
  console.log("  1. Google Cloud project created");
  console.log("  2. Drive, Docs, and Sheets APIs enabled");
  console.log(
    "  3. OAuth 2.0 credentials (Desktop app) created and downloaded\n",
  );

  const hasJson = await question(
    "Do you have a Google OAuth JSON file? (y/n): ",
  );

  let clientId, clientSecret, redirectUri;

  if (hasJson.toLowerCase() === "y") {
    const jsonPath = await question(
      "Enter the path to your JSON file (or drag & drop): ",
    );
    const cleanPath = jsonPath.trim().replace(/^['"]|['"]$/g, "");

    const creds = await extractCredentialsFromJson(cleanPath);

    if (creds) {
      clientId = creds.clientId;
      clientSecret = creds.clientSecret;
      redirectUri = "http://localhost:3000";

      console.log("\n✓ Successfully extracted credentials from JSON file");
      console.log(`  Client ID: ${clientId.substring(0, 20)}...`);
    } else {
      console.log(
        "\n✗ Could not parse JSON file. Please enter credentials manually.\n",
      );
      clientId = await question("Client ID: ");
      clientSecret = await question("Client Secret: ");
      redirectUri = "http://localhost:3000";
    }
  } else {
    console.log("\nPlease enter your OAuth 2.0 credentials:");
    clientId = await question("Client ID: ");
    clientSecret = await question("Client Secret: ");
    redirectUri = "http://localhost:3000";
  }

  // Create OAuth2 client
  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri,
  );

  // Generate auth URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
    prompt: "consent",
  });

  console.log(
    "\n╔═══════════════════════════════════════════════════════════╗",
  );
  console.log("║  STEP 2: Authorize Access                                ║");
  console.log(
    "╚═══════════════════════════════════════════════════════════╝\n",
  );
  console.log("Opening your browser for authorization...");
  console.log("If it doesn't open automatically, visit this URL:\n");
  console.log(authUrl);
  console.log("");

  // Try to open browser automatically
  try {
    await open(authUrl);
  } catch (error) {
    console.log(
      "Could not open browser automatically. Please copy the URL above.",
    );
  }

  try {
    const code = await waitForOAuthCallback(3000);

    console.log("✓ Authorization code received!");
    console.log("\n  Exchanging code for tokens...\n");

    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      console.log("\n✗ Error: No refresh token received.");
      console.log("  This can happen if you've already authorized this app.");
      console.log("  To fix this:");
      console.log("  1. Go to: https://myaccount.google.com/permissions");
      console.log("  2. Remove this app");
      console.log("  3. Run this setup again\n");
      rl.close();
      process.exit(1);
    }

    // Save configuration
    const config = {
      clientId,
      clientSecret,
      redirectUri,
      refreshToken: tokens.refresh_token,
    };

    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

    console.log(
      "╔═══════════════════════════════════════════════════════════╗",
    );
    console.log("║  ✓ Setup Complete!                                       ║");
    console.log(
      "╚═══════════════════════════════════════════════════════════╝\n",
    );
    console.log(`Configuration saved to: ${CONFIG_PATH}\n`);

    console.log("Next steps for Air.dev:");
    console.log(
      "─────────────────────────────────────────────────────────────",
    );
    console.log("Add this to your Air.dev MCP configuration:\n");
    console.log("{");
    console.log('  "mcpServers": {');
    console.log('    "google-drive": {');
    console.log('      "command": "node",');
    console.log(`      "args": ["${process.cwd()}/build/index.js"]`);
    console.log("    }");
    console.log("  }");
    console.log("}\n");
    console.log("Then restart Air.dev to start using Google Drive tools!\n");
  } catch (error) {
    console.log("\n✗ Error during authorization:", error.message);
    console.log("\nPlease try again.\n");
    rl.close();
    process.exit(1);
  }

  rl.close();
}

main().catch((error) => {
  console.error("\n✗ Fatal error:", error.message);
  rl.close();
  process.exit(1);
});
