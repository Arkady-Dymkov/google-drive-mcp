# Google Drive MCP Server

Connect AI assistants (Air.dev, Claude Desktop, etc.) to your Google Drive.

## 🚀 Quick Setup (5 minutes)

### Step 1: Install

```bash
npm install
```
```bash
npm run build
```

### Step 2: Get Google OAuth Credentials
**Important:** Each person needs their own credentials. Don't share OAuth files!

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable these APIs:
   - Google Drive API
   - Google Docs API
   - Google Sheets API
4. Go to "APIs & Services" > "Credentials"
5. Configure OAuth consent screen (first time only):
   - User type: "External"
   - Add your email as test user
6. Create OAuth client ID:
   - Type: "Desktop app"
   - Download the JSON file

### Step 3: Run Setup

```bash
npm run setup
```

- Answer "y" when asked about JSON file
- Drag and drop your downloaded JSON file
- Browser will open automatically for authorization
- Click "Allow" to grant permissions
- Done! ✅

### Step 4: Configure Your AI Client

#### For Air.dev:

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "google-drive": {
      "command": "node",
      "args": ["/FULL/PATH/TO/drive-mcp/build/index.js"]
    }
  }
}
```

Replace `/FULL/PATH/TO/` with your actual path (shown after setup completes).

#### For Claude Desktop:

Edit your config file:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Add the same configuration as above.

### Step 5: Restart & Test

Restart your AI client and ask:
- "List my Google Drive files"
- "Read the document called [name]"
- "Search for files with [keyword]"

## 🛠️ What Can It Do?

Your AI can now:
- ✅ List and browse files/folders
- ✅ Search for specific files
- ✅ Read Google Docs (including restricted/protected documents)
- ✅ Read Google Sheets
- ✅ Create new documents and folders
- ✅ Upload files
- ✅ Get file metadata

## 🆘 Troubleshooting

**"Authentication error" or "401 error"**
- Make sure you completed the OAuth flow (visited the browser link)
- Try running `npm run setup` again

**"This app isn't verified" warning**
- This is normal for personal projects
- Click "Advanced" > "Continue" - it's safe, it's your own app

**Server not showing in AI client**
- Check the path in your config is absolute and correct
- Restart your AI client completely

**Port 3000 already in use**
- Close apps using port 3000, or wait a minute and try again

**Any other**
- Contact @Arkadiy-DW in slack

## 👥 For Team Distribution

Each team member should:
1. Clone/copy this folder
2. Create their own Google Cloud project (free)
3. Download their own OAuth JSON
4. Run: `npm install && npm run build && npm run setup`
5. Configure their AI client with their own path

**Never share:**
- ❌ OAuth JSON files
- ❌ The `~/.google-drive-mcp/config.json` file
- ❌ Credentials between team members

## 🔒 Security

- Your credentials stay on your machine (`~/.google-drive-mcp/config.json`)
- OAuth2 secure authentication
- Revoke access anytime at https://myaccount.google.com/permissions

## 📋 Project Structure

```
drive-mcp/
├── src/index.ts          # MCP server code
├── setup.mjs             # Interactive setup script
├── package.json          # Dependencies
├── tsconfig.json         # TypeScript config
└── build/                # Compiled output (generated)
```

## 🔄 Updating

If code is updated:

```bash
git pull
npm install
npm run build
```

Your credentials remain intact - no need to run setup again.

## 📚 Available Tools

- **list_files** - List files and folders with pagination
- **search_files** - Search for files using queries
- **read_file** - Read any file content (exports Google formats)
- **read_document** - Read Google Docs with formatting
- **read_restricted_document** - Read protected/restricted documents that can't be accessed via API
- **read_spreadsheet** - Read Google Sheets data
- **get_file_metadata** - Get detailed file information
- **create_document** - Create new Google Docs
- **create_folder** - Create new folders
- **upload_file** - Upload files to Drive

### When to Use read_restricted_document

Use `read_restricted_document` instead of `read_document` when:
- The regular API returns permission/access denied errors
- Document content appears incomplete or truncated
- Document is shared with view-only restricted access
- You get "forbidden to download" errors

This tool uses Google's mobilebasic endpoint to extract content from restricted documents.

---

**Need help?** Check troubleshooting section or open an issue.
