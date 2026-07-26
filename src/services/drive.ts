import { google, type drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { Readable } from "node:stream";
import type { Service, ToolDefinition } from "../types.js";
import {
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
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

const DEFAULT_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const HARD_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    /(?:json|xml|javascript|yaml|csv|markdown)(?:;|$)/i.test(mimeType)
  );
}

function bufferFromResponse(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === "string") return Buffer.from(data, "utf8");
  throw new Error("Google Drive returned an unsupported download payload");
}

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
                  "Number of results per page (default: 100, max: 100)",
              },
              pageToken: {
                type: "string",
                description: "Token for pagination",
              },
              driveId: {
                type: "string",
                description:
                  "Optional shared drive ID. When provided, searches that shared drive corpus.",
              },
            },
          },
        },
        handler: (args) => this.listFiles(args),
      },
      ...this.sharedDriveToolDefinitions(),
      ...this.downloadOperationToolDefinitions(),
      ...this.accessProposalToolDefinitions(),
      ...this.approvalToolDefinitions(),
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
              encoding: {
                type: "string",
                enum: ["auto", "text", "base64"],
                description:
                  "Output encoding. 'auto' returns text for textual MIME types and base64 for binary files.",
              },
              maxBytes: {
                type: "number",
                description:
                  "Maximum bytes to return (default 10 MiB, hard maximum 25 MiB)",
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
                description: "Number of results per page (default: 20, max: 100)",
              },
              pageToken: {
                type: "string",
                description: "Token for the next page",
              },
              driveId: {
                type: "string",
                description: "Optional shared drive ID to search",
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
            "Upload text or base64-encoded binary content to Google Drive.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Name for the file in Google Drive",
              },
              content: {
                type: "string",
                description: "UTF-8 text content (use exactly one content field)",
              },
              contentBase64: {
                type: "string",
                description:
                  "Base64-encoded binary content (use exactly one content field)",
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
            required: ["name"],
          },
        },
        handler: (args) => this.uploadFile(args),
      },
      {
        tool: {
          name: "update_file_content",
          description:
            "Replace the content of an existing Drive file with UTF-8 text or base64 binary data.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: { type: "string", description: "The Drive file ID" },
              content: {
                type: "string",
                description: "UTF-8 text content (use exactly one content field)",
              },
              contentBase64: {
                type: "string",
                description:
                  "Base64-encoded binary content (use exactly one content field)",
              },
              mimeType: {
                type: "string",
                description: "Content MIME type (default: existing file type)",
              },
              keepRevisionForever: {
                type: "boolean",
                description: "Keep the new binary revision permanently",
              },
            },
            required: ["fileId"],
          },
        },
        handler: (args) => this.updateFileContent(args),
      },
      {
        tool: {
          name: "download_file",
          description:
            "Download a Drive file or export a Google Workspace file and return lossless base64 data.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: { type: "string", description: "The Drive file ID" },
              mimeType: {
                type: "string",
                description: "Optional export MIME type for a Google Workspace file",
              },
              maxBytes: {
                type: "number",
                description:
                  "Maximum bytes to return (default 10 MiB, hard maximum 25 MiB)",
              },
            },
            required: ["fileId"],
          },
        },
        handler: (args) => this.downloadFile(args),
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
                enum: [
                  "reader",
                  "commenter",
                  "writer",
                  "fileOrganizer",
                  "organizer",
                ],
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
              domain: {
                type: "string",
                description: "Domain name (required for type 'domain')",
              },
              allowFileDiscovery: {
                type: "boolean",
                description:
                  "Whether domain/anyone permissions are discoverable without the link",
              },
              sendNotificationEmail: {
                type: "boolean",
                description:
                  "Send a notification for user/group sharing (default: true)",
              },
              emailMessage: {
                type: "string",
                description: "Optional message included in the sharing notification",
              },
            },
            required: ["fileId", "role", "type"],
          },
        },
        handler: (args) => this.shareFile(args),
      },
      {
        tool: {
          name: "list_permissions",
          description:
            "List permissions on a Drive file or shared drive, with pagination.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: { type: "string", description: "File or shared drive ID" },
              pageSize: {
                type: "number",
                description: "Permissions per page (default: 100, max: 100)",
              },
              pageToken: { type: "string", description: "Next-page token" },
              useDomainAdminAccess: {
                type: "boolean",
                description:
                  "Use domain-admin access when the ID refers to a shared drive",
              },
            },
            required: ["fileId"],
          },
        },
        handler: (args) => this.listPermissions(args),
      },
      {
        tool: {
          name: "update_permission",
          description:
            "Update a Drive permission's role or expiration. Ownership transfer is intentionally not performed by this tool.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: { type: "string", description: "File or shared drive ID" },
              permissionId: { type: "string", description: "Permission ID" },
              role: {
                type: "string",
                enum: [
                  "reader",
                  "commenter",
                  "writer",
                  "fileOrganizer",
                  "organizer",
                ],
                description: "New role",
              },
              expirationTime: {
                type: "string",
                description: "Optional RFC 3339 expiration timestamp",
              },
              removeExpiration: {
                type: "boolean",
                description: "Remove the permission expiration",
              },
              useDomainAdminAccess: {
                type: "boolean",
                description: "Use domain-admin access for a shared drive",
              },
            },
            required: ["fileId", "permissionId"],
          },
        },
        handler: (args) => this.updatePermission(args),
      },
      {
        tool: {
          name: "delete_permission",
          description:
            "Remove a permission from a Drive file or shared drive. Requires confirm=true.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: { type: "string", description: "File or shared drive ID" },
              permissionId: { type: "string", description: "Permission ID" },
              confirm: {
                type: "boolean",
                description: "Must be true to remove access",
              },
              useDomainAdminAccess: {
                type: "boolean",
                description: "Use domain-admin access for a shared drive",
              },
            },
            required: ["fileId", "permissionId", "confirm"],
          },
        },
        handler: (args) => this.deletePermission(args),
      },
      // ── Comments ────────────────────────────────────────
      {
        tool: {
          name: "list_comments",
          description:
            "List all comments on a Google Drive file (Docs, Sheets, Slides, etc.).",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
                description: "The ID of the file",
              },
              includeDeleted: {
                type: "boolean",
                description: "Include deleted comments (default: false)",
              },
              pageSize: {
                type: "number",
                description: "Comments per page (default: 100, max: 100)",
              },
              pageToken: { type: "string", description: "Next-page token" },
            },
            required: ["fileId"],
          },
        },
        handler: (args) => this.listComments(args),
      },
      {
        tool: {
          name: "add_comment",
          description:
            "Add a comment to a Google Drive file. Google Workspace editors display Drive API comments in All Comments; custom anchors are stored but editor apps treat them as unanchored.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
                description: "The ID of the file",
              },
              content: {
                type: "string",
                description: "The comment text",
              },
              quotedContent: {
                type: "string",
                description:
                  "Optional plain-text context returned with the comment; this does not create an editor-native text anchor",
              },
              anchor: {
                type: "string",
                description:
                  "Optional custom anchor JSON string. Drive stores it, but Workspace editor apps treat API-created anchors as unanchored.",
              },
            },
            required: ["fileId", "content"],
          },
        },
        handler: (args) => this.addComment(args),
      },
      {
        tool: {
          name: "reply_to_comment",
          description: "Reply to an existing comment on a file.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
                description: "The ID of the file",
              },
              commentId: {
                type: "string",
                description: "The ID of the comment to reply to",
              },
              content: {
                type: "string",
                description: "The reply text",
              },
            },
            required: ["fileId", "commentId", "content"],
          },
        },
        handler: (args) => this.replyToComment(args),
      },
      {
        tool: {
          name: "resolve_comment",
          description:
            "Resolve or reopen a comment on a file.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
                description: "The ID of the file",
              },
              commentId: {
                type: "string",
                description: "The ID of the comment",
              },
              resolved: {
                type: "boolean",
                description: "true to resolve, false to reopen",
              },
            },
            required: ["fileId", "commentId", "resolved"],
          },
        },
        handler: (args) => this.resolveComment(args),
      },
    ];
  }

  private sharedDriveToolDefinitions(): ToolDefinition[] {
    return [
      {
        tool: {
          name: "list_shared_drives",
          description:
            "List shared drives visible to the current account, with pagination and optional domain-admin access.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Optional shared-drive query" },
              pageSize: {
                type: "number",
                description: "Shared drives per page (default: 100, max: 100)",
              },
              pageToken: { type: "string", description: "Next-page token" },
              useDomainAdminAccess: {
                type: "boolean",
                description: "List all shared drives in the administrator's domain",
              },
            },
          },
        },
        handler: (args) => this.listSharedDrives(args),
      },
      {
        tool: {
          name: "get_shared_drive",
          description: "Get metadata, restrictions, and capabilities for a shared drive.",
          inputSchema: {
            type: "object",
            properties: {
              driveId: { type: "string", description: "The shared drive ID" },
              useDomainAdminAccess: {
                type: "boolean",
                description: "Use domain-admin access",
              },
            },
            required: ["driveId"],
          },
        },
        handler: (args) => this.getSharedDrive(args),
      },
    ];
  }

  private downloadOperationToolDefinitions(): ToolDefinition[] {
    return [
      {
        tool: {
          name: "request_file_download",
          description:
            "Start the Drive API's long-running download operation, useful for large files or a specific revision. The operation remains valid for 24 hours; poll it with get_drive_operation.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: { type: "string", description: "The Drive file ID" },
              mimeType: {
                type: "string",
                description: "Optional export MIME type for Google Workspace files",
              },
              revisionId: {
                type: "string",
                description: "Optional file revision ID",
              },
            },
            required: ["fileId"],
          },
        },
        handler: (args) => this.requestFileDownload(args),
      },
      {
        tool: {
          name: "get_drive_operation",
          description:
            "Poll a Drive long-running operation, including request_file_download operations.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Operation resource name returned by request_file_download",
              },
            },
            required: ["name"],
          },
        },
        handler: (args) => this.getDriveOperation(args),
      },
    ];
  }

  private accessProposalToolDefinitions(): ToolDefinition[] {
    const baseProperties = {
      fileId: { type: "string" as const, description: "The Drive item ID" },
      proposalId: { type: "string" as const, description: "The access proposal ID" },
    };
    return [
      {
        tool: {
          name: "list_access_proposals",
          description:
            "List pending access proposals for a Drive item. Only users allowed to approve access can list them.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: baseProperties.fileId,
              pageSize: {
                type: "number",
                description: "Proposals per page (default: 100, max: 100)",
              },
              pageToken: { type: "string", description: "Next-page token" },
            },
            required: ["fileId"],
          },
        },
        handler: (args) => this.listAccessProposals(args),
      },
      {
        tool: {
          name: "get_access_proposal",
          description: "Get one pending Drive access proposal.",
          inputSchema: {
            type: "object",
            properties: baseProperties,
            required: ["fileId", "proposalId"],
          },
        },
        handler: (args) => this.getAccessProposal(args),
      },
      {
        tool: {
          name: "resolve_access_proposal",
          description:
            "Accept or deny a pending Drive access proposal. Accepting requires one or more granted roles.",
          inputSchema: {
            type: "object",
            properties: {
              ...baseProperties,
              action: {
                type: "string",
                enum: ["ACCEPT", "DENY"],
                description: "Resolution action",
              },
              roles: {
                type: "array",
                items: { type: "string", enum: ["reader", "commenter", "writer"] },
                description: "Roles to grant when accepting",
              },
              sendNotification: {
                type: "boolean",
                description: "Notify the requester (default: true)",
              },
              view: {
                type: "string",
                enum: ["published"],
                description: "Only set for a proposal belonging to the published view",
              },
            },
            required: ["fileId", "proposalId", "action"],
          },
        },
        handler: (args) => this.resolveAccessProposal(args),
      },
    ];
  }

  private approvalToolDefinitions(): ToolDefinition[] {
    const identifiers = {
      fileId: { type: "string" as const, description: "The Drive file ID" },
      approvalId: { type: "string" as const, description: "The approval ID" },
    };
    const message = {
      type: "string" as const,
      description: "Optional message included in notifications and the activity log",
    };
    const approvalAction = (
      name: string,
      description: string,
      action: "approve" | "decline" | "cancel",
    ): ToolDefinition => ({
      tool: {
        name,
        description,
        inputSchema: {
          type: "object",
          properties: { ...identifiers, message },
          required: ["fileId", "approvalId"],
        },
      },
      handler: (args) => this.respondToApproval(args, action),
    });

    return [
      {
        tool: {
          name: "list_approvals",
          description: "List approval workflows on a Drive file.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: identifiers.fileId,
              pageSize: {
                type: "number",
                description: "Approvals per page (default: 100, max: 100)",
              },
              pageToken: { type: "string", description: "Next-page token" },
            },
            required: ["fileId"],
          },
        },
        handler: (args) => this.listApprovals(args),
      },
      {
        tool: {
          name: "get_approval",
          description: "Get one approval workflow on a Drive file.",
          inputSchema: {
            type: "object",
            properties: identifiers,
            required: ["fileId", "approvalId"],
          },
        },
        handler: (args) => this.getApproval(args),
      },
      {
        tool: {
          name: "start_approval",
          description:
            "Start an approval workflow on a Drive file and notify reviewers.",
          inputSchema: {
            type: "object",
            properties: {
              fileId: identifiers.fileId,
              reviewerEmails: {
                type: "array",
                items: { type: "string" },
                description: "One or more reviewer email addresses",
              },
              dueTime: { type: "string", description: "Optional RFC 3339 due time" },
              lockFile: {
                type: "boolean",
                description: "Lock the file while approval is in progress",
              },
              message,
            },
            required: ["fileId", "reviewerEmails"],
          },
        },
        handler: (args) => this.startApproval(args),
      },
      approvalAction(
        "approve_approval",
        "Approve a Drive approval assigned to the current user.",
        "approve",
      ),
      approvalAction(
        "decline_approval",
        "Decline a Drive approval assigned to the current user.",
        "decline",
      ),
      approvalAction(
        "cancel_approval",
        "Cancel an in-progress Drive approval.",
        "cancel",
      ),
      {
        tool: {
          name: "comment_on_approval",
          description: "Add a comment to a Drive approval and notify participants.",
          inputSchema: {
            type: "object",
            properties: {
              ...identifiers,
              message: {
                type: "string",
                description: "Required approval comment",
              },
            },
            required: ["fileId", "approvalId", "message"],
          },
        },
        handler: (args) => this.commentOnApproval(args),
      },
      {
        tool: {
          name: "reassign_approval",
          description:
            "Add reviewers or replace reviewers who have not responded to an in-progress Drive approval.",
          inputSchema: {
            type: "object",
            properties: {
              ...identifiers,
              addReviewerEmails: {
                type: "array",
                items: { type: "string" },
                description: "Reviewer email addresses to add",
              },
              replaceReviewers: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    removedReviewerEmail: { type: "string" },
                    addedReviewerEmail: { type: "string" },
                  },
                  required: ["removedReviewerEmail", "addedReviewerEmail"],
                },
                description: "Reviewer replacements",
              },
              message,
            },
            required: ["fileId", "approvalId"],
          },
        },
        handler: (args) => this.reassignApproval(args),
      },
    ];
  }

  private pageSize(args: Record<string, unknown>, fallback: number): number {
    const value = optionalNumber(args, "pageSize") ?? fallback;
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new Error("'pageSize' must be an integer between 1 and 100");
    }
    return value;
  }

  private maxDownloadBytes(args: Record<string, unknown>): number {
    const value = optionalNumber(args, "maxBytes") ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > HARD_MAX_DOWNLOAD_BYTES
    ) {
      throw new Error(
        `'maxBytes' must be an integer between 1 and ${HARD_MAX_DOWNLOAD_BYTES}`,
      );
    }
    return value;
  }

  private decodeUploadContent(args: Record<string, unknown>): Buffer {
    const content = args.content;
    const contentBase64 = args.contentBase64;
    const hasText = content !== undefined && content !== null;
    const hasBase64 = contentBase64 !== undefined && contentBase64 !== null;
    if (hasText === hasBase64) {
      throw new Error("Provide exactly one of 'content' or 'contentBase64'");
    }
    if (hasText) {
      if (typeof content !== "string") throw new Error("'content' must be a string");
      return Buffer.from(content, "utf8");
    }
    if (typeof contentBase64 !== "string" || contentBase64.length === 0) {
      throw new Error("'contentBase64' must be a non-empty base64 string");
    }
    const normalized = contentBase64.replace(/\s/g, "");
    if (
      normalized.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
    ) {
      throw new Error("'contentBase64' is not valid base64");
    }
    return Buffer.from(normalized, "base64");
  }

  private validateMimeType(mimeType: string): string {
    if (!/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;[^\r\n]*)?$/.test(mimeType)) {
      throw new Error(`Invalid MIME type: ${mimeType}`);
    }
    return mimeType;
  }

  private async downloadBytes(
    fileId: string,
    requestedMimeType?: string,
    maxBytes = HARD_MAX_DOWNLOAD_BYTES,
  ) {
    sanitizeDriveId(fileId);
    if (requestedMimeType) this.validateMimeType(requestedMimeType);
    const metadata = await this.drive.files.get({
      fileId,
      fields: "id,name,mimeType,size,md5Checksum,modifiedTime",
      supportsAllDrives: true,
    });
    const file = metadata.data;
    if (file.mimeType === MIME_TYPES.FOLDER) {
      throw new Error("Folders do not have downloadable content");
    }
    if (file.size && Number(file.size) > maxBytes) {
      throw new Error(
        `File metadata reports ${file.size} bytes, exceeding maxBytes=${maxBytes}.`,
      );
    }

    let mimeType = requestedMimeType || file.mimeType || "application/octet-stream";
    let data: unknown;
    if (file.mimeType?.startsWith("application/vnd.google-apps.")) {
      mimeType = requestedMimeType || EXPORT_FORMATS[file.mimeType] || "";
      if (!mimeType) {
        throw new Error(
          `No default export format is known for '${file.mimeType}'. Provide 'mimeType'.`,
        );
      }
      const response = await this.drive.files.export(
        { fileId, mimeType },
        { responseType: "arraybuffer" },
      );
      data = response.data;
    } else {
      const response = await this.drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" },
      );
      data = response.data;
    }
    const bytes = bufferFromResponse(data);
    if (bytes.length > maxBytes) {
      throw new Error(
        `Downloaded content is ${bytes.length} bytes, exceeding maxBytes=${maxBytes}.`,
      );
    }
    return { file, mimeType, bytes };
  }

  private stringArray(
    args: Record<string, unknown>,
    field: string,
    required = false,
  ): string[] | undefined {
    const value = args[field];
    if (value === undefined || value === null) {
      if (required) throw new Error(`'${field}' is required`);
      return undefined;
    }
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((item) => typeof item !== "string" || item.trim() === "")
    ) {
      throw new Error(`'${field}' must be a non-empty array of non-empty strings`);
    }
    return value;
  }

  private validateEmails(emails: string[], field: string): string[] {
    if (emails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      throw new Error(`'${field}' contains an invalid email address`);
    }
    return emails;
  }

  private async listSharedDrives(args: Record<string, unknown>) {
    const response = await this.drive.drives.list({
      q: optionalString(args, "query"),
      pageSize: this.pageSize(args, 100),
      pageToken: optionalString(args, "pageToken"),
      useDomainAdminAccess: optionalBoolean(args, "useDomainAdminAccess"),
      fields:
        "nextPageToken,drives(id,name,createdTime,hidden,colorRgb,orgUnitId,restrictions,capabilities)",
    });
    const drives = response.data.drives || [];
    return textResponse(
      `Shared drives (${drives.length}):\n${JSON.stringify(drives, null, 2)}\n\n${response.data.nextPageToken ? `Next page token: ${response.data.nextPageToken}` : "No more pages."}`,
    );
  }

  private async getSharedDrive(args: Record<string, unknown>) {
    const driveId = requireString(args, "driveId");
    sanitizeDriveId(driveId);
    const response = await this.drive.drives.get({
      driveId,
      useDomainAdminAccess: optionalBoolean(args, "useDomainAdminAccess"),
      fields: "*",
    });
    return textResponse(`Shared drive:\n${JSON.stringify(response.data, null, 2)}`);
  }

  private async requestFileDownload(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const mimeType = optionalString(args, "mimeType");
    const revisionId = optionalString(args, "revisionId");
    sanitizeDriveId(fileId);
    if (mimeType) this.validateMimeType(mimeType);
    const response = await this.drive.files.download({
      fileId,
      mimeType,
      revisionId,
    });
    return textResponse(
      `Download operation (valid for 24 hours):\n${JSON.stringify(response.data, null, 2)}`,
    );
  }

  private async getDriveOperation(args: Record<string, unknown>) {
    const name = requireString(args, "name");
    if (!/^[A-Za-z0-9._/-]*operations\/[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error("'name' must be a Drive operation resource name");
    }
    const response = await this.drive.operations.get({ name });
    return textResponse(`Drive operation:\n${JSON.stringify(response.data, null, 2)}`);
  }

  private async listAccessProposals(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    sanitizeDriveId(fileId);
    const response = await this.drive.accessproposals.list({
      fileId,
      pageSize: this.pageSize(args, 100),
      pageToken: optionalString(args, "pageToken"),
    });
    const proposals = response.data.accessProposals || [];
    return textResponse(
      `Access proposals (${proposals.length}):\n${JSON.stringify(proposals, null, 2)}\n\n${response.data.nextPageToken ? `Next page token: ${response.data.nextPageToken}` : "No more pages."}`,
    );
  }

  private async getAccessProposal(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const proposalId = requireString(args, "proposalId");
    sanitizeDriveId(fileId);
    const response = await this.drive.accessproposals.get({ fileId, proposalId });
    return textResponse(`Access proposal:\n${JSON.stringify(response.data, null, 2)}`);
  }

  private async resolveAccessProposal(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const proposalId = requireString(args, "proposalId");
    const action = requireString(args, "action");
    const roles = this.stringArray(args, "roles");
    const view = optionalString(args, "view");
    sanitizeDriveId(fileId);
    if (!["ACCEPT", "DENY"].includes(action)) {
      throw new Error("'action' must be ACCEPT or DENY");
    }
    if (action === "ACCEPT" && !roles) {
      throw new Error("'roles' is required when accepting an access proposal");
    }
    if (action === "DENY" && roles) {
      throw new Error("'roles' must be omitted when denying an access proposal");
    }
    if (roles?.some((role) => !["reader", "commenter", "writer"].includes(role))) {
      throw new Error("Access proposal roles must be reader, commenter, or writer");
    }
    if (view !== undefined && view !== "published") {
      throw new Error("The only supported access-proposal view is 'published'");
    }
    await this.drive.accessproposals.resolve({
      fileId,
      proposalId,
      requestBody: {
        action,
        role: roles,
        sendNotification: optionalBoolean(args, "sendNotification") ?? true,
        view,
      },
    });
    return textResponse(
      `Access proposal ${proposalId} ${action === "ACCEPT" ? "accepted" : "denied"}.`,
    );
  }

  private async listApprovals(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    sanitizeDriveId(fileId);
    const response = await this.drive.approvals.list({
      fileId,
      pageSize: this.pageSize(args, 100),
      pageToken: optionalString(args, "pageToken"),
    });
    const approvals = response.data.items || [];
    return textResponse(
      `Approvals (${approvals.length}):\n${JSON.stringify(approvals, null, 2)}\n\n${response.data.nextPageToken ? `Next page token: ${response.data.nextPageToken}` : "No more pages."}`,
    );
  }

  private async getApproval(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const approvalId = requireString(args, "approvalId");
    sanitizeDriveId(fileId);
    const response = await this.drive.approvals.get({ fileId, approvalId });
    return textResponse(`Approval:\n${JSON.stringify(response.data, null, 2)}`);
  }

  private async startApproval(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    sanitizeDriveId(fileId);
    const reviewerEmails = this.validateEmails(
      this.stringArray(args, "reviewerEmails", true)!,
      "reviewerEmails",
    );
    const dueTime = optionalString(args, "dueTime");
    if (dueTime && Number.isNaN(Date.parse(dueTime))) {
      throw new Error("'dueTime' must be an RFC 3339 timestamp");
    }
    const response = await this.drive.approvals.start({
      fileId,
      requestBody: {
        reviewerEmails,
        dueTime,
        lockFile: optionalBoolean(args, "lockFile"),
        message: optionalString(args, "message"),
      },
    });
    return textResponse(`Approval started:\n${JSON.stringify(response.data, null, 2)}`);
  }

  private async respondToApproval(
    args: Record<string, unknown>,
    action: "approve" | "decline" | "cancel",
  ) {
    const fileId = requireString(args, "fileId");
    const approvalId = requireString(args, "approvalId");
    const requestBody = { message: optionalString(args, "message") };
    sanitizeDriveId(fileId);
    let response;
    if (action === "approve") {
      response = await this.drive.approvals.approve({ fileId, approvalId, requestBody });
    } else if (action === "decline") {
      response = await this.drive.approvals.decline({ fileId, approvalId, requestBody });
    } else {
      response = await this.drive.approvals.cancel({ fileId, approvalId, requestBody });
    }
    return textResponse(
      `Approval ${action} completed:\n${JSON.stringify(response.data, null, 2)}`,
    );
  }

  private async commentOnApproval(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const approvalId = requireString(args, "approvalId");
    const message = requireString(args, "message");
    sanitizeDriveId(fileId);
    const response = await this.drive.approvals.comment({
      fileId,
      approvalId,
      requestBody: { message },
    });
    return textResponse(`Approval updated:\n${JSON.stringify(response.data, null, 2)}`);
  }

  private async reassignApproval(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const approvalId = requireString(args, "approvalId");
    sanitizeDriveId(fileId);
    const addedEmails = this.stringArray(args, "addReviewerEmails");
    const addReviewers = addedEmails
      ? this.validateEmails(addedEmails, "addReviewerEmails").map(
          (addedReviewerEmail) => ({ addedReviewerEmail }),
        )
      : undefined;
    const replacementsValue = args.replaceReviewers;
    let replaceReviewers: drive_v3.Schema$ReplaceReviewer[] | undefined;
    if (replacementsValue !== undefined) {
      if (!Array.isArray(replacementsValue) || replacementsValue.length === 0) {
        throw new Error("'replaceReviewers' must be a non-empty array");
      }
      replaceReviewers = replacementsValue.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("Every reviewer replacement must be an object");
        }
        const replacement = value as Record<string, unknown>;
        const removedReviewerEmail = replacement.removedReviewerEmail;
        const addedReviewerEmail = replacement.addedReviewerEmail;
        if (
          typeof removedReviewerEmail !== "string" ||
          typeof addedReviewerEmail !== "string"
        ) {
          throw new Error(
            "Reviewer replacements require removedReviewerEmail and addedReviewerEmail",
          );
        }
        this.validateEmails(
          [removedReviewerEmail, addedReviewerEmail],
          "replaceReviewers",
        );
        return { removedReviewerEmail, addedReviewerEmail };
      });
    }
    if (!addReviewers && !replaceReviewers) {
      throw new Error(
        "Provide 'addReviewerEmails' or 'replaceReviewers' when reassigning",
      );
    }
    const response = await this.drive.approvals.reassign({
      fileId,
      approvalId,
      requestBody: {
        addReviewers,
        replaceReviewers,
        message: optionalString(args, "message"),
      },
    });
    return textResponse(`Approval reassigned:\n${JSON.stringify(response.data, null, 2)}`);
  }

  private async listFiles(args: Record<string, unknown>) {
    const folderId = optionalString(args, "folderId");
    const query = optionalString(args, "query");
    const pageSize = this.pageSize(args, 100);
    const pageToken = optionalString(args, "pageToken");
    const driveId = optionalString(args, "driveId");
    if (driveId) sanitizeDriveId(driveId);

    let q = query || "";
    if (folderId) {
      sanitizeDriveId(folderId);
      q = q
        ? `${q} and '${folderId}' in parents`
        : `'${folderId}' in parents`;
    }
    if (!q) {
      q = `'${driveId || "root"}' in parents`;
    }
    q += " and trashed=false";

    const response = await this.drive.files.list({
      q,
      pageSize,
      pageToken: pageToken || undefined,
      driveId,
      corpora: driveId ? "drive" : "user",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
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
    const encoding = optionalString(args, "encoding") || "auto";
    if (!["auto", "text", "base64"].includes(encoding)) {
      throw new Error("'encoding' must be auto, text, or base64");
    }
    const maxBytes = this.maxDownloadBytes(args);
    const downloaded = await this.downloadBytes(fileId, mimeType, maxBytes);
    const outputEncoding =
      encoding === "auto"
        ? isTextMimeType(downloaded.mimeType)
          ? "text"
          : "base64"
        : encoding;
    const content =
      outputEncoding === "text"
        ? downloaded.bytes.toString("utf8")
        : downloaded.bytes.toString("base64");
    return textResponse(
      `File: ${downloaded.file.name}\nSource type: ${downloaded.file.mimeType}\nContent type: ${downloaded.mimeType}\nEncoding: ${outputEncoding}\nBytes: ${downloaded.bytes.length}\n\nContent:\n${content}`,
    );
  }

  private async searchFiles(args: Record<string, unknown>) {
    const query = requireString(args, "query");
    const pageSize = this.pageSize(args, 20);
    const pageToken = optionalString(args, "pageToken");
    const driveId = optionalString(args, "driveId");
    if (driveId) sanitizeDriveId(driveId);

    const response = await this.drive.files.list({
      q: `${query} and trashed=false`,
      pageSize,
      pageToken,
      driveId,
      corpora: driveId ? "drive" : "user",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields:
        "nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink)",
    });

    const files = response.data.files || [];
    const fileList = files
      .map(
        (file) =>
          `- ${file.name} (ID: ${file.id})\n  Type: ${file.mimeType}\n  Link: ${file.webViewLink}`,
      )
      .join("\n\n");

    const pagination = response.data.nextPageToken
      ? `Next page token: ${response.data.nextPageToken}`
      : "No more pages.";
    return textResponse(
      `Found ${files.length} files:\n\n${fileList || "No files found."}\n\n${pagination}`,
    );
  }

  private async getFileMetadata(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    sanitizeDriveId(fileId);

    const response = await this.drive.files.get({
      fileId,
      fields: "*",
      supportsAllDrives: true,
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
      sanitizeDriveId(parentId);
      fileMetadata.parents = [parentId];
    }

    const response = await this.drive.files.create({
      requestBody: fileMetadata,
      fields: "id, name, webViewLink",
      supportsAllDrives: true,
    });

    const folder = response.data;
    return textResponse(
      `Folder created successfully!\nName: ${folder.name}\nID: ${folder.id}\nURL: ${folder.webViewLink}`,
    );
  }

  private async uploadFile(args: Record<string, unknown>) {
    const name = requireString(args, "name");
    const bytes = this.decodeUploadContent(args);
    const mimeType = this.validateMimeType(
      optionalString(args, "mimeType") || "text/plain",
    );
    const folderId = optionalString(args, "folderId");

    const fileMetadata: drive_v3.Schema$File = { name };
    if (folderId) {
      sanitizeDriveId(folderId);
      fileMetadata.parents = [folderId];
    }

    const response = await this.drive.files.create({
      requestBody: fileMetadata,
      media: { mimeType, body: Readable.from(bytes) },
      fields: "id, name, mimeType, size, webViewLink",
      supportsAllDrives: true,
    });

    const file = response.data;
    return textResponse(
      `File uploaded successfully!\nName: ${file.name}\nID: ${file.id}\nURL: ${file.webViewLink}`,
    );
  }

  private async updateFileContent(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    sanitizeDriveId(fileId);
    const bytes = this.decodeUploadContent(args);
    const existing = await this.drive.files.get({
      fileId,
      fields: "mimeType",
      supportsAllDrives: true,
    });
    if (existing.data.mimeType?.startsWith("application/vnd.google-apps.")) {
      throw new Error(
        "Native Google Workspace files must be updated with their Docs, Sheets, or Slides tools, not binary media replacement",
      );
    }
    const mimeType =
      optionalString(args, "mimeType") ||
      existing.data.mimeType ||
      "application/octet-stream";
    this.validateMimeType(mimeType);
    const response = await this.drive.files.update({
      fileId,
      media: { mimeType, body: Readable.from(bytes) },
      keepRevisionForever: optionalBoolean(args, "keepRevisionForever"),
      fields: "id,name,mimeType,size,modifiedTime,webViewLink",
      supportsAllDrives: true,
    });
    return textResponse(
      `Updated ${response.data.name || fileId} with ${bytes.length} bytes.\nURL: ${response.data.webViewLink || "not returned"}`,
    );
  }

  private async downloadFile(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const mimeType = optionalString(args, "mimeType");
    const maxBytes = this.maxDownloadBytes(args);
    const downloaded = await this.downloadBytes(fileId, mimeType, maxBytes);
    return textResponse(
      `File: ${downloaded.file.name}\nContent type: ${downloaded.mimeType}\nEncoding: base64\nBytes: ${downloaded.bytes.length}\nMD5: ${downloaded.file.md5Checksum || "not available"}\n\nContent:\n${downloaded.bytes.toString("base64")}`,
    );
  }

  private async moveFile(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const destinationFolderId = requireString(args, "destinationFolderId");
    sanitizeDriveId(fileId);
    sanitizeDriveId(destinationFolderId);

    const fileInfo = await this.drive.files.get({
      fileId,
      fields: "id, name, parents, mimeType",
      supportsAllDrives: true,
    });

    const file = fileInfo.data;
    const currentParents = file.parents ? file.parents.join(",") : "";

    const response = await this.drive.files.update({
      fileId,
      addParents: destinationFolderId,
      removeParents: currentParents || undefined,
      fields: "id, name, parents, webViewLink",
      supportsAllDrives: true,
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
    sanitizeDriveId(fileId);

    const response = await this.drive.files.update({
      fileId,
      requestBody: { trashed: true },
      fields: "id, name, trashed",
      supportsAllDrives: true,
    });

    return textResponse(`"${response.data.name}" moved to trash.`);
  }

  private async renameFile(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const newName = requireString(args, "newName");
    sanitizeDriveId(fileId);

    const response = await this.drive.files.update({
      fileId,
      requestBody: { name: newName },
      fields: "id, name, webViewLink",
      supportsAllDrives: true,
    });

    return textResponse(
      `Renamed to "${response.data.name}"\nID: ${response.data.id}\nURL: ${response.data.webViewLink}`,
    );
  }

  private async copyFile(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const name = optionalString(args, "name");
    const folderId = optionalString(args, "folderId");
    sanitizeDriveId(fileId);

    const requestBody: drive_v3.Schema$File = {};
    if (name) requestBody.name = name;
    if (folderId) {
      sanitizeDriveId(folderId);
      requestBody.parents = [folderId];
    }

    const response = await this.drive.files.copy({
      fileId,
      requestBody,
      fields: "id, name, webViewLink",
      supportsAllDrives: true,
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
    const domain = optionalString(args, "domain");
    const allowFileDiscovery = optionalBoolean(args, "allowFileDiscovery");
    const sendNotificationEmail = optionalBoolean(args, "sendNotificationEmail");
    const emailMessage = optionalString(args, "emailMessage");
    sanitizeDriveId(fileId);

    if (
      !["reader", "commenter", "writer", "fileOrganizer", "organizer"].includes(
        role,
      )
    ) {
      throw new Error("Unsupported permission role");
    }
    if (!["user", "group", "domain", "anyone"].includes(type)) {
      throw new Error("Unsupported permission type");
    }

    if ((type === "user" || type === "group") && !emailAddress) {
      throw new Error(`'emailAddress' is required when type is '${type}'`);
    }
    if (type === "domain" && !domain) {
      throw new Error("'domain' is required when type is 'domain'");
    }
    if (allowFileDiscovery !== undefined && !["domain", "anyone"].includes(type)) {
      throw new Error(
        "'allowFileDiscovery' is only valid for domain or anyone permissions",
      );
    }
    if (emailMessage && !["user", "group"].includes(type)) {
      throw new Error("'emailMessage' is only valid for user or group sharing");
    }

    const permission: drive_v3.Schema$Permission = { role, type };
    if (type === "user" || type === "group") permission.emailAddress = emailAddress;
    if (type === "domain") permission.domain = domain;
    if (allowFileDiscovery !== undefined) {
      permission.allowFileDiscovery = allowFileDiscovery;
    }

    const response = await this.drive.permissions.create({
      fileId,
      requestBody: permission,
      sendNotificationEmail:
        type === "user" || type === "group"
          ? sendNotificationEmail ?? true
          : false,
      emailMessage,
      fields: "id,type,role,emailAddress,domain,allowFileDiscovery,expirationTime",
      supportsAllDrives: true,
    });

    const target =
      type === "anyone"
        ? "anyone with the link"
        : type === "domain"
          ? `${domain} (domain)`
          : `${emailAddress} (${type})`;

    return textResponse(
      `Shared with ${target} as ${role}.\nPermission ID: ${response.data.id || "not returned"}`,
    );
  }

  private async listPermissions(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    sanitizeDriveId(fileId);
    const response = await this.drive.permissions.list({
      fileId,
      pageSize: this.pageSize(args, 100),
      pageToken: optionalString(args, "pageToken"),
      useDomainAdminAccess: optionalBoolean(args, "useDomainAdminAccess"),
      supportsAllDrives: true,
      fields:
        "nextPageToken,permissions(id,type,role,emailAddress,displayName,domain,allowFileDiscovery,expirationTime,deleted,pendingOwner,permissionDetails)",
    });
    const permissions = response.data.permissions || [];
    return textResponse(
      `Permissions (${permissions.length}):\n${JSON.stringify(permissions, null, 2)}\n\n${response.data.nextPageToken ? `Next page token: ${response.data.nextPageToken}` : "No more pages."}`,
    );
  }

  private async updatePermission(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const permissionId = requireString(args, "permissionId");
    const role = optionalString(args, "role");
    const expirationTime = optionalString(args, "expirationTime");
    const removeExpiration = optionalBoolean(args, "removeExpiration") ?? false;
    sanitizeDriveId(fileId);
    sanitizeDriveId(permissionId);
    if (
      role &&
      !["reader", "commenter", "writer", "fileOrganizer", "organizer"].includes(
        role,
      )
    ) {
      throw new Error("Unsupported permission role");
    }
    if (expirationTime) {
      const expiration = Date.parse(expirationTime);
      const now = Date.now();
      if (Number.isNaN(expiration)) {
        throw new Error("'expirationTime' must be an RFC 3339 timestamp");
      }
      if (expiration <= now || expiration > now + 366 * 24 * 60 * 60 * 1000) {
        throw new Error(
          "'expirationTime' must be in the future and no more than one year away",
        );
      }
    }
    if (expirationTime && removeExpiration) {
      throw new Error("Use 'expirationTime' or 'removeExpiration', not both");
    }
    if (!role && !expirationTime && !removeExpiration) {
      throw new Error(
        "Provide at least one of 'role', 'expirationTime', or 'removeExpiration'",
      );
    }
    const response = await this.drive.permissions.update({
      fileId,
      permissionId,
      requestBody: { role, expirationTime },
      removeExpiration,
      useDomainAdminAccess: optionalBoolean(args, "useDomainAdminAccess"),
      supportsAllDrives: true,
      fields:
        "id,type,role,emailAddress,displayName,domain,allowFileDiscovery,expirationTime",
    });
    return textResponse(
      `Permission ${permissionId} updated:\n${JSON.stringify(response.data, null, 2)}`,
    );
  }

  private async deletePermission(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const permissionId = requireString(args, "permissionId");
    sanitizeDriveId(fileId);
    sanitizeDriveId(permissionId);
    if (args.confirm !== true) {
      throw new Error("'confirm' must be true to remove a permission");
    }
    await this.drive.permissions.delete({
      fileId,
      permissionId,
      useDomainAdminAccess: optionalBoolean(args, "useDomainAdminAccess"),
      supportsAllDrives: true,
    });
    return textResponse(`Permission ${permissionId} removed from ${fileId}.`);
  }

  // ── Comments ────────────────────────────────────────────

  private async listComments(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const includeDeleted = args.includeDeleted === true;
    sanitizeDriveId(fileId);

    const response = await this.drive.comments.list({
      fileId,
      fields: "nextPageToken,comments(id,content,author(displayName,emailAddress),createdTime,modifiedTime,resolved,quotedFileContent,replies(id,content,action,author(displayName),createdTime))",
      includeDeleted,
      pageSize: this.pageSize(args, 100),
      pageToken: optionalString(args, "pageToken"),
    });

    const comments = response.data.comments || [];
    if (comments.length === 0) {
      return textResponse(
        `No comments on this page.${response.data.nextPageToken ? `\nNext page token: ${response.data.nextPageToken}` : ""}`,
      );
    }

    const lines = comments.map((c) => {
      const parts = [
        `- [${c.resolved ? "RESOLVED" : "OPEN"}] ${c.author?.displayName || "Unknown"} (${c.createdTime})`,
        `  ID: ${c.id}`,
        `  ${c.content}`,
      ];
      if (c.quotedFileContent?.value) {
        parts.push(`  Quoted: "${c.quotedFileContent.value}"`);
      }
      if (c.replies?.length) {
        for (const r of c.replies) {
          parts.push(`    ↳ ${r.author?.displayName}: ${r.content}`);
        }
      }
      return parts.join("\n");
    });

    return textResponse(
      `${comments.length} comment(s):\n\n${lines.join("\n\n")}\n\n${response.data.nextPageToken ? `Next page token: ${response.data.nextPageToken}` : "No more pages."}`,
    );
  }

  private async addComment(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const content = requireString(args, "content");
    const quotedContent = optionalString(args, "quotedContent");
    const anchor = optionalString(args, "anchor");
    sanitizeDriveId(fileId);

    const requestBody: drive_v3.Schema$Comment = { content };
    if (quotedContent) {
      requestBody.quotedFileContent = {
        value: quotedContent,
        mimeType: "text/plain",
      };
    }
    if (anchor !== undefined) {
      try {
        const parsed = JSON.parse(anchor) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
      } catch {
        throw new Error("'anchor' must be a JSON string containing an object");
      }
      requestBody.anchor = anchor;
    }

    const response = await this.drive.comments.create({
      fileId,
      requestBody,
      fields: "id,content,author(displayName),createdTime,quotedFileContent",
    });

    const c = response.data;
    let result = `Comment added!\nID: ${c.id}\nBy: ${c.author?.displayName}\n"${c.content}"`;
    if (c.quotedFileContent?.value) {
      result += `\nAnchored to: "${c.quotedFileContent.value}"`;
    }
    return textResponse(result);
  }

  private async replyToComment(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const commentId = requireString(args, "commentId");
    const content = requireString(args, "content");
    sanitizeDriveId(fileId);

    const response = await this.drive.replies.create({
      fileId,
      commentId,
      requestBody: { content },
      fields: "id,content,author(displayName),createdTime",
    });

    return textResponse(
      `Reply added!\nID: ${response.data.id}\nBy: ${response.data.author?.displayName}\n"${response.data.content}"`,
    );
  }

  private async resolveComment(args: Record<string, unknown>) {
    const fileId = requireString(args, "fileId");
    const commentId = requireString(args, "commentId");
    if (typeof args.resolved !== "boolean") {
      throw new Error("'resolved' is required and must be a boolean");
    }
    const resolved = args.resolved;
    sanitizeDriveId(fileId);

    await this.drive.replies.create({
      fileId,
      commentId,
      requestBody: { action: resolved ? "resolve" : "reopen" },
      fields: "id,action,createdTime",
    });

    return textResponse(
      `Comment ${commentId} ${resolved ? "resolved" : "reopened"}.`,
    );
  }
}
