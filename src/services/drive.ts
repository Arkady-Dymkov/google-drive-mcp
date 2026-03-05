import { google, type drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Service, ToolDefinition } from "../types.js";
import {
  requireString,
  optionalString,
  optionalNumber,
  textResponse,
} from "../utils.js";

const MIME_TYPES = {
  FOLDER: "application/vnd.google-apps.folder",
  DOCUMENT: "application/vnd.google-apps.document",
  SPREADSHEET: "application/vnd.google-apps.spreadsheet",
  PRESENTATION: "application/vnd.google-apps.presentation",
} as const;

const EXPORT_FORMATS: Record<string, string> = {
  [MIME_TYPES.DOCUMENT]: "text/plain",
  [MIME_TYPES.SPREADSHEET]: "text/csv",
  [MIME_TYPES.PRESENTATION]: "text/plain",
};

function sanitizeDriveId(id: string): string {
  // Drive IDs are alphanumeric with hyphens and underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(id) && id !== "root") {
    throw new Error(`Invalid ID format: ${id}`);
  }
  return id;
}

export class DriveService implements Service {
  private drive!: drive_v3.Drive;

  initialize(auth: OAuth2Client): void {
    this.drive = google.drive({ version: "v3", auth });
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        tool: {
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
                  'Optional search query (e.g., \'name contains "report"\', \'mimeType="application/pdf"\')',
              },
              pageSize: {
                type: "number",
                description:
                  "Number of results per page (default: 100, max: 1000)",
              },
              pageToken: {
                type: "string",
                description: "Token for pagination",
              },
            },
          },
        },
        handler: (args) => this.listFiles(args),
      },
      {
        tool: {
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
        handler: (args) => this.readFile(args),
      },
      {
        tool: {
          name: "search_files",
          description:
            "Search for files in Google Drive using a query string.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  'Search query (e.g., \'name contains "budget"\', \'fullText contains "project"\')',
              },
              pageSize: {
                type: "number",
                description: "Number of results (default: 20)",
              },
            },
            required: ["query"],
          },
        },
        handler: (args) => this.searchFiles(args),
      },
      {
        tool: {
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
        handler: (args) => this.getFileMetadata(args),
      },
      {
        tool: {
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
        handler: (args) => this.createFolder(args),
      },
      {
        tool: {
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
              },
              folderId: {
                type: "string",
                description: "Optional folder ID to upload to",
              },
            },
            required: ["name", "content"],
          },
        },
        handler: (args) => this.uploadFile(args),
      },
      {
        tool: {
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
        handler: (args) => this.moveFile(args),
      },
      {
        tool: {
          name: "trash_file",
          description: "Move a file or folder to the trash in Google Drive.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
                description: "The ID of the file or folder to trash",
              },
            },
            required: ["fileId"],
          },
        },
        handler: (args) => this.trashFile(args),
      },
      {
        tool: {
          name: "rename_file",
          description: "Rename a file or folder in Google Drive.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
                description: "The ID of the file or folder to rename",
              },
              newName: {
                type: "string",
                description: "The new name for the file or folder",
              },
            },
            required: ["fileId", "newName"],
          },
        },
        handler: (args) => this.renameFile(args),
      },
      {
        tool: {
          name: "copy_file",
          description:
            "Create a copy of a file in Google Drive. Can optionally place the copy in a specific folder.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
                description: "The ID of the file to copy",
              },
              name: {
                type: "string",
                description: "Name for the copy (defaults to 'Copy of <original>')",
              },
              folderId: {
                type: "string",
                description: "Optional folder ID to place the copy in",
              },
            },
            required: ["fileId"],
          },
        },
        handler: (args) => this.copyFile(args),
      },
      {
        tool: {
          name: "share_file",
          description:
            "Share a file or folder with a user, group, or make it accessible via link. WARNING: type 'anyone' makes the file publicly accessible on the internet. Always confirm with the user before sharing publicly.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
                description: "The ID of the file or folder to share",
              },
              role: {
                type: "string",
                enum: ["reader", "commenter", "writer", "organizer"],
                description: "Permission role",
              },
              type: {
                type: "string",
                enum: ["user", "group", "domain", "anyone"],
                description:
                  "Who to share with. Use 'anyone' for link sharing.",
              },
              emailAddress: {
                type: "string",
                description:
                  "Email address (required for type 'user' or 'group')",
              },
            },
            required: ["fileId", "role", "type"],
          },
        },
        handler: (args) => this.shareFile(args),
      },
    ];
  }

  private async listFiles(args: Record<string, unknown>) {
    const folderId = optionalString(args, "folderId");
    const query = optionalString(args, "query");
    const pageSize = optionalNumber(args, "pageSize");
    const pageToken = optionalString(args, "pageToken");

    let q = query || "";
    if (folderId) {
      sanitizeDriveId(folderId);
      q = q
        ? `${q} and '${folderId}' in parents`
        : `'${folderId}' in parents`;
    }
    if (!q) {
      q = "'root' in parents";
    }
    q += " and trashed=false";

    const response = await this.drive.files.list({
      q,
      pageSize: pageSize || 100,
      pageToken: pageToken || undefined,
      fields:
        "nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink, parents)",
    });

    const files = response.data.files || [];
    const fileList = files
      .map(
        (file) =>
          `- ${file.name} (ID: ${file.id}, Type: ${file.mimeType}, Size: ${file.size || "N/A"} bytes)`,
      )
      .join("\n");

    const pagination = response.data.nextPageToken
      ? `Next page token: ${response.data.nextPageToken}`
      : "No more pages.";

    return textResponse(
      `Found ${files.length} files:\n\n${fileList}\n\n${pagination}`,
    );
  }

  private async readFile(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const mimeType = optionalString(args, "mimeType");

    const fileMetadata = await this.drive.files.get({
      fileId,
      fields: "id, name, mimeType, size",
    });

    const file = fileMetadata.data;
    let content = "";

    if (file.mimeType?.startsWith("application/vnd.google-apps.")) {
      const exportMimeType =
        mimeType || EXPORT_FORMATS[file.mimeType] || "text/plain";

      const response = await this.drive.files.export(
        { fileId, mimeType: exportMimeType },
        { responseType: "text" },
      );
      content = response.data as string;
    } else {
      const response = await this.drive.files.get(
        { fileId, alt: "media" },
        { responseType: "text" },
      );
      content = response.data as string;
    }

    return textResponse(
      `File: ${file.name}\nType: ${file.mimeType}\n\nContent:\n${content}`,
    );
  }

  private async searchFiles(args: Record<string, unknown>) {
    const query = requireString(args, "query");
    const pageSize = optionalNumber(args, "pageSize");

    const response = await this.drive.files.list({
      q: `${query} and trashed=false`,
      pageSize: pageSize || 20,
      fields:
        "files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink)",
    });

    const files = response.data.files || [];
    const fileList = files
      .map(
        (file) =>
          `- ${file.name} (ID: ${file.id})\n  Type: ${file.mimeType}\n  Link: ${file.webViewLink}`,
      )
      .join("\n\n");

    return textResponse(
      `Found ${files.length} files:\n\n${fileList || "No files found."}`,
    );
  }

  private async getFileMetadata(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");

    const response = await this.drive.files.get({
      fileId,
      fields: "*",
    });

    return textResponse(
      `File Metadata:\n\n${JSON.stringify(response.data, null, 2)}`,
    );
  }

  private async createFolder(args: Record<string, unknown>) {
    const name = requireString(args, "name");
    const parentId = optionalString(args, "parentId");

    const fileMetadata: drive_v3.Schema$File = {
      name,
      mimeType: MIME_TYPES.FOLDER,
    };

    if (parentId) {
      fileMetadata.parents = [parentId];
    }

    const response = await this.drive.files.create({
      requestBody: fileMetadata,
      fields: "id, name, webViewLink",
    });

    const folder = response.data;
    return textResponse(
      `Folder created successfully!\nName: ${folder.name}\nID: ${folder.id}\nURL: ${folder.webViewLink}`,
    );
  }

  private async uploadFile(args: Record<string, unknown>) {
    const name = requireString(args, "name");
    const content = requireString(args, "content");
    const mimeType = optionalString(args, "mimeType");
    const folderId = optionalString(args, "folderId");

    const fileMetadata: drive_v3.Schema$File = { name };
    if (folderId) {
      fileMetadata.parents = [folderId];
    }

    const response = await this.drive.files.create({
      requestBody: fileMetadata,
      media: { mimeType: mimeType || "text/plain", body: content },
      fields: "id, name, webViewLink",
    });

    const file = response.data;
    return textResponse(
      `File uploaded successfully!\nName: ${file.name}\nID: ${file.id}\nURL: ${file.webViewLink}`,
    );
  }

  private async moveFile(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const destinationFolderId = requireString(args, "destinationFolderId");

    const fileInfo = await this.drive.files.get({
      fileId,
      fields: "id, name, parents, mimeType",
    });

    const file = fileInfo.data;
    const currentParents = file.parents ? file.parents.join(",") : "";

    const response = await this.drive.files.update({
      fileId,
      addParents: destinationFolderId,
      removeParents: currentParents,
      fields: "id, name, parents, webViewLink",
    });

    const movedFile = response.data;
    const itemType = file.mimeType === MIME_TYPES.FOLDER ? "Folder" : "File";
    const location =
      destinationFolderId === "root"
        ? "My Drive (root)"
        : `Folder ID: ${destinationFolderId}`;

    return textResponse(
      `${itemType} moved successfully!\nName: ${movedFile.name}\nID: ${movedFile.id}\nNew location: ${location}\nURL: ${movedFile.webViewLink}`,
    );
  }

  private async trashFile(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");

    const response = await this.drive.files.update({
      fileId,
      requestBody: { trashed: true },
      fields: "id, name, trashed",
    });

    return textResponse(`"${response.data.name}" moved to trash.`);
  }

  private async renameFile(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const newName = requireString(args, "newName");

    const response = await this.drive.files.update({
      fileId,
      requestBody: { name: newName },
      fields: "id, name, webViewLink",
    });

    return textResponse(
      `Renamed to "${response.data.name}"\nID: ${response.data.id}\nURL: ${response.data.webViewLink}`,
    );
  }

  private async copyFile(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const name = optionalString(args, "name");
    const folderId = optionalString(args, "folderId");

    const requestBody: drive_v3.Schema$File = {};
    if (name) requestBody.name = name;
    if (folderId) requestBody.parents = [folderId];

    const response = await this.drive.files.copy({
      fileId,
      requestBody,
      fields: "id, name, webViewLink",
    });

    return textResponse(
      `File copied!\nName: ${response.data.name}\nID: ${response.data.id}\nURL: ${response.data.webViewLink}`,
    );
  }

  private async shareFile(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const role = requireString(args, "role");
    const type = requireString(args, "type");
    const emailAddress = optionalString(args, "emailAddress");

    if ((type === "user" || type === "group") && !emailAddress) {
      throw new Error(`'emailAddress' is required when type is '${type}'`);
    }

    const permission: drive_v3.Schema$Permission = { role, type };
    if (emailAddress) permission.emailAddress = emailAddress;

    await this.drive.permissions.create({
      fileId,
      requestBody: permission,
      sendNotificationEmail: !!emailAddress,
    });

    const target =
      type === "anyone"
        ? "anyone with the link"
        : `${emailAddress} (${type})`;

    return textResponse(`Shared with ${target} as ${role}.`);
  }
}
