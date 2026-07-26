#!/usr/bin/env node

import { GoogleDriveMCPServer } from "./server.js";
import { runSetup } from "./setup.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

const args = process.argv.slice(2);

if (args.includes("--setup")) {
  runSetup().catch((error) => {
    console.error(
      "Fatal error:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
} else if (args.includes("--version") || args.includes("-v")) {
  console.log(packageJson.version);
} else if (args.includes("--help") || args.includes("-h")) {
  console.log(`adw-google-mcp — Google Workspace MCP Server

Usage:
  npx adw-google-mcp --setup    Set up accounts (add, manage, delete)
  npx adw-google-mcp            Start MCP server (used by AI clients)
  npx adw-google-mcp --version  Print the package version

The server communicates via MCP protocol over stdio.
It's meant to be started by an MCP client, not run directly.

Optional environment variables:
  GOOGLE_WORKSPACE_PROFILE      Select a configured account profile
  GOOGLE_WORKSPACE_SERVICES     Comma-separated services, or "all"
  GOOGLE_WORKSPACE_TOOL_MODE    all, safe-write, or read-only
  GOOGLE_OAUTH_PORT             Loopback port used only during setup

Add to your AI client config:
  {
    "mcpServers": {
      "google-workspace": {
        "command": "npx",
        "args": ["-y", "adw-google-mcp"],
        "env": { "GOOGLE_WORKSPACE_PROFILE": "<account-name>" }
      }
    }
  }

Or for Claude Code:
  claude mcp add google-workspace -e GOOGLE_WORKSPACE_PROFILE=<account-name> -- npx -y adw-google-mcp
`);
} else if (process.stdin.isTTY) {
  // Running interactively in a terminal — user probably meant --setup or --help
  console.log(`This is an MCP server — it communicates via stdio protocol, not interactively.

Run with --setup to configure accounts:
  npx adw-google-mcp --setup

Run with --help for usage info:
  npx adw-google-mcp --help
`);
} else {
  const server = new GoogleDriveMCPServer();
  server.run().catch(console.error);
}
