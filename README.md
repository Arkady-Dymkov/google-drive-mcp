# ADW Google MCP

Google Workspace MCP server for AI assistants. It connects one or more Google
accounts to Drive, Docs, Sheets, Calendar, Gmail, Slides, People, and Chat over
the Model Context Protocol (MCP).

## Google Docs Document tabs

Document tabs are a first-class part of the Docs integration. These are the
tabs in the Google Docs sidebar—not spreadsheet sheets.

- `list_document_tabs` returns the complete nested hierarchy with tab IDs,
  titles, parents, depth, and position.
- `create_document_tab`, `update_document_tab`, and `delete_document_tab`
  create root or nested tabs, rename/reorder/reparent them, set an icon, and
  remove a tab hierarchy. Deletion requires explicit confirmation.
- `read_document` and `read_document_as_markdown` can read one tab or all tabs.
- Text, image, page-break, formatting, and paragraph operations accept a
  `tabId` where relevant.
- Table operations are tab-aware: discover and insert tables, replace cell
  text, add/delete rows or columns, merge/unmerge cells, style cells, and pin
  header rows.
- Writes support an optional revision ID so callers can reject edits based on a
  stale document snapshot.

Read operations can choose how suggested edits are rendered. Google Docs'
Developer Preview comment/suggestion mutation surface is intentionally not
exposed as stable MCP tools yet; Drive comments remain available through the
Drive tools.

## Supported services

| Service | Main capabilities |
|---|---|
| Drive | Files and folders, uploads/downloads, metadata, permissions, comments, shared drives, access proposals, approvals, and long-running downloads |
| Docs | Document tabs, plain-text/Markdown reads, document creation, formatting, images, page breaks, tables, and batch updates |
| Sheets | Values and batch values, sheet structure, native tables, smart chips, formatting, protected ranges, validation, conditional formatting, charts, and batch updates |
| Calendar | Calendars, events, recurrence, free/busy, scheduling suggestions, responses, Meet links, and calendar labels/colors |
| Gmail | Messages, threads, drafts, replies/forwarding, attachments, labels, filters, history, send-as identities, and batch operations |
| Slides | Presentations, slides, thumbnails, creation, duplication, and batch updates |
| People | User profile, contacts, incremental contact sync, contact search, and Workspace directory search |
| Chat | Spaces, messages, bounded in-space text search, threads, and sending messages |

The tool inventory is generated from the source instead of maintained as a
hard-coded count:

```bash
npm run tools
```

## Requirements

- Node.js 22 or newer
- A Google Cloud project
- A Desktop OAuth client belonging to that project
- The Google APIs required by the services you select

Enable Drive, Docs, Sheets, Slides, Calendar, Gmail, People, and/or Chat in the
Google Cloud project. Configure the OAuth consent screen and test users or app
publication as appropriate for your Workspace. Google Chat also requires a
Chat app configured in the same project.

## Setup

Run the interactive account wizard:

```bash
npx adw-google-mcp --setup
```

The wizard asks which services the profile may access, requests only those
OAuth scopes, opens a PKCE-protected browser authorization flow, and prints an
MCP client configuration. Provide either:

- the downloaded JSON for your own Desktop OAuth client;
- the client ID and secret interactively; or
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` while running setup.

There are no embedded or built-in Google credentials. The generated MCP client
configuration contains only a local profile name, not the client secret or
refresh token.

Profiles created by older releases continue to expose Drive, Docs, Sheets,
Calendar, and Gmail. Select **Re-authorize** in setup to choose additional
services and grant their scopes. To guarantee removal of scopes granted by an
older profile, delete the profile (which attempts token revocation) and create
it again; Google can retain earlier grants during re-authorization.

### MCP client configuration

The setup wizard can copy this configuration for Claude Desktop, Cursor,
Air.dev, and other stdio MCP clients:

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

For Claude Code:

```bash
claude mcp add google-workspace-work \
  -e GOOGLE_WORKSPACE_PROFILE=work \
  -e GOOGLE_WORKSPACE_SERVER_NAME=google-workspace-work \
  -- npx -y adw-google-mcp
```

Run setup again to add another profile, show its client configuration,
re-authorize it, or delete it. Each account is a separate MCP server entry and
local configuration file.

## Capability controls

The profile's selected services are the default. Startup environment variables
can narrow the exposed capability set without editing the profile:

| Variable | Purpose |
|---|---|
| `GOOGLE_WORKSPACE_PROFILE` | Select `~/.config/google-drive-mcp/<profile>.json` |
| `GOOGLE_WORKSPACE_CONFIG` | Use an explicit configuration file instead |
| `GOOGLE_WORKSPACE_SERVER_NAME` | Set the MCP server name shown to the client |
| `GOOGLE_WORKSPACE_SERVICES` | Comma-separated service IDs (`drive,docs,sheets,calendar,gmail,slides,people,chat`) or `all` |
| `GOOGLE_WORKSPACE_TOOL_MODE` | `all`, `safe-write`, or `read-only` |
| `GOOGLE_OAUTH_PORT` | Loopback port used during setup (default `3000`) |

`safe-write` hides tools annotated as destructive, generic raw batch-update
tools, permission/workflow operations, and known outbound tools such as email,
calendar notifications, comments, and Chat sending. Use `read-only` when writes
must be impossible through MCP. These modes reduce the MCP surface but do not
remove OAuth grants already issued to the profile.

`GOOGLE_WORKSPACE_SERVICES` controls tool exposure, not authorization. If a
service was not selected when the profile was authorized, re-authorize the
profile before enabling it at runtime.

For compatibility, `GOOGLE_DRIVE_PROFILE`, `GOOGLE_DRIVE_CONFIG`, and
`GOOGLE_DRIVE_SERVER_NAME` remain accepted as legacy aliases. New
configurations should use `GOOGLE_WORKSPACE_*`.

## Security model

- Users supply their own Google OAuth client; no OAuth secret is packaged or
  injected during publishing.
- Setup uses OAuth PKCE, a cryptographically random state value, a loopback
  callback timeout, and incremental scopes based on selected services.
- Profile files are written atomically with mode `0600` and their directory
  with mode `0700` on supported platforms.
- Deleting a profile attempts to revoke its Google refresh token before
  removing the local file.
- Every MCP call is validated against its JSON Schema at runtime. Tool metadata
  identifies read-only, idempotent, and destructive operations for capable
  clients.
- Gmail messages are built with a MIME library and bounded for size. Returned
  email bodies are explicitly delimited as untrusted content.
- Google Chat results carry an untrusted-content notice, threaded sends fail
  closed instead of silently creating a new thread, and structured JSON
  responses have a 4 MiB hard limit.
- The packaging check rejects `build/defaults.json`, preventing the former
  embedded-default credential mechanism from returning.

`read_restricted_document` is an unsupported, best-effort fallback that parses
Google's `mobilebasic` HTML page. It validates responses and is bounded, but the
endpoint can change or stop working; prefer `read_document`.

## Development and verification

```bash
npm ci
npm run build       # clean TypeScript build
npm test            # build plus automated tests
npm run check       # tests plus complete dependency audit
npm run tools       # generated service-by-service tool inventory
npm pack --dry-run  # inspect the npm package before release
```

The automated suite covers contracts, validation, API request construction,
pagination, tab-aware Docs behavior, security-sensitive helpers, and packaging
invariants using mocks. It does not claim live authorization or destructive
integration testing against a real Google account.

## Publishing

Releases use npm trusted publishing from GitHub Actions with OIDC and npm
provenance; no long-lived npm write token or Google OAuth credentials are
required in the workflow. See
[PUBLISHING.md](https://github.com/Arkady-Dymkov/google-drive-mcp/blob/main/PUBLISHING.md)
for the one-time npm configuration and release procedure.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
