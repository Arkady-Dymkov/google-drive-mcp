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
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import TurndownService from "turndown";

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
          name: "read_restricted_document",
          description:
            "Read a restricted/protected Google Doc that cannot be accessed via the API. Uses the mobilebasic endpoint to extract content. Use this when read_document fails with permission errors or returns incomplete content.",
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
        {
          name: "move_file",
          description:
            "Move a file or folder to a different location in Google Drive. Can move to a specific folder or to the root.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
                description: "The ID of the file or folder to move",
              },
              destinationFolderId: {
                type: "string",
                description:
                  "The ID of the destination folder. Use 'root' to move to the root of My Drive.",
              },
            },
            required: ["fileId", "destinationFolderId"],
          },
        },
        {
          name: "append_text_to_document",
          description:
            "Append text to the end of an existing Google Doc.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: {
                type: "string",
                description: "The ID of the Google Doc to append to",
              },
              text: {
                type: "string",
                description: "The text to append to the document",
              },
            },
            required: ["documentId", "text"],
          },
        },
        {
          name: "replace_text_in_document",
          description:
            "Find and replace text throughout a Google Doc.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: {
                type: "string",
                description: "The ID of the Google Doc",
              },
              findText: {
                type: "string",
                description: "The text to find",
              },
              replaceText: {
                type: "string",
                description: "The text to replace it with",
              },
              matchCase: {
                type: "boolean",
                description: "Whether to match case (default: false)",
                default: false,
              },
            },
            required: ["documentId", "findText", "replaceText"],
          },
        },
        {
          name: "format_text_in_document",
          description:
            "Apply formatting (bold, italic, etc.) to all occurrences of specified text in a Google Doc.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: {
                type: "string",
                description: "The ID of the Google Doc",
              },
              findText: {
                type: "string",
                description: "The text to format",
              },
              bold: {
                type: "boolean",
                description: "Apply bold formatting",
              },
              italic: {
                type: "boolean",
                description: "Apply italic formatting",
              },
              underline: {
                type: "boolean",
                description: "Apply underline formatting",
              },
              fontSize: {
                type: "number",
                description: "Font size in points",
              },
              foregroundColor: {
                type: "string",
                description: "Text color as hex (e.g., '#FF0000' for red)",
              },
            },
            required: ["documentId", "findText"],
          },
        },
        {
          name: "insert_table_in_document",
          description:
            "Insert a table at the end of a Google Doc.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: {
                type: "string",
                description: "The ID of the Google Doc",
              },
              rows: {
                type: "number",
                description: "Number of rows in the table",
              },
              columns: {
                type: "number",
                description: "Number of columns in the table",
              },
              headerRow: {
                type: "array",
                items: { type: "string" },
                description: "Optional array of header cell values",
              },
            },
            required: ["documentId", "rows", "columns"],
          },
        },
        {
          name: "update_paragraph_style_in_document",
          description:
            "Update paragraph formatting (alignment, spacing, lists) for paragraphs containing specified text.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: {
                type: "string",
                description: "The ID of the Google Doc",
              },
              findText: {
                type: "string",
                description: "Text to find - the paragraph containing this text will be styled",
              },
              alignment: {
                type: "string",
                enum: ["START", "CENTER", "END", "JUSTIFIED"],
                description: "Paragraph alignment",
              },
              lineSpacing: {
                type: "number",
                description: "Line spacing multiplier (e.g., 1.5 for 1.5x spacing)",
              },
              bulletPreset: {
                type: "string",
                enum: ["BULLET_DISC_CIRCLE_SQUARE", "BULLET_ARROW_DIAMOND_DISC", "NUMBERED_DECIMAL_NESTED"],
                description: "Convert paragraph to a bulleted or numbered list",
              },
            },
            required: ["documentId", "findText"],
          },
        },
        {
          name: "batch_update_document",
          description:
            "Execute multiple raw batchUpdate operations atomically on a Google Doc. For advanced users who need full API access.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: {
                type: "string",
                description: "The ID of the Google Doc",
              },
              requests: {
                type: "array",
                description: "Array of Google Docs API request objects (insertText, deleteContentRange, replaceAllText, updateTextStyle, etc.)",
              },
            },
            required: ["documentId", "requests"],
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
          case "read_restricted_document":
            return await this.handleReadRestrictedDocument(args as any);
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
          case "move_file":
            return await this.handleMoveFile(args as any);
          case "append_text_to_document":
            return await this.handleAppendTextToDocument(args as any);
          case "replace_text_in_document":
            return await this.handleReplaceTextInDocument(args as any);
          case "format_text_in_document":
            return await this.handleFormatTextInDocument(args as any);
          case "insert_table_in_document":
            return await this.handleInsertTableInDocument(args as any);
          case "update_paragraph_style_in_document":
            return await this.handleUpdateParagraphStyleInDocument(args as any);
          case "batch_update_document":
            return await this.handleBatchUpdateDocument(args as any);
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

  private async handleReadRestrictedDocument(args: { documentId: string }) {
    // Get access token for authorization
    const accessToken = await this.auth!.getAccessToken();

    if (!accessToken.token) {
      throw new Error("Failed to obtain access token");
    }

    // Fetch the mobilebasic version of the document
    const url = `https://docs.google.com/document/d/${args.documentId}/mobilebasic`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch document: ${response.status} ${response.statusText}`,
      );
    }

    const html = await response.text();

    // Parse HTML to extract content
    const $ = cheerio.load(html);

    // Extract title - try multiple selectors
    let title =
      $("title").text().trim() ||
      $("h1").first().text().trim() ||
      "Untitled Document";

    // Remove " - Google Docs" suffix if present
    title = title.replace(/ - Google Docs$/i, "").trim();

    // Extract main content HTML - preserve formatting
    let contentHtml = "";

    // Try to find main content container
    const mainContent = $(".doc-content, .document-content, #contents, main");
    if (mainContent.length > 0) {
      contentHtml = mainContent.html() || "";
    }

    // If no structured content found, try to extract HTML from paragraphs and headers
    if (!contentHtml || contentHtml.length < 100) {
      const contentElements: string[] = [];
      $("h1, h2, h3, h4, h5, h6, p, ul, ol, table").each((i, elem) => {
        const elementHtml = $(elem).prop("outerHTML");
        if (elementHtml && $(elem).text().trim().length > 0) {
          contentElements.push(elementHtml);
        }
      });
      contentHtml = contentElements.join("\n");
    }

    // Convert HTML to Markdown using Turndown
    const turndownService = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      fence: "```",
      emDelimiter: "*",
      strongDelimiter: "**",
      linkStyle: "inlined",
    });

    // Configure Turndown to handle Google Docs specific elements
    turndownService.addRule("removeEmptyElements", {
      filter: (node: any) => {
        return (
          node.nodeName === "SPAN" &&
          (!node.textContent || node.textContent.trim() === "")
        );
      },
      replacement: () => "",
    });

    let markdown = "";
    if (contentHtml) {
      try {
        markdown = turndownService.turndown(contentHtml);
      } catch (error) {
        // Fallback to plain text if HTML conversion fails
        markdown = $("body").text().trim();
      }
    }

    // If still no content, fallback to plain text extraction
    if (!markdown || markdown.trim().length < 50) {
      const paragraphs: string[] = [];
      $("p, h1, h2, h3, h4, h5, h6").each((i, elem) => {
        const text = $(elem).text().trim();
        if (text && text.length > 0) {
          // Add markdown formatting for headers
          const tagName = elem.tagName?.toLowerCase();
          if (tagName?.startsWith("h")) {
            const level = parseInt(tagName.slice(1));
            const hashes = "#".repeat(level);
            paragraphs.push(`${hashes} ${text}`);
          } else {
            paragraphs.push(text);
          }
        }
      });
      markdown = paragraphs.join("\n\n");
    }

    // Clean up excessive whitespace in markdown
    markdown = markdown.replace(/\n{4,}/g, "\n\n\n").trim();

    return {
      content: [
        {
          type: "text",
          text: `# ${title}\n\n${markdown}\n\n---\n*Content extracted from restricted document using mobilebasic endpoint and converted to Markdown*`,
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

  private async handleMoveFile(args: {
    fileId: string;
    destinationFolderId: string;
  }) {
    // First, get the current file info including its parents
    const fileInfo = await this.drive.files.get({
      fileId: args.fileId,
      fields: "id, name, parents, mimeType",
    });

    const file = fileInfo.data;
    const currentParents = file.parents ? file.parents.join(",") : "";

    // Move the file by removing from current parents and adding to new parent
    const response = await this.drive.files.update({
      fileId: args.fileId,
      addParents: args.destinationFolderId,
      removeParents: currentParents,
      fields: "id, name, parents, webViewLink",
    });

    const movedFile = response.data;
    const isFolder = file.mimeType === MIME_TYPES.FOLDER;
    const itemType = isFolder ? "Folder" : "File";

    return {
      content: [
        {
          type: "text",
          text: `${itemType} moved successfully!\nName: ${movedFile.name}\nID: ${movedFile.id}\nNew location: ${args.destinationFolderId === "root" ? "My Drive (root)" : `Folder ID: ${args.destinationFolderId}`}\nURL: ${movedFile.webViewLink}`,
        },
      ],
    };
  }

  private async handleAppendTextToDocument(args: {
    documentId: string;
    text: string;
  }) {
    // Get document to find end position
    const doc = await this.docs.documents.get({
      documentId: args.documentId,
    });

    const content = doc.data.body?.content || [];
    const lastElement = content[content.length - 1];
    const endIndex = lastElement?.endIndex || 1;

    // Insert text at end (endIndex - 1 to insert before the final newline)
    await this.docs.documents.batchUpdate({
      documentId: args.documentId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: {
                index: endIndex - 1,
              },
              text: args.text,
            },
          },
        ],
      },
    });

    return {
      content: [
        {
          type: "text",
          text: `Text appended successfully!\nDocument: https://docs.google.com/document/d/${args.documentId}/edit`,
        },
      ],
    };
  }

  private async handleReplaceTextInDocument(args: {
    documentId: string;
    findText: string;
    replaceText: string;
    matchCase?: boolean;
  }) {
    const response = await this.docs.documents.batchUpdate({
      documentId: args.documentId,
      requestBody: {
        requests: [
          {
            replaceAllText: {
              containsText: {
                text: args.findText,
                matchCase: args.matchCase || false,
              },
              replaceText: args.replaceText,
            },
          },
        ],
      },
    });

    const replaceResult = response.data.replies?.[0]?.replaceAllText;
    const occurrencesChanged = replaceResult?.occurrencesChanged || 0;

    return {
      content: [
        {
          type: "text",
          text: `Replaced ${occurrencesChanged} occurrence(s) of "${args.findText}" with "${args.replaceText}"\nDocument: https://docs.google.com/document/d/${args.documentId}/edit`,
        },
      ],
    };
  }

  private async handleFormatTextInDocument(args: {
    documentId: string;
    findText: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    fontSize?: number;
    foregroundColor?: string;
  }) {
    // First, get the document to find all occurrences of the text
    const doc = await this.docs.documents.get({
      documentId: args.documentId,
    });

    const content = doc.data.body?.content || [];
    const ranges: { startIndex: number; endIndex: number }[] = [];

    // Find all occurrences of the text
    for (const element of content) {
      if (element.paragraph) {
        for (const textElement of element.paragraph.elements || []) {
          if (textElement.textRun?.content) {
            const text = textElement.textRun.content;
            const startOffset = textElement.startIndex || 0;
            let searchIndex = 0;

            while (true) {
              const foundIndex = text.indexOf(args.findText, searchIndex);
              if (foundIndex === -1) break;

              ranges.push({
                startIndex: startOffset + foundIndex,
                endIndex: startOffset + foundIndex + args.findText.length,
              });
              searchIndex = foundIndex + 1;
            }
          }
        }
      }
    }

    if (ranges.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Text "${args.findText}" not found in document.`,
          },
        ],
      };
    }

    // Build text style object
    const textStyle: any = {};
    const fields: string[] = [];

    if (args.bold !== undefined) {
      textStyle.bold = args.bold;
      fields.push("bold");
    }
    if (args.italic !== undefined) {
      textStyle.italic = args.italic;
      fields.push("italic");
    }
    if (args.underline !== undefined) {
      textStyle.underline = args.underline;
      fields.push("underline");
    }
    if (args.fontSize !== undefined) {
      textStyle.fontSize = {
        magnitude: args.fontSize,
        unit: "PT",
      };
      fields.push("fontSize");
    }
    if (args.foregroundColor) {
      // Parse hex color
      const hex = args.foregroundColor.replace("#", "");
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;

      textStyle.foregroundColor = {
        color: {
          rgbColor: { red: r, green: g, blue: b },
        },
      };
      fields.push("foregroundColor");
    }

    // Apply formatting to all ranges (in reverse order to maintain indices)
    const requests = ranges
      .sort((a, b) => b.startIndex - a.startIndex)
      .map((range) => ({
        updateTextStyle: {
          range: {
            startIndex: range.startIndex,
            endIndex: range.endIndex,
          },
          textStyle,
          fields: fields.join(","),
        },
      }));

    await this.docs.documents.batchUpdate({
      documentId: args.documentId,
      requestBody: { requests },
    });

    return {
      content: [
        {
          type: "text",
          text: `Formatted ${ranges.length} occurrence(s) of "${args.findText}"\nDocument: https://docs.google.com/document/d/${args.documentId}/edit`,
        },
      ],
    };
  }

  private async handleInsertTableInDocument(args: {
    documentId: string;
    rows: number;
    columns: number;
    headerRow?: string[];
  }) {
    // Get document to find end position
    const doc = await this.docs.documents.get({
      documentId: args.documentId,
    });

    const content = doc.data.body?.content || [];
    const lastElement = content[content.length - 1];
    const endIndex = lastElement?.endIndex || 1;

    // Insert table at end
    await this.docs.documents.batchUpdate({
      documentId: args.documentId,
      requestBody: {
        requests: [
          {
            insertTable: {
              rows: args.rows,
              columns: args.columns,
              location: {
                index: endIndex - 1,
              },
            },
          },
        ],
      },
    });

    // If headerRow provided, populate the first row
    if (args.headerRow && args.headerRow.length > 0) {
      // Get updated document to find table cells
      const updatedDoc = await this.docs.documents.get({
        documentId: args.documentId,
      });

      const updatedContent = updatedDoc.data.body?.content || [];
      const table = updatedContent.find((el: any) => el.table);

      if (table?.table?.tableRows?.[0]?.tableCells) {
        const cells = table.table.tableRows[0].tableCells;
        const requests: any[] = [];

        // Insert header text in reverse order to maintain indices
        for (let i = Math.min(args.headerRow.length, cells.length) - 1; i >= 0; i--) {
          const cell = cells[i];
          const cellContent = cell.content?.[0];
          const insertIndex = cellContent?.startIndex || cell.startIndex + 1;

          requests.push({
            insertText: {
              location: { index: insertIndex },
              text: args.headerRow[i],
            },
          });
        }

        if (requests.length > 0) {
          await this.docs.documents.batchUpdate({
            documentId: args.documentId,
            requestBody: { requests },
          });
        }
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `Table inserted successfully (${args.rows} rows x ${args.columns} columns)\nDocument: https://docs.google.com/document/d/${args.documentId}/edit`,
        },
      ],
    };
  }

  private async handleUpdateParagraphStyleInDocument(args: {
    documentId: string;
    findText: string;
    alignment?: string;
    lineSpacing?: number;
    bulletPreset?: string;
  }) {
    // Get document to find the paragraph containing the text
    const doc = await this.docs.documents.get({
      documentId: args.documentId,
    });

    const content = doc.data.body?.content || [];
    let paragraphRange: { startIndex: number; endIndex: number } | null = null;

    // Find paragraph containing the text
    for (const element of content) {
      if (element.paragraph) {
        let paragraphText = "";
        for (const textElement of element.paragraph.elements || []) {
          if (textElement.textRun?.content) {
            paragraphText += textElement.textRun.content;
          }
        }

        if (paragraphText.includes(args.findText)) {
          paragraphRange = {
            startIndex: element.startIndex || 0,
            endIndex: element.endIndex || 0,
          };
          break;
        }
      }
    }

    if (!paragraphRange) {
      return {
        content: [
          {
            type: "text",
            text: `Text "${args.findText}" not found in any paragraph.`,
          },
        ],
      };
    }

    const requests: any[] = [];

    // Handle bullet/list conversion
    if (args.bulletPreset) {
      requests.push({
        createParagraphBullets: {
          range: {
            startIndex: paragraphRange.startIndex,
            endIndex: paragraphRange.endIndex,
          },
          bulletPreset: args.bulletPreset,
        },
      });
    }

    // Handle paragraph style updates
    if (args.alignment || args.lineSpacing) {
      const paragraphStyle: any = {};
      const fields: string[] = [];

      if (args.alignment) {
        paragraphStyle.alignment = args.alignment;
        fields.push("alignment");
      }
      if (args.lineSpacing) {
        paragraphStyle.lineSpacing = args.lineSpacing * 100; // Convert to percentage
        fields.push("lineSpacing");
      }

      requests.push({
        updateParagraphStyle: {
          range: {
            startIndex: paragraphRange.startIndex,
            endIndex: paragraphRange.endIndex,
          },
          paragraphStyle,
          fields: fields.join(","),
        },
      });
    }

    if (requests.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No style changes specified. Please provide alignment, lineSpacing, or bulletPreset.",
          },
        ],
      };
    }

    await this.docs.documents.batchUpdate({
      documentId: args.documentId,
      requestBody: { requests },
    });

    return {
      content: [
        {
          type: "text",
          text: `Paragraph style updated successfully!\nDocument: https://docs.google.com/document/d/${args.documentId}/edit`,
        },
      ],
    };
  }

  private async handleBatchUpdateDocument(args: {
    documentId: string;
    requests: any[];
  }) {
    const response = await this.docs.documents.batchUpdate({
      documentId: args.documentId,
      requestBody: {
        requests: args.requests,
      },
    });

    const repliesCount = response.data.replies?.length || 0;

    return {
      content: [
        {
          type: "text",
          text: `Batch update completed successfully!\nOperations executed: ${args.requests.length}\nReplies received: ${repliesCount}\nDocument: https://docs.google.com/document/d/${args.documentId}/edit`,
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
