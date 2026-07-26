<div align="center">

# ADW Google MCP

**Google Workspace MCP Server**

`Drive` `Docs` `Sheets` `Calendar` `Gmail` `Slides` `People` `Chat`

**170 tools across 8 services** for AI assistants via the Model Context Protocol

---

</div>

## Getting Started

```bash
npx adw-google-mcp --setup
```

The interactive wizard guides you through account naming, service selection,
browser authorization, and a ready-to-paste MCP configuration. Your Google
OAuth credentials and refresh token stay on your machine.

---

## How It Works

```text
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  1. Run setup       npx adw-google-mcp --setup                   │
│  2. Name account    e.g. "work" or "personal"                    │
│  3. Choose access   select the Google services you need          │
│  4. Add OAuth       provide Desktop client credentials           │
│  5. Authorize       browser opens → approve access               │
│  6. Copy config     setup generates it and offers one-click copy │
│  7. Paste & go      add it to your AI client and restart         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

Run setup again at any time to **add another account**, **show its config**,
**change services**, **re-authorize**, or **delete the local profile**.

> New to Google OAuth? Start with [Google Cloud Setup](#google-cloud-setup).

---

## What Your Agent Can Do

| Service | Tools | Main capabilities |
|---|---:|---|
| **Drive** | 35 | Files and folders, uploads/downloads, sharing, comments, shared drives, access proposals, and approvals |
| **Docs** | 30 | Document tabs, Markdown, text formatting, images, page breaks, tables, and revision-guarded edits |
| **Sheets** | 35 | Values, sheets, native tables, smart chips, formatting, validation, protected ranges, and charts |
| **Calendar** | 18 | Events, recurrence, availability, scheduling suggestions, responses, Meet links, and labels |
| **Gmail** | 34 | Messages, threads, drafts, replies, attachments, labels, filters, history, send-as, and batches |
| **Slides** | 7 | Presentations, slides, thumbnails, creation, duplication, and batch updates |
| **People** | 5 | User profile, contacts, incremental sync, contact search, and Workspace directory search |
| **Chat** | 6 | Spaces, messages, threads, bounded in-space search, and message sending |

Verify the live inventory directly from the implementation:

```bash
npm run tools
```

### Google Docs highlights

Google Docs **document tabs** are fully supported. These are the tabs in the
Docs sidebar—not spreadsheet sheets. An agent can list the complete nested
hierarchy; create, rename, reorder, reparent, or delete tabs; and target reads,
text edits, images, page breaks, formatting, and table operations to one tab.

Table tools can discover and insert tables, replace cell text, add or delete
rows and columns, merge or unmerge cells, style cells, and pin header rows.
Writes can include a revision ID so a stale agent edit is rejected instead of
overwriting newer work.

<details>
<summary><b>Formatting code in a Google Doc</b></summary>

<br>

Use `format_code_block_in_document` to style existing paragraphs with a
monospace font, background color, indentation, and code-friendly spacing.

1. Call `read_document` or `read_document_as_markdown`.
2. Take the returned `tabId` and `revisionId`.
3. Choose a distinctive `findText` substring from the code.
4. Call `format_code_block_in_document` with those values.

Every matching paragraph in that tab is formatted in one atomic update, so use
a unique substring when only one block should change. The font, colors,
indentation, and spacing are customizable.

This is a visual approximation. The Google Docs API does not expose the
editor's native code-block building block. Fenced code used with
`create_document_from_markdown` is likewise imported as preformatted content.

</details>

<details>
<summary><b>Suggestions and restricted documents</b></summary>

<br>

Read operations can choose how suggested edits are rendered. Google Docs'
Developer Preview comment/suggestion mutation surface is not exposed as a
stable MCP tool; Drive comments remain available through the Drive service.

`read_restricted_document` is an unsupported, best-effort fallback for Google's
`mobilebasic` HTML page. Prefer `read_document` whenever the Docs API can access
the file.

</details>

---

## Google Cloud Setup

You need Node.js 22 or newer and a Google Cloud project with a **Desktop app**
OAuth client.

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create
   or select a project.
2. Enable the APIs for the services you plan to use: Drive, Docs, Sheets,
   Slides, Calendar, Gmail, People, and/or Chat.
3. Configure the OAuth consent screen for your Workspace or test users.
4. Create an OAuth client ID with application type **Desktop app**.
5. Download its JSON file, then run `npx adw-google-mcp --setup`.

Google Chat also needs a Chat app configured in the same Cloud project. Public
apps requesting sensitive or restricted scopes can require Google verification.

<details>
<summary><b>Ways to provide the Desktop OAuth client</b></summary>

<br>

The setup wizard accepts any of these:

- the downloaded Desktop OAuth JSON file;
- the client ID and client secret entered interactively; or
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set for the setup command.

```bash
GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." \
  npx adw-google-mcp --setup
```

The package contains no built-in Google credentials. The generated MCP client
configuration contains only the local profile name—not your client secret or
refresh token.

</details>

---

## Add It to Your AI Client

> **You do not need to write this by hand.** The setup wizard generates it and
> offers to copy it to your clipboard.

### Claude Desktop · Cursor · Air.dev · other stdio MCP clients

```json
{
  "mcpServers": {
    "google-workspace-work": {
      "command": "npx",
      "args": ["-y", "adw-google-mcp"],
      "env": {
        "GOOGLE_WORKSPACE_PROFILE": "work",
        "GOOGLE_WORKSPACE_SERVER_NAME": "google-workspace-work"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add google-workspace-work \
  -e GOOGLE_WORKSPACE_PROFILE=work \
  -e GOOGLE_WORKSPACE_SERVER_NAME=google-workspace-work \
  -- npx -y adw-google-mcp
```

---

## Multiple Accounts

Run setup once for each account:

```bash
npx adw-google-mcp --setup
```

```text
◆  No accounts yet
│  ● Add new account          → name it "work"

◆  1 account configured
│  ○ work
│  ● Add new account          → name it "personal"

◆  2 accounts configured
│  ○ work
│  ○ personal
│  ● Done
```

Each account has its own local profile and needs its own MCP server entry. Give
entries clear names such as `google-workspace-work` and
`google-workspace-personal` so your agent can select the intended account.

Profiles from older releases still expose Drive, Docs, Sheets, Calendar, and
Gmail. Choose **Re-authorize** in setup to add newer services. To guarantee that
previously granted scopes are removed, delete the profile—which attempts token
revocation—and create it again.

---

## Capability Controls

Select services during setup, then optionally narrow each MCP server further at
startup:

| Variable | Purpose |
|---|---|
| `GOOGLE_WORKSPACE_PROFILE` | Select `~/.config/google-drive-mcp/<profile>.json` |
| `GOOGLE_WORKSPACE_CONFIG` | Use an explicit configuration file instead |
| `GOOGLE_WORKSPACE_SERVER_NAME` | Set the server name shown to the MCP client |
| `GOOGLE_WORKSPACE_SERVICES` | Expose comma-separated service IDs or `all` |
| `GOOGLE_WORKSPACE_TOOL_MODE` | Choose `all`, `safe-write`, or `read-only` |
| `GOOGLE_OAUTH_PORT` | Change the setup callback port from the default `3000` |

- `all` exposes every tool for the selected services.
- `safe-write` hides destructive operations, raw batch updates, permission and
  approval mutations, and outbound actions such as email or Chat sending.
- `read-only` exposes only tools annotated as non-mutating.

These controls reduce the MCP surface; they do not remove OAuth grants already
issued to a profile. `GOOGLE_DRIVE_PROFILE`, `GOOGLE_DRIVE_CONFIG`, and
`GOOGLE_DRIVE_SERVER_NAME` remain available only as legacy aliases.

---

## Security

- You supply your own Google OAuth client; no OAuth secret is packaged or
  injected during publishing.
- Setup uses PKCE, random OAuth state, a loopback timeout, and scopes based on
  the services you select.
- Profiles are written atomically with `0600` file permissions and a `0700`
  directory on supported platforms.
- Deleting a profile attempts to revoke its refresh token before removing the
  local file.
- Every MCP call is validated against its JSON Schema, and tools advertise
  read-only, idempotent, and destructive annotations.
- Gmail and Chat content is marked as untrusted; oversized structured responses
  fail closed at 4 MiB.
- Releases use npm trusted publishing from GitHub Actions with OIDC and
  provenance—there is no long-lived npm publish token.

Revoke Google access at any time from
[Google Account permissions](https://myaccount.google.com/permissions).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Browser authorization was closed | Run `npx adw-google-mcp --setup` again and restart authorization |
| Authentication error or expired token | Run setup and choose **Re-authorize** |
| A newly selected service is unavailable | Re-authorize the profile so Google grants its scopes |
| Port 3000 is already in use | Set `GOOGLE_OAUTH_PORT` to another unused port from 1024 to 65535 |
| Google returned no refresh token | Remove the app from Google Account permissions, then authorize again |
| Server appears to hang when run directly | Normal for a stdio MCP server; use `--help` or `--version` for CLI output |

---

## Development and Publishing

```bash
npm ci
npm run build       # clean TypeScript build
npm test            # build and run automated tests
npm run check       # tests plus dependency audit
npm run tools       # generated service-by-service inventory
npm pack --dry-run  # inspect the package before release
```

The test suite covers tool contracts, validation, API request construction,
pagination, tab-aware Docs behavior, security-sensitive helpers, and packaging
invariants with mocks. It does not claim destructive live integration testing
against a real Google account.

Releases are tag-triggered through GitHub Actions and npm trusted publishing.
See
[PUBLISHING.md](https://github.com/Arkady-Dymkov/google-drive-mcp/blob/main/PUBLISHING.md)
for the release procedure.

---

<div align="center">

[AGPL-3.0-only](LICENSE) · [GitHub](https://github.com/Arkady-Dymkov/google-drive-mcp) · [npm](https://www.npmjs.com/package/adw-google-mcp)

</div>
