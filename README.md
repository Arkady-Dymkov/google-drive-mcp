<div align="center">

# ADW Google MCP

**Google Workspace MCP Server**

`Drive` `Docs` `Sheets` `Calendar` `Gmail`

85 tools for AI assistants via Model Context Protocol

<!-- TODO: Screenshot — terminal showing the setup wizard with clack UI -->

---

</div>

## Getting Started

```bash
npx adw-google-mcp --setup
```

The interactive wizard handles everything — credentials, authorization, and configuration.

<!-- TODO: Screenshot — the full setup flow: credential choice → account name → "Authorized!" → config output -->

---

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   1. Run setup       npx adw-google-mcp --setup         │
│   2. Name account    e.g. "work", "personal"            │
│   3. Authorize       browser opens → click Allow        │
│   4. Copy config     setup prints it, one click copy    │
│   5. Paste & go      add to your AI client, restart     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

After setup, the wizard shows your config and offers to **copy it to clipboard**.

Run setup again anytime to **add more accounts**, **view configs**, or **delete accounts**.

---

## Credentials

<details>
<summary><b>Option A — Built-in credentials</b> (simplest, for teams)</summary>

<br>

If your admin published this package with credentials baked in, you don't need anything. Just run setup, authorize, done.

```bash
npx adw-google-mcp --setup
# Select "Use built-in credentials (recommended)"
```

</details>

<details>
<summary><b>Option B — Credentials via environment variables</b> (for distribution)</summary>

<br>

Your admin gives you a Client ID and Secret. Set them as env vars:

```bash
GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." npx adw-google-mcp --setup
```

Or add them to your MCP config `env` block — the setup wizard detects them automatically.

</details>

<details>
<summary><b>Option C — Your own Google Cloud project</b> (full control)</summary>

<br>

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → Create project
2. Enable APIs: **Drive, Docs, Sheets, Calendar, Gmail**
3. OAuth consent screen → User type: **External** → **Publish App**
4. Credentials → Create **OAuth client ID** (Desktop app)
5. Download the JSON file

```bash
npx adw-google-mcp --setup
# Select "Use my own Google Cloud project"
# Provide the JSON file or enter Client ID & Secret
```

</details>

---

## Configuration

### Claude Code

```bash
claude mcp add google-workspace-work \
  -e GOOGLE_DRIVE_PROFILE=work \
  -e GOOGLE_DRIVE_SERVER_NAME=google-workspace-work \
  -- npx -y adw-google-mcp
```

### Claude Desktop · Air.dev · Cursor

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

> **You don't need to write this by hand.** The setup wizard generates it and lets you copy to clipboard.

<details>
<summary>Config file locations</summary>

<br>

| Client | Path |
|--------|------|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Air.dev | Settings → MCP Servers |
| Cursor | Settings → MCP |

</details>

---

## Multiple Accounts

Run setup once per account:

```bash
npx adw-google-mcp --setup
```

```
◆  No accounts yet. Let's add one:
│  ● Add new account          →  name it "work"

◆  1 account(s) configured
│  ○ work (configured)
│  ──────────────────────────
│  ● Add new account          →  name it "personal"

◆  2 account(s) configured
│  ○ work (configured)
│  ○ personal (configured)
│  ──────────────────────────
│  ○ Add new account
│  ● Done
```

Each account gets its own config. The AI sees both and picks the right one based on context.

---

## Managing Accounts

```bash
npx adw-google-mcp --setup
```

Select any existing account to:
- **Show configuration** — view and copy the MCP config
- **Re-authorize** — run the OAuth flow again (for expired tokens)
- **Delete** — remove the account

---

## Tools

### Drive — 11 tools

| | |
|---|---|
| `list_files` | Browse files and folders |
| `search_files` | Search with Drive query syntax |
| `read_file` | Read any file content |
| `get_file_metadata` | Detailed file info and permissions |
| `create_folder` | Create folders |
| `upload_file` | Upload content |
| `move_file` | Move between folders |
| `trash_file` | Move to trash |
| `rename_file` | Rename files or folders |
| `copy_file` | Duplicate files |
| `share_file` | Share with users or via link |

### Docs — 15 tools

| | |
|---|---|
| `read_document` | Read as plain text |
| `read_document_as_markdown` | Read preserving formatting |
| `read_restricted_document` | Read view-only documents |
| `create_document` | Create with plain text |
| `create_document_from_markdown` | Create with full formatting from Markdown |
| `insert_text` · `delete_range` | Edit at specific positions |
| `append_text_to_document` | Append to end |
| `replace_text_in_document` | Find and replace |
| `format_text_in_document` | Bold, italic, color, size |
| `update_paragraph_style_in_document` | Alignment, spacing, lists |
| `insert_table_in_document` | Tables with headers |
| `insert_image` · `insert_page_break` | Images and page breaks |
| `batch_update_document` | Raw Docs API access |

### Sheets — 21 tools

| | |
|---|---|
| `read_spreadsheet` · `get_spreadsheet_info` | Read data and metadata |
| `write_cells` · `append_rows` · `clear_cells` | Write, append, clear |
| `create_spreadsheet` | Create with custom tabs |
| `add_sheet` · `delete_sheet` · `rename_sheet` · `duplicate_sheet` | Manage tabs |
| `insert_rows_columns` · `delete_rows_columns` | Structural edits |
| `format_cells` | Bold, colors, alignment, number format |
| `merge_cells` · `unmerge_cells` | Merge and unmerge |
| `set_column_width` · `freeze_rows_columns` | Layout |
| `sort_range` · `find_replace_in_sheet` | Data operations |
| `create_chart` | Bar, line, pie, column, area, scatter |
| `batch_update_spreadsheet` | Raw Sheets API access |

### Calendar — 14 tools

| | |
|---|---|
| `list_calendars` | All calendars with IDs |
| `list_events` · `get_event` · `search_events` | Find events |
| `create_event` | With attendees, Meet, recurrence, reminders |
| `quick_add_event` | From natural language |
| `update_event` · `delete_event` | Modify or remove |
| `respond_to_event` | Accept, decline, tentative |
| `get_freebusy` | Check availability |
| `list_recurring_instances` | Expand recurring events |
| `move_event` | Move between calendars |
| `create_calendar` · `delete_calendar` | Manage calendars |

### Gmail — 24 tools

| | |
|---|---|
| `get_profile` · `get_label_counts` | Account info and unread counts |
| `search_emails` · `read_email` · `get_attachment` | Find and read |
| `send_email` · `reply_to_email` | Send and reply (text or HTML) |
| `draft_email` · `send_draft` · `list_drafts` · `delete_draft` | Draft management |
| `modify_email` · `trash_email` | Labels, archive, star, read/unread |
| `list_threads` · `get_thread` | Conversations |
| `list_labels` · `create_label` · `delete_label` · `update_label` | Label management |
| `batch_modify_emails` · `batch_trash_emails` | Bulk operations |
| `create_filter` · `list_filters` · `delete_filter` | Auto-organization |

---

## For Admins

<details>
<summary><b>Distributing to your team (so they skip Google Cloud setup)</b></summary>

<br>

**One-time:** Create a Google Cloud project, enable the 5 APIs, create OAuth credentials, publish the app.

**Option 1 — Bake credentials into the npm package:**

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `NPM_TOKEN` as GitHub repository secrets. Tag a release — CI injects credentials and publishes.

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Customers just run `npx adw-google-mcp --setup` — zero config.

See [PUBLISHING.md](PUBLISHING.md) for full details.

**Option 2 — Distribute env vars:**

Give customers this command:
```bash
GOOGLE_CLIENT_ID="your-id" GOOGLE_CLIENT_SECRET="your-secret" npx adw-google-mcp --setup
```

> **Note:** Unverified apps support up to 100 users. Users see a one-time "app isn't verified" warning.

</details>

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Authentication error / 401 | Run `npx adw-google-mcp --setup`, re-authorize |
| "This app isn't verified" | Click Advanced → Continue (safe, it's your app) |
| Port 3000 in use | Close other apps on port 3000 |
| No refresh token | [Remove app](https://myaccount.google.com/permissions), run setup again |
| Server hangs when run directly | Normal — use `--help` for usage info |

---

## Security

- Credentials stored locally in `~/.config/google-drive-mcp/` with `0600` permissions
- OAuth2 only — no passwords stored
- Direct Google API calls — no third-party data relay
- Config files are never published to npm
- Revoke access anytime at [myaccount.google.com/permissions](https://myaccount.google.com/permissions)

---

## Development

```bash
git clone https://github.com/Arkady-Dymkov/google-drive-mcp.git
cd google-drive-mcp
npm install && npm run build
node build/index.js --setup
```

```
src/
├── index.ts              CLI entry point
├── server.ts             MCP server orchestration
├── auth.ts               OAuth config management
├── setup.ts              Interactive wizard (@clack/prompts)
├── markdown.ts           Markdown ↔ HTML ↔ Docs JSON
├── types.ts              Shared interfaces
├── utils.ts              Validation helpers
└── services/
    ├── drive.ts           11 tools
    ├── docs.ts            15 tools
    ├── sheets.ts          21 tools
    ├── calendar.ts        14 tools
    └── gmail.ts           24 tools
```

Adding a service: implement `Service` interface → register in `server.ts` → add OAuth scope in `setup.ts`.

---

<div align="center">

MIT License

</div>
