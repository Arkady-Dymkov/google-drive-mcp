# adw-google-mcp

Google Workspace MCP server for AI assistants. 85 tools across Drive, Docs, Sheets, Calendar, and Gmail.

Works with Claude Desktop, Claude Code, Air.dev, Cursor, and any MCP-compatible client.

<!-- TODO: Add hero screenshot showing the setup wizard or AI using tools -->
<!-- Screenshot: terminal showing `npx adw-google-mcp --setup` with the account menu -->

## Setup

### 1. Run the setup wizard

```bash
npx adw-google-mcp --setup
```

The wizard walks you through everything:
- Choose credentials (built-in or your own Google Cloud project)
- Name your account (e.g., "work", "personal")
- Authorize in your browser
- Get the exact config to paste into your AI client

<!-- TODO: Add screenshot of the setup wizard account menu -->
<!-- Screenshot: the clack-styled menu showing "Add new account" flow -->

### 2. Add to your AI client

The setup wizard prints the config for you. For example:

**Claude Code:**
```bash
claude mcp add google-workspace-work -e GOOGLE_DRIVE_PROFILE=work -- npx -y adw-google-mcp
```

**Claude Desktop / Air.dev / Cursor** (paste into MCP config):
```json
{
  "mcpServers": {
    "google-workspace-work": {
      "command": "npx",
      "args": ["-y", "adw-google-mcp"],
      "env": {
        "GOOGLE_DRIVE_PROFILE": "work",
        "GOOGLE_DRIVE_SERVER_NAME": "google-workspace-work"
      }
    }
  }
}
```

Config file locations:
- **Claude Desktop (macOS):** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Claude Desktop (Windows):** `%APPDATA%\Claude\claude_desktop_config.json`
- **Air.dev:** Settings > MCP Servers
- **Cursor:** Settings > MCP

### 3. Restart your AI client

You're ready. Try asking:
- "List my Google Drive files"
- "What's on my calendar this week?"
- "How many unread emails do I have?"
- "Create a spreadsheet with Q1 budget data"

---

## Multiple Accounts

Run the setup wizard again to add more accounts:

```bash
npx adw-google-mcp --setup
```

Select "Add new account", pick a name (e.g., "personal"), and authorize with a different Google account. Each account gets its own config entry.

<!-- TODO: Add screenshot of the account menu showing multiple accounts -->
<!-- Screenshot: the clack menu with "work" and "personal" listed + "Add new account" -->

---

## What Can It Do?

### Google Drive (11 tools)

| Tool | What it does |
|------|-------------|
| `list_files` | Browse files and folders with pagination |
| `search_files` | Search using Drive query syntax |
| `read_file` | Read any file (auto-exports Google formats to text) |
| `get_file_metadata` | Get detailed file info, permissions, sharing |
| `create_folder` | Create folders |
| `upload_file` | Upload content to Drive |
| `move_file` | Move files between folders |
| `trash_file` | Move files to trash |
| `rename_file` | Rename files or folders |
| `copy_file` | Duplicate files, optionally to a different folder |
| `share_file` | Share with users, groups, or via link |

### Google Docs (15 tools)

| Tool | What it does |
|------|-------------|
| `read_document` | Read document as plain text |
| `read_document_as_markdown` | Read with formatting preserved (headings, lists, tables, bold) |
| `read_restricted_document` | Read view-only/protected documents |
| `create_document` | Create new document with plain text |
| `create_document_from_markdown` | Create fully formatted document from Markdown |
| `insert_text` | Insert text at a specific position |
| `delete_range` | Delete content by position range |
| `append_text_to_document` | Append text to end |
| `replace_text_in_document` | Find and replace |
| `format_text_in_document` | Bold, italic, color, font size, underline |
| `update_paragraph_style_in_document` | Alignment, spacing, bullet lists |
| `insert_table_in_document` | Insert tables with optional headers |
| `insert_image` | Insert images from URL |
| `insert_page_break` | Insert page breaks |
| `batch_update_document` | Raw Google Docs API access for advanced operations |

### Google Sheets (21 tools)

| Tool | What it does |
|------|-------------|
| `read_spreadsheet` | Read cell values from sheets |
| `get_spreadsheet_info` | Get metadata: sheet names, IDs, dimensions |
| `write_cells` | Write values or formulas to any range |
| `append_rows` | Append data rows (auto-detects end of data) |
| `clear_cells` | Clear a range |
| `create_spreadsheet` | Create new spreadsheet with custom tabs |
| `add_sheet` / `delete_sheet` | Add or remove sheets |
| `rename_sheet` | Rename a sheet tab |
| `duplicate_sheet` | Copy a sheet within or between spreadsheets |
| `insert_rows_columns` / `delete_rows_columns` | Insert or delete rows/columns |
| `format_cells` | Bold, italic, colors, alignment, number format |
| `merge_cells` / `unmerge_cells` | Merge or unmerge cell ranges |
| `set_column_width` | Set column widths |
| `freeze_rows_columns` | Freeze header rows/columns |
| `sort_range` | Sort data by column |
| `find_replace_in_sheet` | Find and replace across sheets |
| `create_chart` | Bar, line, pie, column, area, scatter charts |
| `batch_update_spreadsheet` | Raw Sheets API for conditional formatting, data validation, etc. |

### Google Calendar (14 tools)

| Tool | What it does |
|------|-------------|
| `list_calendars` | List all calendars with IDs and access roles |
| `list_events` | List upcoming events (default: next 7 days) |
| `get_event` | Get full event details |
| `search_events` | Search events by text |
| `create_event` | Create events with attendees, Google Meet, recurrence, reminders |
| `update_event` | Update any event field |
| `delete_event` | Delete events |
| `quick_add_event` | Create from natural language ("Lunch tomorrow at noon") |
| `get_freebusy` | Check availability for scheduling |
| `respond_to_event` | Accept, decline, or tentatively respond |
| `list_recurring_instances` | List all occurrences of a recurring event |
| `move_event` | Move event to a different calendar |
| `create_calendar` | Create a new calendar |
| `delete_calendar` | Delete a secondary calendar |

### Gmail (24 tools)

| Tool | What it does |
|------|-------------|
| `get_profile` | Get your email address and message counts |
| `search_emails` | Search using Gmail query syntax |
| `read_email` | Read full email content and attachment info |
| `get_attachment` | Download email attachment content |
| `send_email` | Send email (to/cc/bcc, plain text or HTML) |
| `reply_to_email` | Reply within a thread (reply or reply-all) |
| `draft_email` | Create a draft for review |
| `send_draft` | Send an existing draft |
| `list_drafts` | List all drafts |
| `delete_draft` | Permanently delete a draft |
| `modify_email` | Add/remove labels (archive, star, mark read/unread) |
| `trash_email` | Move to trash |
| `list_threads` | List email conversations |
| `get_thread` | Get full conversation with all messages |
| `list_labels` | List all labels |
| `create_label` / `delete_label` / `update_label` | Manage labels |
| `get_label_counts` | Get unread/total counts for any label |
| `batch_modify_emails` | Bulk label changes |
| `batch_trash_emails` | Bulk trash |
| `create_filter` | Auto-organize incoming mail |
| `list_filters` / `delete_filter` | Manage auto-organization rules |

---

## For Admins: Distributing to Your Team

You create ONE Google Cloud project so your team doesn't need to.

### One-time setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/) > Create project
2. Enable APIs: **Drive, Docs, Sheets, Calendar, Gmail**
3. OAuth consent screen > User type: **External** > **Publish App**
4. Credentials > Create **OAuth client ID** (Desktop app type)
5. Copy Client ID and Client Secret

### Give your team this

```bash
GOOGLE_CLIENT_ID="YOUR_ID" GOOGLE_CLIENT_SECRET="YOUR_SECRET" npx adw-google-mcp --setup
```

They authorize in browser and they're connected. No Google Cloud project on their end.

> **Note:** Unverified apps support up to 100 users. Users see a "This app isn't verified" warning once — they click Advanced > Continue.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Authentication error" / "401 error" | Run `npx adw-google-mcp --setup`, re-authorize the account |
| "This app isn't verified" warning | Click "Advanced" > "Continue" (it's safe, it's your own app) |
| "Port 3000 already in use" | Close other apps using port 3000 and try again |
| "No refresh token received" | Go to https://myaccount.google.com/permissions, remove the app, run setup again |
| Server hangs when run directly | Normal! The server expects MCP protocol input. Use `--help` for usage info |

---

## Security

- **Credentials stay local** in `~/.config/google-drive-mcp/` on your machine
- **OAuth2 only** — no passwords are ever stored
- **No data sent to third parties** — the server talks directly to Google APIs
- **Revoke access anytime** at https://myaccount.google.com/permissions
- **Never share** your config files or OAuth JSON files

---

## Development

```bash
git clone https://github.com/Arkady-Dymkov/google-drive-mcp.git
cd google-drive-mcp
npm install
npm run build
node build/index.js --setup   # Local setup
```

### Project Structure

```
src/
  index.ts              Entry point (--setup / --help / server)
  server.ts             MCP server orchestration
  auth.ts               Config loading and OAuth client creation
  setup.ts              Interactive setup wizard (@clack/prompts)
  markdown.ts           Markdown <-> HTML / Google Docs JSON converters
  types.ts              Shared interfaces
  utils.ts              Validation and response helpers
  services/
    drive.ts            Google Drive (11 tools)
    docs.ts             Google Docs (15 tools)
    sheets.ts           Google Sheets (21 tools)
    calendar.ts         Google Calendar (14 tools)
    gmail.ts            Gmail (24 tools)
```

### Adding a new service

1. Create `src/services/yourservice.ts` implementing the `Service` interface
2. Add it to `this.services` array in `src/server.ts`
3. Add the OAuth scope to `OAUTH_SCOPES` in `src/setup.ts`

---

## License

MIT
