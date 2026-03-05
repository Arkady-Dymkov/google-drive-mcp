# CLAUDE.md

## Project Overview

Google Drive MCP Server - A Model Context Protocol server that connects AI assistants (Claude Desktop, Air.dev, etc.) to Google Drive, Docs, and Sheets. Supports multiple Google accounts via profiles.

Distributed via npm: users run `npx adw-google-mcp` (no cloning needed).

## Build Commands

```bash
npm install        # Install dependencies
npm run build      # Compile TypeScript to build/
npm run watch      # Watch mode compilation
npm run setup      # Interactive OAuth setup wizard (default profile)

# Multi-account setup
GOOGLE_DRIVE_PROFILE=work npm run setup
GOOGLE_DRIVE_PROFILE=personal npm run setup
```

## Architecture

**Modular service-based architecture** in `src/`:

| File | Purpose |
|------|---------|
| `index.ts` | CLI entry point, routes `--setup` flag |
| `server.ts` | MCP server orchestration, collects tools from all services |
| `auth.ts` | OAuth config loading/saving, auth client creation |
| `setup.ts` | Interactive OAuth setup wizard |
| `types.ts` | Shared interfaces (`Service`, `ToolDefinition`, `AppConfig`) |
| `utils.ts` | Validation helpers, error formatting, response builders |
| `markdown.ts` | Markdown <-> HTML and Markdown <-> Google Docs JSON converters (zero deps) |
| `services/drive.ts` | Drive file operations (7 tools: list, search, read, upload, move, etc.) |
| `services/docs.ts` | Google Docs operations (15 tools: read/write markdown, format, tables, images, etc.) |
| `services/sheets.ts` | Google Sheets operations (18 tools: read/write, format, charts, sort, etc.) |

**Adding a new service** (e.g., Gmail):
1. Create `src/services/gmail.ts` implementing the `Service` interface
2. Register it in `server.ts` constructor's `this.services` array

**Multi-account support via environment variables:**
- `GOOGLE_DRIVE_PROFILE` - Profile name (e.g., `work` -> `~/.config/google-drive-mcp/work.json`)
- `GOOGLE_DRIVE_CONFIG` - Full custom config path (overrides profile)
- `GOOGLE_DRIVE_SERVER_NAME` - Custom server name for AI to distinguish accounts

**Key dependencies**:
- `googleapis` - Google Drive, Docs, Sheets APIs
- `google-auth-library` - OAuth2 authentication
- `cheerio` + `turndown` - HTML parsing and Markdown conversion for restricted documents
- `@modelcontextprotocol/sdk` - MCP protocol implementation

## Tool Count

- **Drive**: 7 tools (list, search, read, metadata, create folder, upload, move)
- **Docs**: 15 tools (read plain/markdown/restricted, create plain/markdown, insert text/image/page break/table, delete range, replace, format, paragraph style, batch update)
- **Sheets**: 18 tools (read, write, append, clear, create, add/delete sheet, insert/delete rows/cols, format, merge, column width, freeze, sort, find/replace, charts, batch update)
- **Total**: 40 tools

## TypeScript Configuration

- Target: ES2022, Module: Node16
- Strict mode enabled
- Source files: `src/`, Output: `build/`
