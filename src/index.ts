#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";

// Google Drive MIME types
const MIME_TYPES = {
  FOLDER: "application/vnd.google-apps.folder",
  DOCUMENT: "application/vnd.google-apps.document",
  SPREADSHEET: "application/vnd.google-apps.spreadsheet",
  PRESENTATION: "application/vnd.google-apps.presentation",
  FORM: "application/vnd.google-apps.form",
  DRAWING: "application/vnd.google-apps.drawing",
};

// Export formats
const EXPORT_FORMATS = {
  [MIME_TYPES.DOCUMENT]: "text/plain",
  [MIME_TYPES.SPREADSHEET]: "text/csv",
  [MIME_TYPES.PRESENTATION]: "text/plain",
};

interface GoogleDriveConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken?: string;
}

class GoogleDriveMCPServer {
  private server: Server;
  private auth: OAuth2Client | null = null;
  private drive: any = null;
  private docs: any = null;
  private sheets: any = null;
  private configPath: string;

  constructor() {
    this.server = new Server(
      {
        name: "google-drive-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.configPath = path.join(homedir(), ".google-drive-mcp", "config.json");
    this.setupHandlers();
  }

  private async loadConfig(): Promise<GoogleDriveConfig | null> {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, "utf-8");
        return JSON.parse(data);
      }
    } catch (error) {
      console.error("Error loading config:", error);
    }
    return null;
  }

  private async saveConfig(config: GoogleDriveConfig): Promise<void> {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }

  private async initializeAuth(): Promise<void> {
    const config = await this.loadConfig();

    if (!config || !config.clientId || !config.clientSecret) {
      throw new Error(
        "Google Drive credentials not configured. Please run setup first.",
      );
    }

    this.auth = new google.auth.OAuth2(
      config.clientId,
      config.clientSecret,
      config.redirectUri || "urn:ietf:wg:oauth:2.0:oob",
    );

    if (config.refreshToken) {
      this.auth.setCredentials({ refresh_token: config.refreshToken });
      this.drive = google.drive({ version: "v3", auth: this.auth });
      this.docs = google.docs({ version: "v1", auth: this.auth });
      this.sheets = google.sheets({ version: "v4", auth: this.auth });
    } else {
      throw new Error(
        "No refresh token found. Please complete OAuth flow first.",
      );
    }
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [
        {
          name: "list_files",
          description:
            "List files and folders in Google Drive. Supports filtering by folder ID, query, and pagination.",
          inputSchema: {
            type: "object",
            properties: {
              folderId: {
                type: "string",
                description:
                  "Optional folder ID to list files from. If not provided, lists from root.",
              },
              query: {
                type: "string",
                description:
                  "Optional search query (e.g., 'name contains \"report\"', 'mimeType=\"application/pdf\"')",
              },
              pageSize: {
                type: "number",
                description:
                  "Number of results per page (default: 100, max: 1000)",
                default: 100,
              },
              pageToken: {
                type: "string",
                description: "Token for pagination",
              },
            },
          },
        },
        {
          name: "read_file",
          description:
            "Read contents of a Google Drive file. Supports Google Docs, Sheets, and regular files.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
                description: "The ID of the file to read",
              },
              mimeType: {
                type: "string",
                description:
                  "Optional MIME type for export (for Google Docs/Sheets). Defaults to plain text.",
              },
            },
            required: ["fileId"],
          },
        },
        {
          name: "read_document",
          description:
            "Read a Google Doc with full formatting information including text, paragraphs, and structure.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: {
                type: "string",
                description: "The ID of the Google Doc to read",
              },
            },
            required: ["documentId"],
          },
        },
        {
          name: "read_spreadsheet",
          description:
            "Read data from a Google Sheet with sheet names and cell values.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: {
                type: "string",
                description: "The ID of the Google Sheet to read",
              },
              range: {
                type: "string",
                description:
                  "Optional range in A1 notation (e.g., 'Sheet1!A1:D10'). If not provided, reads all sheets.",
              },
            },
            required: ["spreadsheetId"],
          },
        },
        {
          name: "search_files",
          description: "Search for files in Google Drive using a query string.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Search query (e.g., 'name contains \"budget\"', 'fullText contains \"project\"')",
              },
              pageSize: {
                type: "number",
                description: "Number of results (default: 20)",
                default: 20,
              },
            },
            required: ["query"],
          },
        },
        {
          name: "get_file_metadata",
          description:
            "Get detailed metadata about a specific file including permissions, sharing settings, and properties.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
                description: "The ID of the file",
              },
            },
            required: ["fileId"],
          },
        },
        {
          name: "create_document",
          description: "Create a new Google Doc with optional initial content.",
          inputSchema: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Title of the new document",
              },
              content: {
                type: "string",
                description: "Initial text content for the document",
              },
              folderId: {
                type: "string",
                description: "Optional folder ID to create the document in",
              },
            },
            required: ["title"],
          },
        },
        {
          name: "create_folder",
          description: "Create a new folder in Google Drive.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Name of the new folder",
              },
              parentId: {
                type: "string",
                description:
                  "Optional parent folder ID. If not provided, creates in root.",
              },
            },
            required: ["name"],
          },
        },
        {
          name: "upload_file",
          description:
            "Upload a file to Google Drive from local path or content.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Name for the file in Google Drive",
              },
              content: {
                type: "string",
                description: "File content as string",
              },
              mimeType: {
                type: "string",
                description: "MIME type of the file (default: text/plain)",
                default: "text/plain",
              },
              folderId: {
                type: "string",
                description: "Optional folder ID to upload to",
              },
            },
            required: ["name", "content"],
          },
        },
      ];

      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name, arguments: args } = request.params;

        // Initialize auth
        if (!this.auth || !this.drive) {
          await this.initializeAuth();
        }

        switch (name) {
          case "list_files":
            return await this.handleListFiles(args as any);
          case "read_file":
            return await this.handleReadFile(args as any);
          case "read_document":
            return await this.handleReadDocument(args as any);
          case "read_spreadsheet":
            return await this.handleReadSpreadsheet(args as any);
          case "search_files":
            return await this.handleSearchFiles(args as any);
          case "get_file_metadata":
            return await this.handleGetFileMetadata(args as any);
          case "create_document":
            return await this.handleCreateDocument(args as any);
          case "create_folder":
            return await this.handleCreateFolder(args as any);
          case "upload_file":
            return await this.handleUploadFile(args as any);
          default:
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown tool: ${name}`,
                },
              ],
            };
        }
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async handleListFiles(args: {
    folderId?: string;
    query?: string;
    pageSize?: number;
    pageToken?: string;
  }) {
    let q = args.query || "";

    if (args.folderId) {
      q = q
        ? `${q} and '${args.folderId}' in parents`
        : `'${args.folderId}' in parents`;
    }

    if (!q) {
      q = "'root' in parents";
    }

    q += " and trashed=false";

    const response = await this.drive.files.list({
      q,
      pageSize: args.pageSize || 100,
      pageToken: args.pageToken,
      fields:
        "nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink, parents)",
    });

    const files = response.data.files || [];
    const fileList = files
      .map(
        (file: any) =>
          `- ${file.name} (ID: ${file.id}, Type: ${file.mimeType}, Size: ${file.size || "N/A"} bytes)`,
      )
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${files.length} files:\n\n${fileList}\n\n${
            response.data.nextPageToken
              ? `Next page token: ${response.data.nextPageToken}`
              : "No more pages."
          }`,
        },
      ],
    };
  }

  private async handleReadFile(args: { fileId: string; mimeType?: string }) {
    const fileMetadata = await this.drive.files.get({
      fileId: args.fileId,
      fields: "id, name, mimeType, size",
    });

    const file = fileMetadata.data;
    let content = "";

    // Check if it's a Google Workspace file
    if (file.mimeType?.startsWith("application/vnd.google-apps.")) {
      const exportMimeType =
        args.mimeType ||
        EXPORT_FORMATS[file.mimeType as string] ||
        "text/plain";

      const response = await this.drive.files.export(
        {
          fileId: args.fileId,
          mimeType: exportMimeType,
        },
        { responseType: "text" },
      );

      content = response.data as string;
    } else {
      // Regular file
      const response = await this.drive.files.get(
        {
          fileId: args.fileId,
          alt: "media",
        },
        { responseType: "text" },
      );

      content = response.data as string;
    }

    return {
      content: [
        {
          type: "text",
          text: `File: ${file.name}\nType: ${file.mimeType}\n\nContent:\n${content}`,
        },
      ],
    };
  }

  private async handleReadDocument(args: { documentId: string }) {
    const doc = await this.docs.documents.get({
      documentId: args.documentId,
    });

    const title = doc.data.title;
    const body = doc.data.body;

    let text = "";

    if (body && body.content) {
      for (const element of body.content) {
        if (element.paragraph) {
          for (const textElement of element.paragraph.elements || []) {
            if (textElement.textRun) {
              text += textElement.textRun.content;
            }
          }
        } else if (element.table) {
          text += "\n[Table content]\n";
        }
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `Document: ${title}\n\n${text}`,
        },
      ],
    };
  }

  private async handleReadSpreadsheet(args: {
    spreadsheetId: string;
    range?: string;
  }) {
    const spreadsheet = await this.sheets.spreadsheets.get({
      spreadsheetId: args.spreadsheetId,
    });

    const title = spreadsheet.data.properties?.title;
    let output = `Spreadsheet: ${title}\n\n`;

    if (args.range) {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: args.spreadsheetId,
        range: args.range,
      });

      const values = response.data.values || [];
      output += `Range: ${args.range}\n\n`;
      output += values.map((row: any[]) => row.join("\t")).join("\n");
    } else {
      // Read all sheets
      const sheets = spreadsheet.data.sheets || [];

      for (const sheet of sheets) {
        const sheetTitle = sheet.properties?.title;
        output += `\nSheet: ${sheetTitle}\n`;

        try {
          const response = await this.sheets.spreadsheets.values.get({
            spreadsheetId: args.spreadsheetId,
            range: sheetTitle!,
          });

          const values = response.data.values || [];
          if (values.length > 0) {
            output += values
              .slice(0, 100)
              .map((row: any[]) => row.join("\t"))
              .join("\n");
            if (values.length > 100) {
              output += `\n... (${values.length - 100} more rows)`;
            }
          } else {
            output += "(empty)\n";
          }
        } catch (error) {
          output += "(unable to read)\n";
        }
      }
    }

    return {
      content: [
        {
          type: "text",
          text: output,
        },
      ],
    };
  }

  private async handleSearchFiles(args: { query: string; pageSize?: number }) {
    const response = await this.drive.files.list({
      q: `${args.query} and trashed=false`,
      pageSize: args.pageSize || 20,
      fields:
        "files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink)",
    });

    const files = response.data.files || [];
    const fileList = files
      .map(
        (file: any) =>
          `- ${file.name} (ID: ${file.id})\n  Type: ${file.mimeType}\n  Link: ${file.webViewLink}`,
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${files.length} files:\n\n${fileList || "No files found."}`,
        },
      ],
    };
  }

  private async handleGetFileMetadata(args: { fileId: string }) {
    const response = await this.drive.files.get({
      fileId: args.fileId,
      fields: "*",
    });

    const file = response.data;
    const metadata = JSON.stringify(file, null, 2);

    return {
      content: [
        {
          type: "text",
          text: `File Metadata:\n\n${metadata}`,
        },
      ],
    };
  }

  private async handleCreateDocument(args: {
    title: string;
    content?: string;
    folderId?: string;
  }) {
    // Create the document
    const doc = await this.docs.documents.create({
      requestBody: {
        title: args.title,
      },
    });

    const documentId = doc.data.documentId!;

    // Add content if provided
    if (args.content) {
      await this.docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            {
              insertText: {
                location: {
                  index: 1,
                },
                text: args.content,
              },
            },
          ],
        },
      });
    }

    // Move to folder if specified
    if (args.folderId) {
      await this.drive.files.update({
        fileId: documentId,
        addParents: args.folderId,
        fields: "id, parents",
      });
    }

    return {
      content: [
        {
          type: "text",
          text: `Document created successfully!\nTitle: ${args.title}\nID: ${documentId}\nURL: https://docs.google.com/document/d/${documentId}/edit`,
        },
      ],
    };
  }

  private async handleCreateFolder(args: { name: string; parentId?: string }) {
    const fileMetadata: any = {
      name: args.name,
      mimeType: MIME_TYPES.FOLDER,
    };

    if (args.parentId) {
      fileMetadata.parents = [args.parentId];
    }

    const response = await this.drive.files.create({
      requestBody: fileMetadata,
      fields: "id, name, webViewLink",
    });

    const folder = response.data;

    return {
      content: [
        {
          type: "text",
          text: `Folder created successfully!\nName: ${folder.name}\nID: ${folder.id}\nURL: ${folder.webViewLink}`,
        },
      ],
    };
  }

  private async handleUploadFile(args: {
    name: string;
    content: string;
    mimeType?: string;
    folderId?: string;
  }) {
    const fileMetadata: any = {
      name: args.name,
    };

    if (args.folderId) {
      fileMetadata.parents = [args.folderId];
    }

    const media = {
      mimeType: args.mimeType || "text/plain",
      body: args.content,
    };

    const response = await this.drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: "id, name, webViewLink",
    });

    const file = response.data;

    return {
      content: [
        {
          type: "text",
          text: `File uploaded successfully!\nName: ${file.name}\nID: ${file.id}\nURL: ${file.webViewLink}`,
        },
      ],
    };
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Google Drive MCP Server running on stdio");
  }
}

const server = new GoogleDriveMCPServer();
server.run().catch(console.error);
