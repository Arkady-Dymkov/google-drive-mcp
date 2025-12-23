# Google Drive MCP Server - Setup Guide for Team

Welcome! This guide will help you set up Google Drive access for your AI assistant (Air.dev, Claude Desktop, etc.) in just a few minutes.

## 🎯 What This Does

This MCP (Model Context Protocol) server allows AI assistants to:
- 📖 Read your Google Docs and Sheets
- 🔍 Search files in your Google Drive
- 📝 Create new documents and folders
- 📊 Analyze spreadsheet data
- 🤖 Automate workflows with your Drive content

## ⚡ Quick Setup (5 minutes)

### Step 1: Install Dependencies

```bash
cd drive-mcp
npm install
npm run build
```

### Step 2: Create Your Google Cloud Project

**Important:** Each person needs their own Google Cloud project and credentials. Do NOT share OAuth credentials between team members.

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Create Project" (top left, next to "Google Cloud")
3. Name it something like "My Drive MCP" and click "Create"

### Step 3: Enable Required APIs

1. In your project, go to **"APIs & Services"** > **"Library"**
2. Search for and enable these three APIs:
   - **Google Drive API** - Click "Enable"
   - **Google Docs API** - Click "Enable"  
   - **Google Sheets API** - Click "Enable"

### Step 4: Create OAuth Credentials

1. Go to **"APIs & Services"** > **"Credentials"**
2. Click **"Create Credentials"** > **"OAuth client ID"**

3. **First time only:** Configure OAuth consent screen:
   - Click "Configure Consent Screen"
   - Choose **"External"** user type
   - Fill in required fields:
     - App name: "Google Drive MCP"
     - User support email: (your email)
     - Developer contact: (your email)
   - Click "Save and Continue"
   - On "Scopes" page, click "Save and Continue" (we'll add them later)
   - On "Test users", click "Add Users" and add your email
   - Click "Save and Continue"

4. Back to creating OAuth client ID:
   - Application type: **"Desktop app"**
   - Name: "Google Drive MCP Client"
   - Click **"Create"**

5. **Download the JSON file:**
   - Click the download icon (⬇️) next to your newly created OAuth client
   - Save it to your Downloads folder
   - The file will be named something like `client_secret_xxxxx.json`

### Step 5: Run Setup Script

```bash
npm run setup
```

The script will:
1. Ask if you have a JSON file (answer: **y**)
2. Ask for the path - just **drag and drop your downloaded JSON file** into the terminal and press Enter
3. **Automatically open your browser** for authorization
4. Show a success page when complete
5. Display your MCP configuration

**Note:** When authorizing:
- Sign in with your Google account
- Click "Continue" even if Google says "app not verified" (it's your own app!)
- Click "Allow" to grant permissions
- You'll see a success page - you can close it

### Step 6: Configure Your AI Client

#### For Air.dev:

Add this to your Air.dev MCP configuration:

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

**Replace `/FULL/PATH/TO/`** with your actual path. The setup script will show you the exact path to use.

#### For Claude Desktop:

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent location on your OS:

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

### Step 7: Restart & Test

1. **Restart your AI client** (Air.dev, Claude Desktop, etc.)
2. Try a command: `list_files` or ask "What files do I have in my Google Drive?"
3. You should see your files! 🎉

## 🛠️ Available Tools

Once set up, your AI can use these tools:

- **list_files** - Browse files and folders
- **search_files** - Search for specific files
- **read_document** - Read Google Docs
- **read_spreadsheet** - Read Google Sheets data
- **read_file** - Read any file content
- **create_document** - Create new Google Docs
- **create_folder** - Create new folders
- **upload_file** - Upload files to Drive
- **get_file_metadata** - Get detailed file info

## 💡 Example Usage

Ask your AI assistant:

- "List all files in my Google Drive"
- "Read the document called 'Meeting Notes'"
- "Search for all spreadsheets with 'budget' in the name"
- "Create a new document called 'Project Summary'"
- "Read the spreadsheet 'Q4 Sales Data' and analyze the trends"
- "Summarize all documents in my 'Reports' folder"

## 🔒 Security & Privacy

- ✅ **Your credentials stay on your machine** - stored in `~/.google-drive-mcp/config.json`
- ✅ **Each person has their own credentials** - never share JSON files
- ✅ **OAuth2 secure authentication** - no passwords stored
- ✅ **You control access** - revoke anytime at https://myaccount.google.com/permissions

## 🆘 Troubleshooting

### "Credentials not configured"
**Solution:** Run `npm run setup` again

### "No refresh token found"
**Solution:** Complete the OAuth authorization flow (visit the browser link)

### "Port 3000 already in use"
**Solution:** Close any apps using port 3000, or change the port in `setup.mjs`

### Browser doesn't open automatically
**Solution:** Copy and paste the URL shown in the terminal into your browser

### "This app isn't verified" warning from Google
**Solution:** This is normal for personal projects. Click "Advanced" > "Go to [app name] (unsafe)" - it's safe because it's your own app

### Server not showing up in AI client
**Solution:** 
- Check that the path in your config is absolute and correct
- Make sure you ran `npm run build`
- Restart your AI client completely

## 🔄 Updating

If the server code is updated:

```bash
cd drive-mcp
git pull  # if using git
npm install
npm run build
```

Restart your AI client. Your credentials will remain intact.

## 👥 For Team Leads

**Distributing this to your team:**

1. Share this repository/folder with your team
2. Each person must:
   - Create their own Google Cloud project
   - Download their own OAuth JSON
   - Run `npm run setup` with their JSON
   - Configure their own AI client

**DO NOT:**
- ❌ Share OAuth credentials between team members
- ❌ Commit the `config.json` or OAuth JSON to version control
- ❌ Use a shared Google account for multiple people

**DO:**
- ✅ Each person creates their own Google Cloud project (free)
- ✅ Each person uses their own Google account
- ✅ Share this README and the code repository

## 📚 Additional Resources

- Full examples: See `EXAMPLES.md`
- Detailed setup: See `SETUP.md`
- Technical docs: See `README.md`
- Contributing: See `CONTRIBUTING.md`

## 🎓 Need Help?

1. Check the troubleshooting section above
2. Review the detailed `SETUP.md` guide
3. Ask your team lead
4. Open an issue in the repository

---

**Ready?** Run `npm run setup` and follow the prompts! 🚀