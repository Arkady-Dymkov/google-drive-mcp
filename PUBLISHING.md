# Publishing adw-google-mcp to npm

This document explains how to publish the package so that users can install and run it with `npx adw-google-mcp` without cloning the repo.

## How npx works

`npx adw-google-mcp` does the following:

1. Checks if `adw-google-mcp` is already installed locally or globally
2. If not, downloads it from the npm registry into a temporary cache
3. Finds the binary defined in `package.json` → `"bin": { "adw-google-mcp": "build/index.js" }`
4. Executes `node build/index.js`

The `-y` flag (`npx -y adw-google-mcp`) skips the "install?" confirmation prompt, which is important for MCP client configs where there's no interactive terminal.

This only works once the package is published to npm.

## Prerequisites

1. An npm account — create one at https://www.npmjs.com/signup
2. npm CLI logged in:
   ```bash
   npm login
   ```
3. The project builds successfully:
   ```bash
   npm run build
   ```

## Pre-publish checklist

```bash
# 1. Make sure you're on a clean state
git status

# 2. Build
npm run build

# 3. Check what will be published (should only include build/, README.md, LICENSE)
npm pack --dry-run

# 4. Verify package.json has correct:
#    - "name": "adw-google-mcp"
#    - "version": matches what you want to publish
#    - "bin": points to "build/index.js"
#    - "files": ["build/", "README.md", "LICENSE"]
```

## Publishing

```bash
# First time
npm publish

# Subsequent updates — bump version first
npm version patch   # 2.0.0 → 2.0.1 (bug fixes)
npm version minor   # 2.0.0 → 2.1.0 (new features)
npm version major   # 2.0.0 → 3.0.0 (breaking changes)
npm publish
```

## After publishing

Users can immediately:

```bash
# Run setup (interactive OAuth wizard)
npx adw-google-mcp --setup

# Or with a profile
GOOGLE_DRIVE_PROFILE=work npx adw-google-mcp --setup
```

And configure their MCP client:

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

## What gets published

The `"files"` field in package.json controls what's included in the npm tarball:

```
adw-google-mcp/
├── build/           # Compiled JS + declaration files + source maps
│   ├── index.js     # Entry point (has #!/usr/bin/env node shebang)
│   ├── server.js
│   ├── auth.js
│   ├── setup.js
│   ├── types.js
│   ├── utils.js
│   └── services/
│       ├── drive.js
│       ├── docs.js
│       └── sheets.js
├── README.md
├── LICENSE
└── package.json     # Always included automatically
```

Source TypeScript files, node_modules, config files, and dev tooling are NOT published.

## Verifying a published version

```bash
# Check published package info
npm view adw-google-mcp

# Test that npx works (from a directory outside this project)
cd /tmp && npx adw-google-mcp --setup
```

## Unpublishing (emergency only)

```bash
# Within 72 hours of publishing
npm unpublish adw-google-mcp@2.0.0
```

After 72 hours, you can only deprecate:
```bash
npm deprecate adw-google-mcp@2.0.0 "Use version X.Y.Z instead"
```
