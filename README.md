# Google Drive MCP Server

Connect AI assistants (Claude Desktop, Air.dev, etc.) to your Google Drive via the Model Context Protocol. Supports multiple Google accounts.

## Quick Setup

### 1. Get Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable these APIs: Google Drive API, Google Docs API, Google Sheets API
4. Go to "APIs & Services" > "Credentials"
5. Configure OAuth consent screen (User type: "External", add your email as test user)
6. Create OAuth client ID (Type: "Desktop app") and download the JSON file

### 2. Run Setup

```bash
npx adw-google-mcp --setup
```

Answer "y" when asked about JSON file, drag & drop it, authorize in browser. Done.

### 3. Configure Your AI Client

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "google-drive": {
      "command": "npx",
      "args": ["-y", "adw-google-mcp"]
    }
  }
}
```

**Config file locations:**
- **Air.dev:** Settings > MCP Servers
- **Claude Desktop:** `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)

### 4. Restart & Test

Restart your AI client and ask:
- "List my Google Drive files"
- "Read the document called [name]"
- "Search for files with [keyword]"

---

## Multiple Google Accounts

```bash
GOOGLE_DRIVE_PROFILE=work npx adw-google-mcp --setup
GOOGLE_DRIVE_PROFILE=personal npx adw-google-mcp --setup
```

```json
{
  "mcpServers": {
    "google-drive-work": {
      "command": "npx",
      "args": ["-y", "adw-google-mcp"],
      "env": {
        "GOOGLE_DRIVE_PROFILE": "work",
        "GOOGLE_DRIVE_SERVER_NAME": "google-drive-work"
      }
    },
    "google-drive-personal": {
      "command": "npx",
      "args": ["-y", "adw-google-mcp"],
      "env": {
        "GOOGLE_DRIVE_PROFILE": "personal",
        "GOOGLE_DRIVE_SERVER_NAME": "google-drive-personal"
      }
    }
  }
}
```

Each profile stores credentials separately in `~/.config/google-drive-mcp/`.

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `GOOGLE_DRIVE_PROFILE` | Profile name | `work`, `personal` |
| `GOOGLE_DRIVE_CONFIG` | Full custom config path (overrides profile) | `/path/to/config.json` |
| `GOOGLE_DRIVE_SERVER_NAME` | Server name visible to AI | `google-drive-work` |

---

## Available Tools

### Reading Files
| Tool | Description |
|------|-------------|
| `list_files` | List files and folders with pagination |
| `search_files` | Search using Drive query syntax |
| `read_file` | Read any file (auto-exports Google formats) |
| `read_document` | Read Google Docs as plain text |
| `read_document_as_markdown` | Read Google Docs as Markdown (preserves formatting, headings, lists, tables) |
| `read_restricted_document` | Read protected/view-only docs via mobilebasic endpoint |
| `read_spreadsheet` | Read Google Sheets data |
| `get_file_metadata` | Get detailed file information |

### Creating & Managing Files
| Tool | Description |
|------|-------------|
| `create_document` | Create new Google Docs with plain text |
| `create_document_from_markdown` | Create formatted Google Docs from Markdown (headings, bold, italic, links, tables, lists, code blocks, images) |
| `create_folder` | Create new folders |
| `upload_file` | Upload files to Drive |
| `move_file` | Move files/folders |

### Editing Google Docs
| Tool | Description |
|------|-------------|
| `insert_text` | Insert text at a specific index position |
| `delete_range` | Delete content between two index positions |
| `append_text_to_document` | Append text to end of document |
| `replace_text_in_document` | Find and replace text |
| `format_text_in_document` | Apply formatting (bold, italic, color, etc.) |
| `insert_table_in_document` | Insert table at end of document |
| `insert_image` | Insert image from URL at a position |
| `insert_page_break` | Insert page break at a position |
| `update_paragraph_style_in_document` | Change alignment, spacing, or lists |
| `batch_update_document` | Execute multiple raw API operations atomically |

---

## Development

```bash
git clone <repo-url>
cd drive-mcp
npm install
npm run build
npm run setup   # Interactive OAuth setup
```

### Project Structure

```
src/
  index.ts              Entry point (--setup flag routing)
  server.ts             MCP server orchestration
  auth.ts               OAuth config management
  setup.ts              Interactive setup wizard
  types.ts              Shared types
  utils.ts              Validation and helpers
  services/
    drive.ts            Drive file operations
    docs.ts             Google Docs operations
    sheets.ts           Google Sheets operations
```

Adding a new Google service (e.g., Gmail): create `src/services/gmail.ts` implementing the `Service` interface, then register it in `server.ts`.

---

## Troubleshooting

**"Authentication error" or "401 error"** - Run `npx adw-google-mcp --setup` again.

**"This app isn't verified" warning** - Click "Advanced" > "Continue" (it's your own app).

**Port 3000 already in use** - Close apps using port 3000 and try again.

---

## Security

- Credentials stay on your machine in `~/.config/google-drive-mcp/`
- OAuth2 authentication (no passwords stored)
- Revoke access anytime at https://myaccount.google.com/permissions
- Never share OAuth JSON files or config files between users
