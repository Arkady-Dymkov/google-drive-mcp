# Project summary

`adw-google-mcp` is a modular, multi-account Google Workspace MCP server for
Drive, Docs, Sheets, Calendar, Gmail, Slides, People, and Chat. The live tool
inventory is generated with `npm run tools`; this file deliberately does not
duplicate a count that can become stale.

## Current implementation

- Eight independently selectable services share one OAuth client and the MCP
  service interface.
- Profiles store their selected services and scopes. Older profiles retain the
  original Drive, Docs, Sheets, Calendar, and Gmail default until re-authorized.
- `GOOGLE_WORKSPACE_SERVICES` can override exposed services, while
  `GOOGLE_WORKSPACE_TOOL_MODE=all|safe-write|read-only` controls mutation and
  outbound-tool exposure.
- MCP input schemas are compiled and enforced at runtime; duplicate tool names
  fail at startup and results include structured content where available.

## Google Docs Document tabs

The Docs service understands the Document tabs hierarchy shown in Google Docs:

- list root and nested tabs with IDs, parents, depth, and position;
- create, rename, reorder, reparent, decorate, and explicitly delete tabs;
- read one tab or the complete document as text or Markdown;
- target text, formatting, image, page-break, and paragraph edits by `tabId`;
- discover and modify tables inside the correct tab, including cell content,
  rows, columns, merges, styles, and pinned header rows; and
- apply optional revision guards to avoid stale writes.

Docs Developer Preview comment/suggestion mutations are not presented as
stable tools. Suggested-edit rendering is available on reads, and Drive
comments remain supported.

## Added Workspace coverage

- Drive includes permissions, comments, shared drives, access proposals,
  approvals, and long-running downloads.
- Sheets includes native tables, batch value operations, smart chips,
  protected ranges, conditional formatting, data validation, and automatic
  resizing in addition to existing value and formatting tools.
- Calendar includes calendar details, label/color support, and time
  suggestions.
- Gmail includes complete draft/thread operations, filters, history,
  attachments, send-as identities, safe MIME generation, and metadata-first
  listings.
- Slides supports reading, creation, thumbnails, duplication, and raw batch
  updates. People supports profiles, contacts, sync cursors, and directory
  search. Chat supports spaces, messages, bounded local text search, and sends.

## Security and release posture

- Node.js 22 or newer is required.
- Setup accepts only user-supplied Desktop OAuth credentials or setup-time
  environment variables. No built-in credentials are distributed.
- OAuth uses PKCE and state validation; selected services determine requested
  scopes; local profile writes are atomic and permission-restricted; profile
  deletion attempts token revocation.
- Gmail content and attachments are bounded, MIME messages are library-built,
  and returned body text is marked as untrusted. Chat data is likewise marked
  as external content, threaded replies fail closed, and structured responses
  are bounded.
- CI builds and tests on supported Node versions. `npm run check` adds a
  complete dependency audit, and prepack rejects embedded OAuth defaults.
- Publishing is designed for npm trusted publishing with GitHub OIDC and
  provenance. The npm package's trusted-publisher setting is a one-time
  external prerequisite described in `PUBLISHING.md`.

## Validation boundary

Automated contract and mocked API tests verify tool registration, schemas,
request construction, pagination, Document tabs, tables, and key security
invariants. A live Google OAuth session and destructive tests against real
Workspace data are intentionally outside the automated suite.

Google Chat requires a configured Chat app in the user's Cloud project. The
unsupported `read_restricted_document` HTML fallback can break if Google
changes its private page shape and should not replace the Docs API.
