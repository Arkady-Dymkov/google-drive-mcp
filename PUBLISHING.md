# Publishing `adw-google-mcp`

Releases are published from `.github/workflows/publish.yml` when a `v*` tag is
pushed. The workflow builds and tests on Node 24, runs the complete dependency
audit, and publishes through npm trusted publishing (OIDC). It does not embed
Google OAuth credentials or use a long-lived npm write token.

## One-time npm configuration

On npmjs.com, open the package settings for `adw-google-mcp` and configure a
trusted publisher with these exact values:

- Provider: GitHub Actions
- Organization or user: `Arkady-Dymkov`
- Repository: `google-drive-mcp`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

After the OIDC publish succeeds, revoke the old `NPM_TOKEN` secret and disable
token-based publishing for the package. npm trusted publishing automatically
creates provenance attestations for public packages.

## Google OAuth credentials

OAuth client credentials are never included in the npm package. Each user runs
the setup wizard and supplies a Desktop OAuth client JSON file or the client ID
and secret from their own Google Cloud project. Existing profiles continue to
store their credentials and refresh token locally in files with mode `0600`.

Enable the APIs for every service the profile will use:

- Google Drive, Docs, Sheets, Slides, Calendar, Gmail, People, and Chat APIs
- For Chat, configure a Google Chat app in the same Cloud project

Public apps requesting Gmail or other sensitive/restricted scopes can require
Google verification. Internal Workspace apps and local personal testing have
different eligibility rules; do not tell users to bypass an unverified-app
warning unless they understand and control the OAuth project.

## Publish

```bash
git tag v0.1.0
git push origin v0.1.0
```

The tag version is injected into `package.json` in CI. Before tagging, run:

```bash
npm ci
npm run check
npm pack --dry-run
```

Publish stable `vMAJOR.MINOR.PATCH` versions through the workflow. Local manual
publishing is intentionally not the release path because npm provenance for
this package is bound to GitHub Actions OIDC. Do not create a
`build/defaults.json` file or otherwise package OAuth secrets.
