# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Google Drive MCP Server - A Model Context Protocol server that connects AI assistants (Claude Desktop, Air.dev, etc.) to Google Drive. Enables reading, creating, and managing Google Drive files through the MCP interface.

## Build Commands

```bash
npm install        # Install dependencies
npm run build      # Compile TypeScript to build/
npm run watch      # Watch mode compilation
npm run setup      # Interactive OAuth setup wizard
```

## Architecture

**Single-file MCP server** (`src/index.ts`):
- `GoogleDriveMCPServer` class handles all functionality
- Uses `@modelcontextprotocol/sdk` for MCP protocol implementation
- Communicates via stdio transport
- OAuth2 credentials stored at `~/.google-drive-mcp/config.json`

**Key dependencies**:
- `googleapis` - Google Drive, Docs, Sheets APIs
- `google-auth-library` - OAuth2 authentication
- `cheerio` + `turndown` - HTML parsing and Markdown conversion for restricted documents

## MCP Tools Provided

| Tool | Purpose |
|------|---------|
| `list_files` | List/browse files with pagination |
| `search_files` | Search using Drive query syntax |
| `read_file` | Read any file (auto-exports Google formats) |
| `read_document` | Read Google Docs with formatting |
| `read_restricted_document` | Read protected docs via mobilebasic endpoint |
| `read_spreadsheet` | Read Google Sheets data |
| `get_file_metadata` | Get detailed file info |
| `create_document` | Create new Google Docs |
| `create_folder` | Create folders |
| `upload_file` | Upload content to Drive |
| `append_text_to_document` | Append text to end of existing Google Doc |
| `replace_text_in_document` | Find and replace text in Google Doc |
| `format_text_in_document` | Apply formatting (bold, italic, color, etc.) to text |
| `insert_table_in_document` | Insert table at end of Google Doc |
| `update_paragraph_style_in_document` | Change alignment, spacing, or convert to list |
| `batch_update_document` | Execute multiple raw API operations atomically |

## TypeScript Configuration

- Target: ES2022, Module: Node16
- Strict mode enabled
- Source files: `src/`, Output: `build/`
