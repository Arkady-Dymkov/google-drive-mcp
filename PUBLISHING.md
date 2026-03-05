# Publishing adw-google-mcp to npm

## How it works

When published, `npx adw-google-mcp` downloads the package from npm and runs it. The package includes `build/defaults.json` with your Google OAuth credentials baked in, so customers just run `--setup` and authorize — no Google Cloud project needed on their end.

The credentials are injected by GitHub Actions during publish (never stored in the repo).

## One-time setup

### 1. npm account

Create one at https://www.npmjs.com/signup if you don't have one.

### 2. GitHub repository secrets

Go to your repo → Settings → Secrets and variables → Actions → New repository secret.

Add these three secrets:

| Secret name | Value | Where to get it |
|---|---|---|
| `NPM_TOKEN` | npm access token | npmjs.com → Access Tokens → Generate New Token (Automation) |
| `GOOGLE_CLIENT_ID` | Your OAuth client ID | Google Cloud Console → Credentials → OAuth 2.0 Client IDs |
| `GOOGLE_CLIENT_SECRET` | Your OAuth client secret | Same place as above |

### 3. Google Cloud project (one-time)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project, enable: Drive, Docs, Sheets, Calendar, Gmail APIs
3. Configure OAuth consent screen → User type: External → Publish App
4. Create OAuth client ID (Desktop app type)
5. Copy the Client ID and Client Secret → add as GitHub secrets above

## Publishing

Publishing happens automatically when you create a GitHub release:

1. Bump version: `npm version patch` (or `minor` / `major`)
2. Push: `git push && git push --tags`
3. Go to GitHub → Releases → Create release from the new tag
4. GitHub Actions runs: builds → injects credentials → publishes to npm

### What the CI does

```
npm ci                          # Install dependencies
npm run build                   # Compile TypeScript
echo '{...}' > build/defaults.json  # Inject OAuth credentials from secrets
npm publish                     # Publish to npm with credentials baked in
```

The `build/defaults.json` file:
- Is NOT in the git repo (`build/` is gitignored)
- IS in the npm package (`package.json` files: `["build/"]`)
- Contains `{ "clientId": "...", "clientSecret": "..." }`

### Manual publishing (alternative)

If you prefer not to use GitHub Actions:

```bash
npm run build
echo '{"clientId":"YOUR_ID","clientSecret":"YOUR_SECRET"}' > build/defaults.json
npm publish
```

## After publishing

Customers install and authorize in two commands:

```bash
# First time only — authorize Google account
npx adw-google-mcp --setup

# MCP client config (no env vars needed!)
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "adw-google-mcp"]
    }
  }
}
```

## Credential priority

The setup wizard resolves credentials in this order:

1. `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` env vars (explicit override)
2. `build/defaults.json` built into the npm package (from CI)
3. Existing config file (re-authorization)
4. OAuth JSON file or manual input (DIY fallback)

## Testing locally

To test the defaults.json flow before publishing:

```bash
npm run build
echo '{"clientId":"YOUR_ID","clientSecret":"YOUR_SECRET"}' > build/defaults.json
node build/index.js --setup
```

## Security notes

- The client ID/secret for Desktop OAuth apps are not truly secret (Google acknowledges this for native apps)
- The actual security comes from the OAuth flow itself — each user must consent in their browser
- Users' refresh tokens are stored locally in `~/.config/google-drive-mcp/`, never shared
- The 100-user cap applies until you complete Google's app verification process
