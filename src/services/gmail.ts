import { google, type gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Service, ToolDefinition } from "../types.js";
import {
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  textResponse,
} from "../utils.js";

// ── Helpers ──────────────────────────────────────────────────

function decodeBody(data: string | undefined | null): string {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf-8");
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function extractText(payload: gmail_v1.Schema$MessagePart): string {
  if (payload.body?.data) {
    return decodeBody(payload.body.data);
  }
  if (payload.parts) {
    // Prefer text/plain, fall back to text/html
    const plain = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) return decodeBody(plain.body.data);
    const html = payload.parts.find((p) => p.mimeType === "text/html");
    if (html?.body?.data) return decodeBody(html.body.data);
    // Recurse into multipart
    for (const part of payload.parts) {
      const text = extractText(part);
      if (text) return text;
    }
  }
  return "";
}

function extractAttachments(
  payload: gmail_v1.Schema$MessagePart,
): Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> {
  const attachments: Array<{
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string;
  }> = [];

  function walk(part: gmail_v1.Schema$MessagePart) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) part.parts.forEach(walk);
  }

  walk(payload);
  return attachments;
}

function fmtMessage(msg: gmail_v1.Schema$Message, full = false): string {
  const h = msg.payload?.headers;
  const lines = [
    `- From: ${getHeader(h, "From")}`,
    `  Subject: ${getHeader(h, "Subject")}`,
    `  Date: ${getHeader(h, "Date")}`,
    `  ID: ${msg.id}  Thread: ${msg.threadId}`,
  ];
  if (msg.labelIds?.length) {
    lines.push(`  Labels: ${msg.labelIds.join(", ")}`);
  }
  if (full && msg.payload) {
    const body = extractText(msg.payload);
    if (body) {
      lines.push(`  ---`);
      lines.push(body.length > 5000 ? body.slice(0, 5000) + "\n...(truncated)" : body);
    }
    const attachments = extractAttachments(msg.payload);
    if (attachments.length) {
      lines.push(`  Attachments:`);
      for (const a of attachments) {
        lines.push(`    - ${a.filename} (${a.mimeType}, ${a.size} bytes, attachmentId: ${a.attachmentId})`);
      }
    }
  }
  return lines.join("\n");
}

function buildRawMessage(opts: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  isHtml?: boolean;
}): string {
  const contentType = opts.isHtml ? "text/html" : "text/plain";

  const headers = [
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${contentType}; charset="UTF-8"`,
  ];
  if (opts.cc) headers.push(`Cc: ${opts.cc}`);
  if (opts.bcc) headers.push(`Bcc: ${opts.bcc}`);
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`);
    headers.push(`References: ${opts.references || opts.inReplyTo}`);
  }

  const raw = headers.join("\r\n") + "\r\n\r\n" + opts.body;
  return Buffer.from(raw).toString("base64url");
}

// ── Service ──────────────────────────────────────────────────

export class GmailService implements Service {
  private gmail!: gmail_v1.Gmail;

  initialize(auth: OAuth2Client): void {
    this.gmail = google.gmail({ version: "v1", auth });
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      // ── Email operations ──────────────────────────────
      {
        tool: {
          name: "search_emails",
          description:
            "Search emails using Gmail query syntax. Examples: 'from:boss@company.com', 'subject:meeting has:attachment', 'is:unread after:2025/01/01', 'in:inbox -category:promotions'.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Gmail search query (same syntax as Gmail search bar)",
              },
              maxResults: {
                type: "number",
                description: "Max messages to return (default: 20, max: 500)",
              },
              labelIds: {
                type: "array",
                items: { type: "string" },
                description:
                  "Filter by label IDs (e.g., ['INBOX', 'UNREAD'])",
              },
            },
            required: ["query"],
          },
        },
        handler: (a) => this.searchEmails(a),
      },
      {
        tool: {
          name: "read_email",
          description:
            "Read the full content of an email by its message ID, including body text, headers, and attachment info.",
          inputSchema: {
            type: "object",
            properties: {
              messageId: {
                type: "string",
                description: "The message ID (from search_emails or list_threads)",
              },
            },
            required: ["messageId"],
          },
        },
        handler: (a) => this.readEmail(a),
      },
      {
        tool: {
          name: "send_email",
          description:
            "Send a new email. Supports plain text or HTML body, CC, and BCC.",
          inputSchema: {
            type: "object",
            properties: {
              to: {
                type: "string",
                description:
                  "Recipient email(s), comma-separated for multiple",
              },
              subject: { type: "string", description: "Email subject" },
              body: {
                type: "string",
                description: "Email body (plain text or HTML)",
              },
              cc: {
                type: "string",
                description: "CC recipients, comma-separated",
              },
              bcc: {
                type: "string",
                description: "BCC recipients, comma-separated",
              },
              isHtml: {
                type: "boolean",
                description: "Whether the body is HTML (default: false)",
              },
            },
            required: ["to", "subject", "body"],
          },
        },
        handler: (a) => this.sendEmail(a),
      },
      {
        tool: {
          name: "reply_to_email",
          description:
            "Reply to an email within its existing thread. Preserves threading in Gmail.",
          inputSchema: {
            type: "object",
            properties: {
              messageId: {
                type: "string",
                description:
                  "The message ID to reply to (used to get thread context)",
              },
              body: {
                type: "string",
                description: "Reply body text",
              },
              replyAll: {
                type: "boolean",
                description:
                  "Reply to all recipients, not just the sender (default: false)",
              },
              isHtml: {
                type: "boolean",
                description: "Whether the body is HTML (default: false)",
              },
            },
            required: ["messageId", "body"],
          },
        },
        handler: (a) => this.replyToEmail(a),
      },
      {
        tool: {
          name: "draft_email",
          description:
            "Create an email draft (not sent). Can be reviewed and sent later with send_draft.",
          inputSchema: {
            type: "object",
            properties: {
              to: {
                type: "string",
                description: "Recipient email(s), comma-separated",
              },
              subject: { type: "string", description: "Email subject" },
              body: {
                type: "string",
                description: "Email body (plain text or HTML)",
              },
              cc: { type: "string", description: "CC recipients" },
              bcc: { type: "string", description: "BCC recipients" },
              isHtml: { type: "boolean", description: "HTML body (default: false)" },
            },
            required: ["to", "subject", "body"],
          },
        },
        handler: (a) => this.draftEmail(a),
      },
      {
        tool: {
          name: "send_draft",
          description: "Send an existing email draft by its draft ID.",
          inputSchema: {
            type: "object",
            properties: {
              draftId: {
                type: "string",
                description:
                  "The draft ID (from draft_email response or Gmail drafts list)",
              },
            },
            required: ["draftId"],
          },
        },
        handler: (a) => this.sendDraft(a),
      },
      {
        tool: {
          name: "modify_email",
          description:
            "Modify labels on an email. Use this to archive (remove INBOX), mark as read (remove UNREAD), star (add STARRED), etc.",
          inputSchema: {
            type: "object",
            properties: {
              messageId: { type: "string", description: "The message ID" },
              addLabelIds: {
                type: "array",
                items: { type: "string" },
                description:
                  "Label IDs to add (e.g., ['STARRED', 'IMPORTANT'])",
              },
              removeLabelIds: {
                type: "array",
                items: { type: "string" },
                description:
                  "Label IDs to remove (e.g., ['INBOX', 'UNREAD'])",
              },
            },
            required: ["messageId"],
          },
        },
        handler: (a) => this.modifyEmail(a),
      },
      {
        tool: {
          name: "trash_email",
          description: "Move an email to the trash.",
          inputSchema: {
            type: "object",
            properties: {
              messageId: { type: "string", description: "The message ID to trash" },
            },
            required: ["messageId"],
          },
        },
        handler: (a) => this.trashEmail(a),
      },
      // ── Thread operations ─────────────────────────────
      {
        tool: {
          name: "list_threads",
          description:
            "List email threads (conversations) with optional query filtering.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Optional Gmail search query",
              },
              maxResults: {
                type: "number",
                description: "Max threads to return (default: 20)",
              },
              labelIds: {
                type: "array",
                items: { type: "string" },
                description: "Filter by label IDs",
              },
            },
          },
        },
        handler: (a) => this.listThreads(a),
      },
      {
        tool: {
          name: "get_thread",
          description:
            "Get a full email thread (conversation) with all messages in order.",
          inputSchema: {
            type: "object",
            properties: {
              threadId: {
                type: "string",
                description: "The thread ID",
              },
            },
            required: ["threadId"],
          },
        },
        handler: (a) => this.getThread(a),
      },
      // ── Label operations ──────────────────────────────
      {
        tool: {
          name: "list_labels",
          description:
            "List all Gmail labels (system and user-created) with message/thread counts.",
          inputSchema: { type: "object", properties: {} },
        },
        handler: (a) => this.listLabels(a),
      },
      {
        tool: {
          name: "create_label",
          description: "Create a new Gmail label.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description:
                  "Label name. Use '/' for nesting (e.g., 'Work/Projects/Alpha').",
              },
              backgroundColor: {
                type: "string",
                description: "Background color hex (e.g., '#16a765')",
              },
              textColor: {
                type: "string",
                description: "Text color hex (e.g., '#ffffff')",
              },
            },
            required: ["name"],
          },
        },
        handler: (a) => this.createLabel(a),
      },
      {
        tool: {
          name: "delete_label",
          description:
            "Delete a user-created Gmail label. System labels cannot be deleted.",
          inputSchema: {
            type: "object",
            properties: {
              labelId: {
                type: "string",
                description:
                  "The label ID to delete (use list_labels to find it)",
              },
            },
            required: ["labelId"],
          },
        },
        handler: (a) => this.deleteLabel(a),
      },
      // ── Batch operations ──────────────────────────────
      {
        tool: {
          name: "batch_modify_emails",
          description:
            "Modify labels on multiple emails at once. Useful for bulk archive, mark read/unread, etc.",
          inputSchema: {
            type: "object",
            properties: {
              messageIds: {
                type: "array",
                items: { type: "string" },
                description: "List of message IDs to modify",
              },
              addLabelIds: {
                type: "array",
                items: { type: "string" },
                description: "Label IDs to add",
              },
              removeLabelIds: {
                type: "array",
                items: { type: "string" },
                description: "Label IDs to remove",
              },
            },
            required: ["messageIds"],
          },
        },
        handler: (a) => this.batchModifyEmails(a),
      },
      {
        tool: {
          name: "batch_trash_emails",
          description: "Move multiple emails to trash at once.",
          inputSchema: {
            type: "object",
            properties: {
              messageIds: {
                type: "array",
                items: { type: "string" },
                description: "List of message IDs to trash",
              },
            },
            required: ["messageIds"],
          },
        },
        handler: (a) => this.batchTrashEmails(a),
      },
      // ── Attachments ───────────────────────────────────
      {
        tool: {
          name: "get_attachment",
          description:
            "Get the content of an email attachment. Returns the data as base64-encoded string.",
          inputSchema: {
            type: "object",
            properties: {
              messageId: { type: "string", description: "The message ID containing the attachment" },
              attachmentId: {
                type: "string",
                description: "The attachment ID (from read_email attachment info)",
              },
            },
            required: ["messageId", "attachmentId"],
          },
        },
        handler: (a) => this.getAttachment(a),
      },
      // ── Drafts ────────────────────────────────────────
      {
        tool: {
          name: "list_drafts",
          description: "List email drafts in the mailbox.",
          inputSchema: {
            type: "object",
            properties: {
              maxResults: {
                type: "number",
                description: "Max drafts to return (default: 20)",
              },
              query: {
                type: "string",
                description: "Optional Gmail search query to filter drafts",
              },
            },
          },
        },
        handler: (a) => this.listDrafts(a),
      },
      {
        tool: {
          name: "delete_draft",
          description: "Permanently delete a draft (not trash — immediate deletion).",
          inputSchema: {
            type: "object",
            properties: {
              draftId: { type: "string", description: "The draft ID to delete" },
            },
            required: ["draftId"],
          },
        },
        handler: (a) => this.deleteDraft(a),
      },
      // ── Label management ──────────────────────────────
      {
        tool: {
          name: "update_label",
          description: "Update a Gmail label's name or colors.",
          inputSchema: {
            type: "object",
            properties: {
              labelId: { type: "string", description: "The label ID to update" },
              name: { type: "string", description: "New label name" },
              backgroundColor: { type: "string", description: "Background color hex (e.g., '#16a765')" },
              textColor: { type: "string", description: "Text color hex (e.g., '#ffffff')" },
            },
            required: ["labelId"],
          },
        },
        handler: (a) => this.updateLabel(a),
      },
      // ── Profile & counts ──────────────────────────────
      {
        tool: {
          name: "get_profile",
          description:
            "Get the current user's Gmail profile: email address, total messages, total threads, and history ID.",
          inputSchema: { type: "object", properties: {} },
        },
        handler: (a) => this.getProfile(a),
      },
      {
        tool: {
          name: "get_label_counts",
          description:
            "Get message and thread counts for a label (e.g., total and unread in INBOX). Useful for quick inbox summary without fetching messages.",
          inputSchema: {
            type: "object",
            properties: {
              labelId: {
                type: "string",
                description:
                  "Label ID (e.g., 'INBOX', 'UNREAD', 'STARRED', 'SENT', or a user label ID)",
              },
            },
            required: ["labelId"],
          },
        },
        handler: (a) => this.getLabelCounts(a),
      },
      // ── Filters ───────────────────────────────────────
      {
        tool: {
          name: "create_filter",
          description:
            "Create a Gmail filter to auto-organize incoming emails. Matches criteria (from, to, subject, query) and applies actions (add labels, remove labels, forward).",
          inputSchema: {
            type: "object",
            properties: {
              from: { type: "string", description: "Match sender (e.g., 'newsletter@company.com')" },
              to: { type: "string", description: "Match recipient" },
              subject: { type: "string", description: "Match subject" },
              query: {
                type: "string",
                description: "Gmail search query for matching (e.g., 'has:attachment larger:5M')",
              },
              hasAttachment: { type: "boolean", description: "Match only emails with attachments" },
              addLabelIds: {
                type: "array",
                items: { type: "string" },
                description:
                  "Labels to add to matching emails (use list_labels to find IDs)",
              },
              removeLabelIds: {
                type: "array",
                items: { type: "string" },
                description:
                  "Labels to remove (e.g., ['INBOX'] to auto-archive, ['UNREAD'] to auto-read)",
              },
              forward: {
                type: "string",
                description: "Email address to forward matching emails to",
              },
              applyToExisting: {
                type: "boolean",
                description:
                  "Also apply the filter actions to existing messages that match the criteria (default: false). Equivalent to Gmail's 'Also apply filter to matching conversations' checkbox.",
              },
            },
          },
        },
        handler: (a) => this.createFilter(a),
      },
      {
        tool: {
          name: "list_filters",
          description: "List all Gmail filters (auto-organization rules).",
          inputSchema: { type: "object", properties: {} },
        },
        handler: (a) => this.listFilters(a),
      },
      {
        tool: {
          name: "delete_filter",
          description: "Delete a Gmail filter by its ID.",
          inputSchema: {
            type: "object",
            properties: {
              filterId: { type: "string", description: "The filter ID to delete" },
            },
            required: ["filterId"],
          },
        },
        handler: (a) => this.deleteFilter(a),
      },
    ];
  }

  // ── Handlers ────────────────────────────────────────────

  private async searchEmails(args: Record<string, unknown>) {
    const query = requireString(args, "query");
    const maxResults = optionalNumber(args, "maxResults") || 20;
    const labelIds = args.labelIds as string[] | undefined;

    const listResp = await this.gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults,
      labelIds: labelIds || undefined,
    });

    const messageRefs = listResp.data.messages || [];
    if (messageRefs.length === 0) {
      return textResponse(`No emails found for query: "${query}"`);
    }

    // Fetch metadata for each message
    const messages: string[] = [];
    for (const ref of messageRefs) {
      const msg = await this.gmail.users.messages.get({
        userId: "me",
        id: ref.id!,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });
      messages.push(fmtMessage(msg.data));
    }

    return textResponse(
      `Found ${messageRefs.length} emails (${listResp.data.resultSizeEstimate} estimated total):\n\n${messages.join("\n\n")}`,
    );
  }

  private async readEmail(args: Record<string, unknown>) {
    const messageId = requireString(args, "messageId");

    const msg = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    return textResponse(fmtMessage(msg.data, true));
  }

  private async sendEmail(args: Record<string, unknown>) {
    const to = requireString(args, "to");
    const subject = requireString(args, "subject");
    const body = requireString(args, "body");
    const cc = optionalString(args, "cc");
    const bcc = optionalString(args, "bcc");
    const isHtml = optionalBoolean(args, "isHtml") || false;

    const raw = buildRawMessage({ to, subject, body, cc, bcc, isHtml });

    const response = await this.gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    return textResponse(
      `Email sent!\nTo: ${to}\nSubject: ${subject}\nMessage ID: ${response.data.id}\nThread ID: ${response.data.threadId}`,
    );
  }

  private async replyToEmail(args: Record<string, unknown>) {
    const messageId = requireString(args, "messageId");
    const body = requireString(args, "body");
    const replyAll = optionalBoolean(args, "replyAll") || false;
    const isHtml = optionalBoolean(args, "isHtml") || false;

    // Get the original message for threading info
    const original = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "To", "Cc", "Subject", "Message-ID", "References"],
    });

    const h = original.data.payload?.headers;
    const from = getHeader(h, "From");
    const origTo = getHeader(h, "To");
    const origCc = getHeader(h, "Cc");
    const subject = getHeader(h, "Subject");
    const messageIdHeader = getHeader(h, "Message-ID");
    const references = getHeader(h, "References");

    let to = from;
    let cc: string | undefined;
    if (replyAll) {
      // Include original To and Cc, excluding self
      const allRecipients = [origTo, origCc].filter(Boolean).join(", ");
      cc = allRecipients || undefined;
    }

    const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;

    const raw = buildRawMessage({
      to,
      subject: replySubject,
      body,
      cc,
      inReplyTo: messageIdHeader,
      references: references
        ? `${references} ${messageIdHeader}`
        : messageIdHeader,
      isHtml,
    });

    const response = await this.gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
        threadId: original.data.threadId || undefined,
      },
    });

    return textResponse(
      `Reply sent!\nTo: ${to}\nSubject: ${replySubject}\nMessage ID: ${response.data.id}\nThread ID: ${response.data.threadId}`,
    );
  }

  private async draftEmail(args: Record<string, unknown>) {
    const to = requireString(args, "to");
    const subject = requireString(args, "subject");
    const body = requireString(args, "body");
    const cc = optionalString(args, "cc");
    const bcc = optionalString(args, "bcc");
    const isHtml = optionalBoolean(args, "isHtml") || false;

    const raw = buildRawMessage({ to, subject, body, cc, bcc, isHtml });

    const response = await this.gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: { raw },
      },
    });

    const messageId = response.data.message?.id;
    const draftLink = messageId
      ? `https://mail.google.com/mail/#drafts/${messageId}`
      : "https://mail.google.com/mail/#drafts";

    return textResponse(
      `Draft created!\nDraft ID: ${response.data.id}\nTo: ${to}\nSubject: ${subject}\nMessage ID: ${messageId}\nOpen in Gmail: ${draftLink}`,
    );
  }

  private async sendDraft(args: Record<string, unknown>) {
    const draftId = requireString(args, "draftId");

    const response = await this.gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: draftId },
    });

    return textResponse(
      `Draft sent!\nMessage ID: ${response.data.id}\nThread ID: ${response.data.threadId}`,
    );
  }

  private async modifyEmail(args: Record<string, unknown>) {
    const messageId = requireString(args, "messageId");
    const addLabelIds = args.addLabelIds as string[] | undefined;
    const removeLabelIds = args.removeLabelIds as string[] | undefined;

    if (!addLabelIds?.length && !removeLabelIds?.length) {
      return textResponse(
        "Specify addLabelIds and/or removeLabelIds to modify.",
      );
    }

    await this.gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: addLabelIds || [],
        removeLabelIds: removeLabelIds || [],
      },
    });

    const changes: string[] = [];
    if (addLabelIds?.length) changes.push(`Added: ${addLabelIds.join(", ")}`);
    if (removeLabelIds?.length)
      changes.push(`Removed: ${removeLabelIds.join(", ")}`);

    return textResponse(
      `Message ${messageId} modified.\n${changes.join("\n")}`,
    );
  }

  private async trashEmail(args: Record<string, unknown>) {
    const messageId = requireString(args, "messageId");

    await this.gmail.users.messages.trash({
      userId: "me",
      id: messageId,
    });

    return textResponse(`Message ${messageId} moved to trash.`);
  }

  // ── Threads ────────────────────────────────────────────

  private async listThreads(args: Record<string, unknown>) {
    const query = optionalString(args, "query");
    const maxResults = optionalNumber(args, "maxResults") || 20;
    const labelIds = args.labelIds as string[] | undefined;

    const response = await this.gmail.users.threads.list({
      userId: "me",
      q: query || undefined,
      maxResults,
      labelIds: labelIds || undefined,
    });

    const threads = response.data.threads || [];
    if (threads.length === 0) {
      return textResponse("No threads found.");
    }

    // Fetch snippet for each thread
    const lines: string[] = [];
    for (const t of threads) {
      const thread = await this.gmail.users.threads.get({
        userId: "me",
        id: t.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });
      const firstMsg = thread.data.messages?.[0];
      const h = firstMsg?.payload?.headers;
      const msgCount = thread.data.messages?.length || 0;
      lines.push(
        `- ${getHeader(h, "Subject") || "(no subject)"} (${msgCount} messages)\n  From: ${getHeader(h, "From")}\n  Date: ${getHeader(h, "Date")}\n  Thread ID: ${t.id}`,
      );
    }

    return textResponse(
      `Found ${threads.length} threads:\n\n${lines.join("\n\n")}`,
    );
  }

  private async getThread(args: Record<string, unknown>) {
    const threadId = requireString(args, "threadId");

    const thread = await this.gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });

    const messages = thread.data.messages || [];
    const formatted = messages
      .map((msg, i) => `[Message ${i + 1}/${messages.length}]\n${fmtMessage(msg, true)}`)
      .join("\n\n" + "=".repeat(60) + "\n\n");

    return textResponse(
      `Thread: ${threadId} (${messages.length} messages)\n\n${formatted}`,
    );
  }

  // ── Labels ─────────────────────────────────────────────

  private async listLabels(_args: Record<string, unknown>) {
    const response = await this.gmail.users.labels.list({
      userId: "me",
    });

    const labels = response.data.labels || [];
    const system = labels.filter((l) => l.type === "system");
    const user = labels.filter((l) => l.type === "user");

    let output = "System labels:\n";
    for (const l of system) {
      output += `  - ${l.name} (ID: ${l.id})\n`;
    }

    output += "\nUser labels:\n";
    if (user.length === 0) {
      output += "  (none)\n";
    } else {
      for (const l of user) {
        output += `  - ${l.name} (ID: ${l.id})\n`;
      }
    }

    return textResponse(output);
  }

  private async createLabel(args: Record<string, unknown>) {
    const name = requireString(args, "name");
    const backgroundColor = optionalString(args, "backgroundColor");
    const textColor = optionalString(args, "textColor");

    const label: gmail_v1.Schema$Label = {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    };

    if (backgroundColor || textColor) {
      label.color = {
        backgroundColor: backgroundColor || "#000000",
        textColor: textColor || "#ffffff",
      };
    }

    const response = await this.gmail.users.labels.create({
      userId: "me",
      requestBody: label,
    });

    return textResponse(
      `Label created!\nName: ${response.data.name}\nID: ${response.data.id}`,
    );
  }

  private async deleteLabel(args: Record<string, unknown>) {
    const labelId = requireString(args, "labelId");

    await this.gmail.users.labels.delete({
      userId: "me",
      id: labelId,
    });

    return textResponse(`Label ${labelId} deleted.`);
  }

  // ── Batch operations ───────────────────────────────────

  private async batchModifyEmails(args: Record<string, unknown>) {
    const messageIds = args.messageIds as string[];
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      throw new Error("'messageIds' must be a non-empty array");
    }
    if (messageIds.length > 100) {
      throw new Error("Maximum 100 messages per batch operation");
    }
    const addLabelIds = args.addLabelIds as string[] | undefined;
    const removeLabelIds = args.removeLabelIds as string[] | undefined;

    await this.gmail.users.messages.batchModify({
      userId: "me",
      requestBody: {
        ids: messageIds,
        addLabelIds: addLabelIds || [],
        removeLabelIds: removeLabelIds || [],
      },
    });

    return textResponse(
      `Batch modified ${messageIds.length} messages.${addLabelIds?.length ? `\nAdded: ${addLabelIds.join(", ")}` : ""}${removeLabelIds?.length ? `\nRemoved: ${removeLabelIds.join(", ")}` : ""}`,
    );
  }

  private async batchTrashEmails(args: Record<string, unknown>) {
    const messageIds = args.messageIds as string[];
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      throw new Error("'messageIds' must be a non-empty array");
    }
    if (messageIds.length > 100) {
      throw new Error("Maximum 100 messages per batch operation");
    }

    // Gmail API doesn't have batch trash — loop individually
    for (const id of messageIds) {
      await this.gmail.users.messages.trash({ userId: "me", id });
    }

    return textResponse(`Trashed ${messageIds.length} messages.`);
  }

  // ── Attachments ────────────────────────────────────────

  private async getAttachment(args: Record<string, unknown>) {
    const messageId = requireString(args, "messageId");
    const attachmentId = requireString(args, "attachmentId");

    const response = await this.gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    });

    const data = response.data.data || "";
    const size = response.data.size || 0;

    return textResponse(
      `Attachment retrieved (${size} bytes).\nBase64 data:\n${data}`,
    );
  }

  // ── Drafts ─────────────────────────────────────────────

  private async listDrafts(args: Record<string, unknown>) {
    const maxResults = optionalNumber(args, "maxResults") || 20;
    const query = optionalString(args, "query");

    const response = await this.gmail.users.drafts.list({
      userId: "me",
      maxResults,
      q: query || undefined,
    });

    const drafts = response.data.drafts || [];
    if (drafts.length === 0) {
      return textResponse("No drafts found.");
    }

    const lines: string[] = [];
    for (const d of drafts) {
      const draft = await this.gmail.users.drafts.get({
        userId: "me",
        id: d.id!,
        format: "metadata",
      });
      const h = draft.data.message?.payload?.headers;
      lines.push(
        `- Draft ID: ${d.id}\n  To: ${getHeader(h, "To")}\n  Subject: ${getHeader(h, "Subject")}\n  Message ID: ${draft.data.message?.id}`,
      );
    }

    return textResponse(`Found ${drafts.length} drafts:\n\n${lines.join("\n\n")}`);
  }

  private async deleteDraft(args: Record<string, unknown>) {
    const draftId = requireString(args, "draftId");

    await this.gmail.users.drafts.delete({
      userId: "me",
      id: draftId,
    });

    return textResponse(`Draft ${draftId} permanently deleted.`);
  }

  // ── Label management ───────────────────────────────────

  private async updateLabel(args: Record<string, unknown>) {
    const labelId = requireString(args, "labelId");
    const name = optionalString(args, "name");
    const backgroundColor = optionalString(args, "backgroundColor");
    const textColor = optionalString(args, "textColor");

    const update: gmail_v1.Schema$Label = {};
    if (name) update.name = name;
    if (backgroundColor || textColor) {
      update.color = {
        backgroundColor: backgroundColor || undefined,
        textColor: textColor || undefined,
      };
    }

    const response = await this.gmail.users.labels.patch({
      userId: "me",
      id: labelId,
      requestBody: update,
    });

    return textResponse(
      `Label updated: "${response.data.name}" (ID: ${response.data.id})`,
    );
  }

  // ── Profile & counts ───────────────────────────────────

  private async getProfile(_args: Record<string, unknown>) {
    const response = await this.gmail.users.getProfile({ userId: "me" });
    const p = response.data;

    return textResponse(
      `Email: ${p.emailAddress}\nTotal messages: ${p.messagesTotal}\nTotal threads: ${p.threadsTotal}\nHistory ID: ${p.historyId}`,
    );
  }

  private async getLabelCounts(args: Record<string, unknown>) {
    const labelId = requireString(args, "labelId");

    const response = await this.gmail.users.labels.get({
      userId: "me",
      id: labelId,
    });

    const l = response.data;
    return textResponse(
      `Label: ${l.name} (${l.id})\nMessages: ${l.messagesTotal} total, ${l.messagesUnread} unread\nThreads: ${l.threadsTotal} total, ${l.threadsUnread} unread`,
    );
  }

  // ── Filters ────────────────────────────────────────────

  private async createFilter(args: Record<string, unknown>) {
    const from = optionalString(args, "from");
    const to = optionalString(args, "to");
    const subject = optionalString(args, "subject");
    const query = optionalString(args, "query");
    const hasAttachment = optionalBoolean(args, "hasAttachment");
    const addLabelIds = args.addLabelIds as string[] | undefined;
    const removeLabelIds = args.removeLabelIds as string[] | undefined;
    const forward = optionalString(args, "forward");
    const applyToExisting = optionalBoolean(args, "applyToExisting") || false;

    const criteria: gmail_v1.Schema$FilterCriteria = {};
    if (from) criteria.from = from;
    if (to) criteria.to = to;
    if (subject) criteria.subject = subject;
    if (query) criteria.query = query;
    if (hasAttachment) criteria.hasAttachment = hasAttachment;

    const action: gmail_v1.Schema$FilterAction = {};
    if (addLabelIds?.length) action.addLabelIds = addLabelIds;
    if (removeLabelIds?.length) action.removeLabelIds = removeLabelIds;
    if (forward) action.forward = forward;

    const response = await this.gmail.users.settings.filters.create({
      userId: "me",
      requestBody: { criteria, action },
    });

    const f = response.data;
    const criteriaDesc: string[] = [];
    if (from) criteriaDesc.push(`from:${from}`);
    if (to) criteriaDesc.push(`to:${to}`);
    if (subject) criteriaDesc.push(`subject:${subject}`);
    if (query) criteriaDesc.push(`query:${query}`);
    if (hasAttachment) criteriaDesc.push("has:attachment");

    const actionDesc: string[] = [];
    if (addLabelIds?.length) actionDesc.push(`add labels: ${addLabelIds.join(", ")}`);
    if (removeLabelIds?.length) actionDesc.push(`remove labels: ${removeLabelIds.join(", ")}`);
    if (forward) actionDesc.push(`forward to: ${forward}`);

    let result = `Filter created!\nID: ${f.id}\nCriteria: ${criteriaDesc.join(", ")}\nActions: ${actionDesc.join(", ")}`;

    // Apply to existing matching messages
    if (applyToExisting && (addLabelIds?.length || removeLabelIds?.length)) {
      const searchQuery = criteriaDesc.join(" ");
      if (searchQuery) {
        const existing = await this.gmail.users.messages.list({
          userId: "me",
          q: searchQuery,
          maxResults: 500,
        });

        const messageIds = (existing.data.messages || [])
          .map((m) => m.id!)
          .filter(Boolean);

        if (messageIds.length > 0) {
          // Process in batches of 100
          for (let i = 0; i < messageIds.length; i += 100) {
            const batch = messageIds.slice(i, i + 100);
            await this.gmail.users.messages.batchModify({
              userId: "me",
              requestBody: {
                ids: batch,
                addLabelIds: addLabelIds || [],
                removeLabelIds: removeLabelIds || [],
              },
            });
          }
          result += `\nApplied to ${messageIds.length} existing message(s).`;
        } else {
          result += `\nNo existing messages matched the criteria.`;
        }
      }
    }

    return textResponse(result);
  }

  private async listFilters(_args: Record<string, unknown>) {
    const response = await this.gmail.users.settings.filters.list({
      userId: "me",
    });

    const filters = response.data.filter || [];
    if (filters.length === 0) {
      return textResponse("No filters configured.");
    }

    const lines = filters.map((f) => {
      const c = f.criteria || {};
      const a = f.action || {};
      const criteria: string[] = [];
      if (c.from) criteria.push(`from:${c.from}`);
      if (c.to) criteria.push(`to:${c.to}`);
      if (c.subject) criteria.push(`subject:${c.subject}`);
      if (c.query) criteria.push(`query:${c.query}`);
      if (c.hasAttachment) criteria.push("has:attachment");

      const actions: string[] = [];
      if (a.addLabelIds?.length) actions.push(`+${a.addLabelIds.join(",")}`);
      if (a.removeLabelIds?.length) actions.push(`-${a.removeLabelIds.join(",")}`);
      if (a.forward) actions.push(`fwd:${a.forward}`);

      return `- ID: ${f.id}\n  Match: ${criteria.join(", ") || "(any)"}\n  Actions: ${actions.join(", ")}`;
    });

    return textResponse(
      `${filters.length} filter(s):\n\n${lines.join("\n\n")}`,
    );
  }

  private async deleteFilter(args: Record<string, unknown>) {
    const filterId = requireString(args, "filterId");

    await this.gmail.users.settings.filters.delete({
      userId: "me",
      id: filterId,
    });

    return textResponse(`Filter ${filterId} deleted.`);
  }
}
