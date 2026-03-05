# Google Workspace MCP Server

Connect AI assistants (Claude Desktop, Air.dev, etc.) to Google Drive, Docs, Sheets, Calendar, and Gmail via the Model Context Protocol. 67 tools. Supports multiple Google accounts.

## Quick Setup

### 1. Authorize your Google account

```bash
npx adw-google-mcp --setup
```

Your browser opens. Click "Allow". Done.

If credentials aren't built into the package, your admin can provide them via env vars:
```bash
GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." npx adw-google-mcp --setup
```

### 2. Add to your AI client

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "adw-google-mcp"]
    }
  }
}
```

**Config file locations:**
- **Air.dev:** Settings > MCP Servers
- **Claude Desktop:** `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)

Restart your AI client and you're ready.

---

## Admin Setup (one-time, for the person distributing to customers)

You create ONE Google Cloud project. Your customers use your credentials — they don't need their own project.

### 1. Create Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable these APIs: **Drive, Docs, Sheets, Calendar, Gmail**
4. Go to "APIs & Services" > "OAuth consent screen"
   - User type: **External**
   - Fill in app name and email
   - Add scopes: `drive`, `documents`, `spreadsheets`, `calendar`, `gmail.modify`, `gmail.send`
   - Add your test users (up to 100 users in testing mode)
   - **Publish the app** (click "Publish App" — unverified is fine, users click through a warning once)
5. Go to "Credentials" > Create **OAuth client ID** (Desktop app type)
6. Copy the **Client ID** and **Client Secret**

### 2. Distribute to your customers

Give each customer this config snippet (with your credentials filled in):

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "adw-google-mcp"],
      "env": {
        "GOOGLE_CLIENT_ID": "YOUR_CLIENT_ID.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "GOCSPX-YOUR_SECRET"
      }
    }
  }
}
```

Then tell them to run:
```bash
GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." npx adw-google-mcp --setup
```

They authorize in their browser and they're connected. No Google Cloud project needed on their end.

---

## Self-hosted Setup (DIY)

If you prefer to use your own Google Cloud project instead of someone else's credentials:

```bash
npx adw-google-mcp --setup
```

The wizard will prompt for your OAuth JSON file or Client ID/Secret manually.

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
| `get_spreadsheet_info` | Get spreadsheet metadata: sheets list, IDs, row/column counts |
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

### Google Sheets
| Tool | Description |
|------|-------------|
| `read_spreadsheet` | Read data from sheets with cell values |
| `get_spreadsheet_info` | Get metadata: sheet names, IDs, dimensions |
| `write_cells` | Write values/formulas to any range |
| `append_rows` | Append rows after existing data (auto-detects end) |
| `clear_cells` | Clear values in a range |
| `create_spreadsheet` | Create new spreadsheet with custom tabs |
| `add_sheet` / `delete_sheet` | Add or remove sheets (tabs) |
| `insert_rows_columns` / `delete_rows_columns` | Insert or delete rows/columns |
| `format_cells` | Bold, italic, colors, alignment, number format, wrap |
| `merge_cells` | Merge cell ranges |
| `set_column_width` | Set column widths in pixels |
| `freeze_rows_columns` | Freeze header rows/columns |
| `sort_range` | Sort data by column |
| `find_replace_in_sheet` | Find and replace text across sheets |
| `create_chart` | Create bar, line, pie, column, area, scatter charts |
| `batch_update_spreadsheet` | Execute raw Sheets API operations (conditional formatting, data validation, etc.) |

### Google Calendar
| Tool | Description |
|------|-------------|
| `list_calendars` | List all calendars with IDs and access roles |
| `list_events` | List events in a time range (default: next 7 days) |
| `get_event` | Get full event details by ID |
| `search_events` | Search events by text across title, description, location |
| `create_event` | Create events with attendees, Google Meet, recurrence, reminders, colors |
| `update_event` | Update any event fields (partial update) |
| `delete_event` | Delete events with optional attendee notification |
| `quick_add_event` | Create event from natural language ("Lunch with Bob tomorrow at noon") |
| `get_freebusy` | Check availability across calendars for scheduling |
| `respond_to_event` | Accept, decline, or tentatively respond to invitations |
| `list_recurring_instances` | List all occurrences of a recurring event |
| `move_event` | Move event to a different calendar |

### Gmail
| Tool | Description |
|------|-------------|
| `search_emails` | Search emails using Gmail query syntax |
| `read_email` | Read full email content, headers, and attachment info |
| `send_email` | Send email with to/cc/bcc, plain text or HTML |
| `reply_to_email` | Reply within a thread (reply or reply-all) |
| `draft_email` | Create email draft for review before sending |
| `send_draft` | Send an existing draft |
| `modify_email` | Add/remove labels (archive, mark read/unread, star, etc.) |
| `trash_email` | Move email to trash |
| `list_threads` | List email threads/conversations |
| `get_thread` | Get full thread with all messages |
| `list_labels` | List all Gmail labels (system and user) |
| `create_label` / `delete_label` | Create or delete labels |
| `batch_modify_emails` | Modify labels on multiple emails at once |
| `batch_trash_emails` | Trash multiple emails at once |

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
