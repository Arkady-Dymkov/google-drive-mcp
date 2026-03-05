# CLAUDE.md

## Project Overview

Google Workspace MCP Server (`adw-google-mcp`) — connects AI assistants to Google Drive, Docs, Sheets, Calendar, and Gmail via the Model Context Protocol. 85 tools. Supports multiple Google accounts via profiles.

Distributed via npm: `npx adw-google-mcp --setup` to configure, `npx -y adw-google-mcp` to run.

## Build Commands

```bash
npm install        # Install dependencies
npm run build      # Compile TypeScript to build/
npm run watch      # Watch mode compilation
npm run setup      # Interactive account setup wizard
```

## Architecture

**Modular service-based architecture** in `src/`:

| File | Purpose |
|------|---------|
| `index.ts` | CLI entry point (--setup / --help / server with TTY detection) |
| `server.ts` | MCP server, collects tools from all services via Service interface |
| `auth.ts` | Config path resolution, OAuth client creation |
| `setup.ts` | Interactive setup wizard with @clack/prompts (account CRUD) |
| `markdown.ts` | Markdown <-> HTML and Markdown <-> Google Docs JSON (zero deps) |
| `types.ts` | Shared interfaces: Service, ToolDefinition, AppConfig |
| `utils.ts` | Input validation, error formatting, response builders |
| `services/drive.ts` | Google Drive (11 tools) |
| `services/docs.ts` | Google Docs (15 tools) |
| `services/sheets.ts` | Google Sheets (21 tools) |
| `services/calendar.ts` | Google Calendar (14 tools) |
| `services/gmail.ts` | Gmail (24 tools) |

**Adding a new service:**
1. Create `src/services/foo.ts` implementing the `Service` interface
2. Register it in `server.ts` constructor's `this.services` array
3. Add OAuth scope to `OAUTH_SCOPES` in `setup.ts`

**Multi-account:** `GOOGLE_DRIVE_PROFILE` env var selects `~/.config/google-drive-mcp/{name}.json`

**Key dependencies:** googleapis, google-auth-library, @modelcontextprotocol/sdk, cheerio + turndown (restricted docs), @clack/prompts (setup UI)

## Publishing

Tag-triggered via GitHub Actions. See PUBLISHING.md for details.
```bash
git tag v1.0.0 && git push origin v1.0.0  # CI builds + injects OAuth defaults + publishes
```

## TypeScript

Target: ES2022, Module: Node16, Strict mode. Source: `src/`, Output: `build/`
