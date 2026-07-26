# CLAUDE.md

## Project overview

`adw-google-mcp` is a local stdio MCP server for Google Drive, Docs, Sheets,
Calendar, Gmail, Slides, People, and Chat. Profiles support multiple Google
accounts and store OAuth credentials under `~/.config/google-drive-mcp/`.
`GOOGLE_WORKSPACE_PROFILE` selects a profile; legacy `GOOGLE_DRIVE_PROFILE`
remains supported.

Run `npm run tools` for the authoritative generated tool inventory; do not copy a
hard-coded total into documentation.

## Commands

```bash
npm install
npm run build
npm run test
npm run check       # tests plus complete dependency audit
npm run tools       # grouped tool inventory
npm run setup
```

Node 22 or newer is required. CI covers Node 22, 24, and 26.

## Architecture

| Path | Purpose |
|---|---|
| `src/index.ts` | CLI entry point |
| `src/server.ts` | MCP registry, runtime schema validation, annotations, dispatch |
| `src/auth.ts` | Profile paths, secure config persistence, OAuth client creation |
| `src/setup.ts` | OAuth PKCE setup and profile management |
| `src/scopes.ts` | Service IDs and least-privilege OAuth scope mapping |
| `src/markdown.ts` | Markdown, HTML, and Google Docs conversion |
| `src/types.ts` | Shared service and tool contracts |
| `src/utils.ts` | Validation and response builders |
| `src/services/*.ts` | One module per Google Workspace service |
| `src/tests/*.test.ts` | Contract and mocked regression tests |

Google Docs operations must remain tab-aware. Read with `includeTabsContent` and
carry `tabId` through locations, ranges, end-of-segment locations, table
locations, and tab lifecycle requests.

## Adding a service or tool

1. Implement the `Service` interface in `src/services/`.
2. Register the service in `src/server.ts`.
3. Add the service and OAuth scopes to `src/scopes.ts`.
4. Add mocked contract/regression tests.
5. Run `npm run check` and `npm run tools`.

Every tool receives runtime JSON Schema validation, MCP annotations, and a
structured object response through the server. Mutating handlers should still
perform semantic validation and return useful Google API IDs/replies.

## Publishing

Publishing is tag-triggered through GitHub Actions and npm trusted publishing.
OAuth client credentials must never be added to the npm package. See
`PUBLISHING.md`.
