import { google, type gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import addressparser from "nodemailer/lib/addressparser/index.js";
import type { Service, ToolDefinition } from "../types.js";
import {
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  textResponse,
} from "../utils.js";

// ── Helpers ──────────────────────────────────────────────────

const MAX_PAGE_RESULTS = 500;
const MAX_BODY_CHARS = 100_000;
const DEFAULT_BODY_CHARS = 20_000;
const MAX_ATTACHMENT_RETURN_BYTES = 25 * 1024 * 1024;
const DEFAULT_ATTACHMENT_RETURN_BYTES = 5 * 1024 * 1024;
const MAX_OUTBOUND_BYTES = 20 * 1024 * 1024;
const FETCH_CONCURRENCY = 5;

const LABEL_COLORS = new Set([
  "#000000", "#434343", "#666666", "#999999", "#cccccc", "#efefef",
  "#f3f3f3", "#ffffff", "#fb4c2f", "#ffad47", "#fad165", "#16a766",
  "#43d692", "#4a86e8", "#a479e2", "#f691b3", "#f6c5be", "#ffe6c7",
  "#fef1d1", "#b9e4d0", "#c6f3de", "#c9daf8", "#e4d7f5", "#fcdee8",
  "#efa093", "#ffd6a2", "#fce8b3", "#89d3b2", "#a0eac9", "#a4c2f4",
  "#d0bcf1", "#fbc8d9", "#e66550", "#ffbc6b", "#fcda83", "#44b984",
  "#68dfa9", "#6d9eeb", "#b694e8", "#f7a7c0", "#cc3a21", "#eaa041",
  "#f2c960", "#149e60", "#3dc789", "#3c78d8", "#8e63ce", "#e07798",
  "#ac2b16", "#cf8933", "#d5ae49", "#0b804b", "#2a9c68", "#285bac",
  "#653e9b", "#b65775", "#822111", "#a46a21", "#aa8831", "#076239",
  "#1a764d", "#1c4587", "#41236d", "#83334c", "#464646", "#e7e7e7",
  "#0d3472", "#b6cff5", "#0d3b44", "#98d7e4", "#3d188e", "#e3d7ff",
  "#711a36", "#fbd3e0", "#8a1c0a", "#f2b2a8", "#7a2e0b", "#ffc8af",
  "#7a4706", "#ffdeb5", "#594c05", "#fbe983", "#684e07", "#fdedc1",
  "#0b4f30", "#b3efd3", "#04502e", "#a2dcc1", "#c2c2c2", "#4986e7",
  "#2da2bb", "#b99aff", "#994a64", "#f691b2", "#ff7537", "#ffad46",
  "#662e37", "#ebdbde", "#cca6ac", "#094228", "#42d692", "#16a765",
]);

const SYSTEM_LABEL_IDS = new Set([
  "CHAT", "SENT", "INBOX", "IMPORTANT", "TRASH", "DRAFT", "SPAM",
  "CATEGORY_FORUMS", "CATEGORY_UPDATES", "CATEGORY_PERSONAL",
  "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "STARRED", "UNREAD",
]);

export interface OutboundAttachment {
  filename: string;
  mimeType: string;
  data: string;
  encoding: "base64" | "base64url";
  disposition: "attachment" | "inline";
  contentId?: string;
}

interface ParsedAddress {
  address: string;
  displayName?: string;
}

export interface AttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
  partId?: string;
  contentId?: string;
  disposition?: string;
  inlineDataAvailable: boolean;
}

function structuredResponse(text: string, value: Record<string, unknown>) {
  return { ...textResponse(text), structuredContent: value };
}

function optionalStringArray(
  args: Record<string, unknown>,
  field: string,
  options: { maxItems?: number; allowEmpty?: boolean } = {},
): string[] | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`'${field}' must be an array of non-empty strings`);
  }
  if (!options.allowEmpty && value.length === 0) throw new Error(`'${field}' must not be empty`);
  if (options.maxItems !== undefined && value.length > options.maxItems) {
    throw new Error(`'${field}' supports at most ${options.maxItems} items`);
  }
  return [...new Set(value)];
}

function optionalInteger(
  args: Record<string, unknown>,
  field: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = optionalNumber(args, field);
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`'${field}' must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  field: string,
  values: readonly T[],
  defaultValue: T,
): T {
  const value = optionalString(args, field);
  if (value === undefined) return defaultValue;
  if (!(values as readonly string[]).includes(value)) {
    throw new Error(`'${field}' must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function rejectHeaderBreak(value: string, field: string): string {
  if (/\r|\n/.test(value)) throw new Error(`'${field}' must not contain CR or LF characters`);
  return value;
}

function safeDisplay(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,63}$/i;

function parseAddressList(value: string, field: string, strict = true): ParsedAddress[] {
  rejectHeaderBreak(value, field);
  const parsed = addressparser(value, { flatten: true });
  const result = parsed.flatMap((item) => {
    const address = item.address.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(address)) {
      if (strict) throw new Error(`'${field}' contains an invalid email address: ${item.address || item.name}`);
      return [];
    }
    const displayName = item.name ? rejectHeaderBreak(item.name.trim(), field) : undefined;
    return [{ address, displayName }];
  });
  if (strict && result.length === 0) throw new Error(`'${field}' must contain a valid email address`);
  return result;
}

function formatAddress(address: ParsedAddress): string {
  if (!address.displayName) return address.address;
  const phrase = rejectHeaderBreak(address.displayName, "display name");
  const mustQuote = [...phrase].some((char) => "()<>[]@,;:\\\".".includes(char));
  const safePhrase = mustQuote
    ? `"${phrase.replace(/(["\\])/g, "\\$1")}"`
    : phrase;
  return `${safePhrase} <${address.address}>`;
}

function formatAddressList(value: string, field: string): string {
  return parseAddressList(value, field).map(formatAddress).join(", ");
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function decodeEncodedData(value: string, encoding: "base64" | "base64url", field: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  const pattern = encoding === "base64url" ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/;
  if (!pattern.test(compact)) throw new Error(`'${field}' is not valid ${encoding}`);
  return Buffer.from(compact, encoding);
}

function parseOutboundAttachments(value: unknown): OutboundAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("'attachments' must be an array");
  const result: OutboundAttachment[] = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`'attachments[${index}]' must be an object`);
    }
    const record = item as Record<string, unknown>;
    const filename = requireString(record, "filename");
    rejectHeaderBreak(filename, `attachments[${index}].filename`);
    const mimeType = optionalString(record, "mimeType") || "application/octet-stream";
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)) {
      throw new Error(`'attachments[${index}].mimeType' is invalid`);
    }
    const data = requireString(record, "data");
    const encoding = optionalEnum(record, "encoding", ["base64", "base64url"] as const, "base64");
    const disposition = optionalEnum(record, "disposition", ["attachment", "inline"] as const, "attachment");
    const contentId = optionalString(record, "contentId");
    if (contentId) rejectHeaderBreak(contentId, `attachments[${index}].contentId`);
    return { filename, mimeType, data, encoding, disposition, contentId };
  });
  const totalBytes = result.reduce(
    (total, item, index) => total + decodeEncodedData(item.data, item.encoding, `attachments[${index}].data`).length,
    0,
  );
  if (totalBytes > MAX_OUTBOUND_BYTES) throw new Error(`Attachments exceed ${MAX_OUTBOUND_BYTES} bytes`);
  return result;
}

async function mapWithConcurrency<T, U>(
  values: T[],
  mapper: (value: T, index: number) => Promise<U>,
): Promise<Array<PromiseSettledResult<U>>> {
  const results: Array<PromiseSettledResult<U>> = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await mapper(values[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

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

function contentDisposition(part: gmail_v1.Schema$MessagePart): string {
  return getHeader(part.headers, "Content-Disposition").toLowerCase();
}

export function collectBodyCandidates(
  payload: gmail_v1.Schema$MessagePart,
): Array<{ part: gmail_v1.Schema$MessagePart; type: "text/plain" | "text/html" }> {
  const candidates: Array<{ part: gmail_v1.Schema$MessagePart; type: "text/plain" | "text/html" }> = [];
  const walk = (part: gmail_v1.Schema$MessagePart) => {
    const mimeType = part.mimeType?.toLowerCase();
    const disposition = contentDisposition(part);
    const isAttachment = Boolean(part.filename) || disposition.startsWith("attachment");
    if (!isAttachment && (mimeType === "text/plain" || mimeType === "text/html")) {
      candidates.push({ part, type: mimeType });
    }
    part.parts?.forEach(walk);
  };
  walk(payload);
  return candidates.sort((a, b) => Number(a.type === "text/html") - Number(b.type === "text/html"));
}

function htmlToMarkdown(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, head, meta, link, object, embed").remove();
  const turndown = new TurndownService({ codeBlockStyle: "fenced", headingStyle: "atx" });
  return turndown.turndown($("body").html() || $.root().html() || html).trim();
}

function extractAttachments(
  payload: gmail_v1.Schema$MessagePart,
): AttachmentInfo[] {
  const attachments: AttachmentInfo[] = [];

  function walk(part: gmail_v1.Schema$MessagePart) {
    const disposition = contentDisposition(part);
    if (part.filename || disposition.startsWith("attachment") || disposition.startsWith("inline")) {
      attachments.push({
        filename: part.filename || "(inline part)",
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body?.size || 0,
        attachmentId: part.body?.attachmentId || undefined,
        partId: part.partId || undefined,
        contentId: getHeader(part.headers, "Content-ID") || undefined,
        disposition: disposition || undefined,
        inlineDataAvailable: Boolean(part.body?.data),
      });
    }
    if (part.parts) part.parts.forEach(walk);
  }

  walk(payload);
  return attachments;
}

function fmtMessage(msg: gmail_v1.Schema$Message): string {
  const h = msg.payload?.headers;
  const lines = [
    `- From: ${safeDisplay(getHeader(h, "From"))}`,
    `  To: ${safeDisplay(getHeader(h, "To"))}`,
    `  Subject: ${safeDisplay(getHeader(h, "Subject"))}`,
    `  Date: ${safeDisplay(getHeader(h, "Date"))}`,
    `  ID: ${msg.id}  Thread: ${msg.threadId}`,
  ];
  if (msg.labelIds?.length) {
    lines.push(`  Labels: ${msg.labelIds.join(", ")}`);
  }
  return lines.join("\n");
}

export async function buildRawMessage(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  isHtml?: boolean;
  plainTextBody?: string;
  attachments?: OutboundAttachment[];
}): Promise<string> {
  const from = formatAddressList(opts.from, "from");
  const to = formatAddressList(opts.to, "to");
  const cc = opts.cc ? formatAddressList(opts.cc, "cc") : undefined;
  const bcc = opts.bcc ? formatAddressList(opts.bcc, "bcc") : undefined;
  const replyTo = opts.replyTo ? formatAddressList(opts.replyTo, "replyTo") : undefined;
  rejectHeaderBreak(opts.subject, "subject");
  const inReplyTo = opts.inReplyTo ? rejectHeaderBreak(opts.inReplyTo, "inReplyTo") : undefined;
  const references = opts.references
    ? rejectHeaderBreak(opts.references, "references")
    : inReplyTo;
  const attachments = (opts.attachments || []).map((attachment, index) => ({
    filename: attachment.filename,
    contentType: attachment.mimeType,
    content: decodeEncodedData(attachment.data, attachment.encoding, `attachments[${index}].data`),
    contentDisposition: attachment.disposition,
    cid: attachment.contentId?.replace(/^<|>$/g, ""),
  }));
  const composer = new MailComposer({
    from,
    to,
    cc,
    bcc,
    replyTo,
    subject: opts.subject,
    text: opts.isHtml ? opts.plainTextBody : opts.body,
    html: opts.isHtml ? opts.body : undefined,
    inReplyTo,
    references,
    attachments,
    date: new Date(),
    textEncoding: "base64",
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const raw = await composer.compile().build();
  return raw.toString("base64url");
}

const OUTBOUND_ATTACHMENT_SCHEMA = {
  type: "array",
  maxItems: 20,
  description: `Attachments as base64/base64url data; aggregate decoded size is limited to ${MAX_OUTBOUND_BYTES} bytes`,
  items: {
    type: "object",
    properties: {
      filename: { type: "string", description: "Attachment filename" },
      mimeType: { type: "string", description: "MIME type (default: application/octet-stream)" },
      data: { type: "string", description: "Attachment bytes encoded as base64 or base64url" },
      encoding: { type: "string", enum: ["base64", "base64url"], description: "Input encoding (default: base64)" },
      disposition: { type: "string", enum: ["attachment", "inline"], description: "MIME disposition" },
      contentId: { type: "string", description: "Optional Content-ID for inline content" },
    },
    required: ["filename", "data"],
    additionalProperties: false,
  },
};

const PAGE_TOKEN_PROPERTY = { type: "string", description: "Opaque nextPageToken returned by a previous call" };
const INCLUDE_SPAM_TRASH_PROPERTY = { type: "boolean", description: "Include SPAM and TRASH (default: false)" };
const DETAIL_LEVEL_PROPERTY = {
  type: "string",
  enum: ["ids", "metadata"],
  description: "ids avoids per-result get calls; metadata includes headers (default: metadata)",
};

// ── Service ──────────────────────────────────────────────────

export class GmailService implements Service {
  private gmail!: gmail_v1.Gmail;
  private cachedProfileEmail?: string;
  private cachedSendAs?: gmail_v1.Schema$SendAs[];

  initialize(auth: OAuth2Client): void {
    this.gmail = google.gmail({ version: "v1", auth });
  }

  getToolDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [
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
                  "Gmail API search query (supports most Gmail search syntax; optional)",
              },
              maxResults: {
                type: "integer",
                minimum: 1,
                maximum: MAX_PAGE_RESULTS,
                description: "Max messages to return (default: 20, max: 500)",
              },
              labelIds: {
                type: "array",
                items: { type: "string" },
                description:
                  "Filter by label IDs (e.g., ['INBOX', 'UNREAD'])",
              },
              pageToken: PAGE_TOKEN_PROPERTY,
              includeSpamTrash: INCLUDE_SPAM_TRASH_PROPERTY,
              detailLevel: DETAIL_LEVEL_PROPERTY,
            },
            additionalProperties: false,
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
              maxBodyChars: {
                type: "integer",
                minimum: 1,
                maximum: MAX_BODY_CHARS,
                description: `Maximum body characters returned (default: ${DEFAULT_BODY_CHARS})`,
              },
            },
            required: ["messageId"],
            additionalProperties: false,
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
              from: {
                type: "string",
                description: "Optional configured send-as address (defaults to the authenticated account)",
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
              replyTo: { type: "string", description: "Optional Reply-To address" },
              isHtml: {
                type: "boolean",
                description: "Whether the body is HTML (default: false)",
              },
              plainTextBody: {
                type: "string",
                description: "Optional plain-text alternative when body is HTML",
              },
              attachments: OUTBOUND_ATTACHMENT_SCHEMA,
              dryRun: {
                type: "boolean",
                description: "Validate and preview recipients without sending (default: false)",
              },
            },
            required: ["to", "subject", "body"],
            additionalProperties: false,
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
              plainTextBody: { type: "string", description: "Plain-text alternative for an HTML reply" },
              attachments: OUTBOUND_ATTACHMENT_SCHEMA,
              dryRun: { type: "boolean", description: "Validate and preview without sending" },
            },
            required: ["messageId", "body"],
            additionalProperties: false,
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
              from: { type: "string", description: "Optional configured send-as address" },
              replyTo: { type: "string", description: "Optional Reply-To address" },
              isHtml: { type: "boolean", description: "HTML body (default: false)" },
              plainTextBody: { type: "string", description: "Plain-text alternative for HTML" },
              attachments: OUTBOUND_ATTACHMENT_SCHEMA,
            },
            required: ["to", "subject", "body"],
            additionalProperties: false,
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
              dryRun: { type: "boolean", description: "Preview current draft recipients and subject without sending" },
            },
            required: ["draftId"],
            additionalProperties: false,
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
                maxItems: 100,
                uniqueItems: true,
                items: { type: "string" },
                description:
                  "Label IDs to add (e.g., ['STARRED', 'IMPORTANT'])",
              },
              removeLabelIds: {
                type: "array",
                maxItems: 100,
                uniqueItems: true,
                items: { type: "string" },
                description:
                  "Label IDs to remove (e.g., ['INBOX', 'UNREAD'])",
              },
            },
            required: ["messageId"],
            additionalProperties: false,
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
            additionalProperties: false,
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
                type: "integer",
                minimum: 1,
                maximum: MAX_PAGE_RESULTS,
                description: "Max threads to return (default: 20)",
              },
              labelIds: {
                type: "array",
                items: { type: "string" },
                description: "Filter by label IDs",
              },
              pageToken: PAGE_TOKEN_PROPERTY,
              includeSpamTrash: INCLUDE_SPAM_TRASH_PROPERTY,
              detailLevel: DETAIL_LEVEL_PROPERTY,
            },
            additionalProperties: false,
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
              maxBodyChars: {
                type: "integer",
                minimum: 1,
                maximum: MAX_BODY_CHARS,
                description: `Maximum characters per message body (default: ${DEFAULT_BODY_CHARS})`,
              },
            },
            required: ["threadId"],
            additionalProperties: false,
          },
        },
        handler: (a) => this.getThread(a),
      },
      // ── Label operations ──────────────────────────────
      {
        tool: {
          name: "list_labels",
          description:
            "List all Gmail labels (system and user-created). Use get_label_counts for totals.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
              labelListVisibility: {
                type: "string",
                enum: ["labelShow", "labelShowIfUnread", "labelHide"],
                description: "Visibility in Gmail's label list",
              },
              messageListVisibility: {
                type: "string",
                enum: ["show", "hide"],
                description: "Visibility in Gmail's message list",
              },
            },
            required: ["name"],
            additionalProperties: false,
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
            additionalProperties: false,
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
                minItems: 1,
                maxItems: 1000,
                uniqueItems: true,
                items: { type: "string" },
                description: "List of message IDs to modify",
              },
              addLabelIds: {
                type: "array",
                maxItems: 100,
                uniqueItems: true,
                items: { type: "string" },
                description: "Label IDs to add",
              },
              removeLabelIds: {
                type: "array",
                maxItems: 100,
                uniqueItems: true,
                items: { type: "string" },
                description: "Label IDs to remove",
              },
            },
            required: ["messageIds"],
            additionalProperties: false,
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
                minItems: 1,
                maxItems: 100,
                uniqueItems: true,
                items: { type: "string" },
                description: "List of message IDs to trash",
              },
            },
            required: ["messageIds"],
            additionalProperties: false,
          },
        },
        handler: (a) => this.batchTrashEmails(a),
      },
      // ── Attachments ───────────────────────────────────
      {
        tool: {
          name: "get_attachment",
          description:
            "Get an external attachment by attachmentId or an inline MIME part by partId. Encoding is explicit and output is size-bounded.",
          inputSchema: {
            type: "object",
            properties: {
              messageId: { type: "string", description: "The message ID containing the attachment" },
              attachmentId: {
                type: "string",
                description: "The attachment ID (from read_email attachment info)",
              },
              partId: {
                type: "string",
                description: "MIME part ID for inline data (from read_email)",
              },
              outputEncoding: {
                type: "string",
                enum: ["base64url", "base64"],
                description: "Output encoding (default: base64url for compatibility)",
              },
              maxBytes: {
                type: "integer",
                minimum: 1,
                maximum: MAX_ATTACHMENT_RETURN_BYTES,
                description: `Refuse to return data larger than this (default: ${DEFAULT_ATTACHMENT_RETURN_BYTES})`,
              },
              includeData: { type: "boolean", description: "Return bytes, or metadata only (default: true)" },
            },
            required: ["messageId"],
            additionalProperties: false,
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
                type: "integer",
                minimum: 1,
                maximum: MAX_PAGE_RESULTS,
                description: "Max drafts to return (default: 20)",
              },
              query: {
                type: "string",
                description: "Optional Gmail search query to filter drafts",
              },
              pageToken: PAGE_TOKEN_PROPERTY,
              includeSpamTrash: INCLUDE_SPAM_TRASH_PROPERTY,
              detailLevel: DETAIL_LEVEL_PROPERTY,
            },
            additionalProperties: false,
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
            additionalProperties: false,
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
              labelListVisibility: {
                type: "string",
                enum: ["labelShow", "labelShowIfUnread", "labelHide"],
              },
              messageListVisibility: { type: "string", enum: ["show", "hide"] },
            },
            required: ["labelId"],
            additionalProperties: false,
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
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
            additionalProperties: false,
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
              negatedQuery: { type: "string", description: "Gmail query that messages must not match" },
              excludeChats: { type: "boolean", description: "Exclude chats" },
              size: { type: "integer", minimum: 0, description: "RFC822 message size in bytes" },
              sizeComparison: { type: "string", enum: ["larger", "smaller"], description: "Compare message size" },
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
                description: "Verified forwarding address; this creates a persistent external action",
              },
              dryRun: { type: "boolean", description: "Validate and preview without creating the filter" },
            },
            additionalProperties: false,
          },
        },
        handler: (a) => this.createFilter(a),
      },
      {
        tool: {
          name: "list_filters",
          description: "List all Gmail filters (auto-organization rules).",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
            additionalProperties: false,
          },
        },
        handler: (a) => this.deleteFilter(a),
      },
      {
        tool: {
          name: "get_filter",
          description: "Get one Gmail filter with its complete criteria and actions.",
          inputSchema: {
            type: "object",
            properties: { filterId: { type: "string", description: "Filter ID" } },
            required: ["filterId"],
            additionalProperties: false,
          },
        },
        handler: (a) => this.getFilter(a),
      },
      {
        tool: {
          name: "get_draft",
          description: "Get a draft and its current message content without sending it.",
          inputSchema: {
            type: "object",
            properties: {
              draftId: { type: "string", description: "Draft ID" },
              maxBodyChars: { type: "integer", minimum: 1, maximum: MAX_BODY_CHARS },
            },
            required: ["draftId"],
            additionalProperties: false,
          },
        },
        handler: (a) => this.getDraft(a),
      },
      {
        tool: {
          name: "update_draft",
          description: "Replace an existing draft's recipients, subject, body, and attachments without sending it.",
          inputSchema: {
            type: "object",
            properties: {
              draftId: { type: "string", description: "Draft ID" },
              to: { type: "string" },
              subject: { type: "string" },
              body: { type: "string" },
              cc: { type: "string" },
              bcc: { type: "string" },
              from: { type: "string", description: "Configured send-as address" },
              replyTo: { type: "string" },
              isHtml: { type: "boolean" },
              plainTextBody: { type: "string" },
              threadId: { type: "string", description: "Preserve or assign a Gmail thread ID" },
              attachments: OUTBOUND_ATTACHMENT_SCHEMA,
            },
            required: ["draftId", "to", "subject", "body"],
            additionalProperties: false,
          },
        },
        handler: (a) => this.updateDraft(a),
      },
      {
        tool: {
          name: "create_reply_draft",
          description: "Create a reply in the original thread as a draft for human review.",
          inputSchema: {
            type: "object",
            properties: {
              messageId: { type: "string", description: "Message to reply to" },
              body: { type: "string" },
              replyAll: { type: "boolean" },
              isHtml: { type: "boolean" },
              plainTextBody: { type: "string" },
              attachments: OUTBOUND_ATTACHMENT_SCHEMA,
            },
            required: ["messageId", "body"],
            additionalProperties: false,
          },
        },
        handler: (a) => this.createReplyDraft(a),
      },
      {
        tool: {
          name: "modify_thread",
          description: "Add or remove labels on every current message in a Gmail thread.",
          inputSchema: {
            type: "object",
            properties: {
              threadId: { type: "string" },
              addLabelIds: { type: "array", items: { type: "string" }, maxItems: 100, uniqueItems: true },
              removeLabelIds: { type: "array", items: { type: "string" }, maxItems: 100, uniqueItems: true },
            },
            required: ["threadId"],
            additionalProperties: false,
          },
        },
        handler: (a) => this.modifyThread(a),
      },
      {
        tool: {
          name: "trash_thread",
          description: "Move an entire Gmail thread to trash (recoverable with untrash_thread).",
          inputSchema: {
            type: "object",
            properties: { threadId: { type: "string" } },
            required: ["threadId"],
            additionalProperties: false,
          },
        },
        handler: (a) => this.trashThread(a),
      },
      {
        tool: {
          name: "untrash_thread",
          description: "Restore a Gmail thread from trash.",
          inputSchema: {
            type: "object",
            properties: { threadId: { type: "string" } },
            required: ["threadId"],
            additionalProperties: false,
          },
        },
        handler: (a) => this.untrashThread(a),
      },
      {
        tool: {
          name: "untrash_email",
          description: "Restore one Gmail message from trash.",
          inputSchema: {
            type: "object",
            properties: { messageId: { type: "string" } },
            required: ["messageId"],
            additionalProperties: false,
          },
        },
        handler: (a) => this.untrashEmail(a),
      },
      {
        tool: {
          name: "list_send_as",
          description: "List configured Gmail send-as identities, defaults, reply-to addresses, and verification status.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        handler: (a) => this.listSendAs(a),
      },
      {
        tool: {
          name: "list_history",
          description: "List mailbox changes since a history ID for efficient incremental synchronization.",
          inputSchema: {
            type: "object",
            properties: {
              startHistoryId: { type: "string", description: "History ID from get_profile or a prior result" },
              historyTypes: {
                type: "array",
                items: { type: "string", enum: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"] },
                uniqueItems: true,
              },
              labelId: { type: "string" },
              maxResults: { type: "integer", minimum: 1, maximum: MAX_PAGE_RESULTS },
              pageToken: PAGE_TOKEN_PROPERTY,
            },
            required: ["startHistoryId"],
            additionalProperties: false,
          },
        },
        handler: (a) => this.listHistory(a),
      },
    ];
    const readOnly = new Set([
      "search_emails", "read_email", "list_threads", "get_thread", "list_labels",
      "get_attachment", "list_drafts", "get_draft", "get_profile", "get_label_counts",
      "list_filters", "get_filter", "list_send_as", "list_history",
    ]);
    const destructive = new Set([
      "modify_email", "trash_email", "delete_label", "batch_modify_emails",
      "batch_trash_emails", "delete_draft", "update_label", "create_filter",
      "delete_filter", "modify_thread", "trash_thread", "untrash_thread", "untrash_email",
    ]);
    const idempotent = new Set([
      "modify_email", "trash_email", "delete_label", "batch_modify_emails",
      "batch_trash_emails", "delete_draft", "update_label", "delete_filter",
      "modify_thread", "trash_thread", "untrash_thread", "untrash_email",
    ]);
    for (const definition of definitions) {
      const name = definition.tool.name;
      definition.tool.annotations = {
        title: name.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "),
        readOnlyHint: readOnly.has(name),
        destructiveHint: destructive.has(name),
        idempotentHint: idempotent.has(name),
        openWorldHint: true,
      };
    }
    return definitions;
  }

  // ── Handlers ────────────────────────────────────────────

  private async profileEmail(): Promise<string> {
    if (this.cachedProfileEmail) return this.cachedProfileEmail;
    const response = await this.gmail.users.getProfile({ userId: "me" });
    const email = response.data.emailAddress;
    if (!email) throw new Error("Gmail profile did not return an email address");
    this.cachedProfileEmail = email;
    return email;
  }

  private async sendAsIdentities(): Promise<gmail_v1.Schema$SendAs[]> {
    if (this.cachedSendAs) return this.cachedSendAs;
    const response = await this.gmail.users.settings.sendAs.list({ userId: "me" });
    this.cachedSendAs = response.data.sendAs || [];
    return this.cachedSendAs;
  }

  private async selfAddresses(): Promise<Set<string>> {
    const addresses = new Set([normalizeAddress(await this.profileEmail())]);
    try {
      for (const identity of await this.sendAsIdentities()) {
        if (identity.sendAsEmail) addresses.add(normalizeAddress(identity.sendAsEmail));
      }
    } catch {
      // The primary account is sufficient when settings access is unavailable.
    }
    return addresses;
  }

  private async resolveFrom(value?: string): Promise<string> {
    if (!value) return this.profileEmail();
    const parsed = parseAddressList(value, "from");
    if (parsed.length !== 1) throw new Error("'from' must contain exactly one address");
    const requested = normalizeAddress(parsed[0].address);
    const identity = (await this.sendAsIdentities())
      .find((item) => normalizeAddress(item.sendAsEmail || "") === requested);
    if (!identity) throw new Error(`'from' is not a configured Gmail send-as identity: ${requested}`);
    if (identity.verificationStatus && identity.verificationStatus !== "accepted") {
      throw new Error(`Send-as identity is not verified: ${requested}`);
    }
    return identity.displayName ? `${identity.displayName} <${requested}>` : requested;
  }

  private async composeRaw(args: Record<string, unknown>) {
    const to = requireString(args, "to");
    const subject = requireString(args, "subject");
    const body = requireString(args, "body");
    const cc = optionalString(args, "cc");
    const bcc = optionalString(args, "bcc");
    const replyTo = optionalString(args, "replyTo");
    const isHtml = optionalBoolean(args, "isHtml") || false;
    const plainTextBody = optionalString(args, "plainTextBody");
    const attachments = parseOutboundAttachments(args.attachments);
    const from = await this.resolveFrom(optionalString(args, "from"));
    const recipientCount = parseAddressList(to, "to").length
      + (cc ? parseAddressList(cc, "cc").length : 0)
      + (bcc ? parseAddressList(bcc, "bcc").length : 0);
    if (recipientCount > 500) throw new Error("Gmail supports at most 500 recipients per message");
    return {
      raw: await buildRawMessage({ from, to, subject, body, cc, bcc, replyTo, isHtml, plainTextBody, attachments }),
      from,
      to,
      subject,
      cc,
      bcc,
      attachmentCount: attachments.length,
    };
  }

  private async resolveReply(messageId: string, replyAll: boolean) {
    const response = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["Reply-To", "From", "To", "Cc", "Subject", "Message-ID", "References"],
    });
    const original = response.data;
    const headers = original.payload?.headers;
    const self = await this.selfAddresses();
    const replyTo = getHeader(headers, "Reply-To") || getHeader(headers, "From");
    const senders = parseAddressList(replyTo, "Reply-To", false)
      .filter((item) => !self.has(normalizeAddress(item.address)));
    const recipients = [getHeader(headers, "To"), getHeader(headers, "Cc")]
      .filter(Boolean)
      .flatMap((header) => parseAddressList(header, "recipient", false))
      .filter((item) => !self.has(normalizeAddress(item.address)));
    const all = [...senders, ...recipients];
    const deduped = all.filter((item, index) => all.findIndex(
      (candidate) => normalizeAddress(candidate.address) === normalizeAddress(item.address),
    ) === index);
    const primary = senders[0] || recipients[0];
    if (!primary) throw new Error("Could not determine a non-self reply recipient");
    const ccRecipients = replyAll
      ? deduped.filter((item) => normalizeAddress(item.address) !== normalizeAddress(primary.address))
      : [];
    const subject = getHeader(headers, "Subject");
    const messageIdHeader = getHeader(headers, "Message-ID");
    if (!messageIdHeader) throw new Error("Original message has no Message-ID header");
    const oldReferences = getHeader(headers, "References");
    const references = oldReferences.includes(messageIdHeader)
      ? oldReferences
      : [oldReferences, messageIdHeader].filter(Boolean).join(" ");
    const addressedSelf = [getHeader(headers, "To"), getHeader(headers, "Cc")]
      .flatMap((header) => parseAddressList(header, "recipient", false))
      .find((item) => self.has(normalizeAddress(item.address)));
    return {
      original,
      from: await this.resolveFrom(addressedSelf?.address),
      to: formatAddress(primary),
      cc: ccRecipients.length ? ccRecipients.map(formatAddress).join(", ") : undefined,
      subject: /^\s*(re|aw|sv):/i.test(subject) ? subject : `Re: ${subject}`,
      inReplyTo: messageIdHeader,
      references,
    };
  }

  private async messageView(msg: gmail_v1.Schema$Message, maxBodyChars: number) {
    const headers = msg.payload?.headers;
    const headerData = {
      from: getHeader(headers, "From"),
      to: getHeader(headers, "To"),
      cc: getHeader(headers, "Cc"),
      replyTo: getHeader(headers, "Reply-To"),
      subject: getHeader(headers, "Subject"),
      date: getHeader(headers, "Date"),
      messageIdHeader: getHeader(headers, "Message-ID"),
    };
    let body = "";
    let bodyMimeType: string | undefined;
    if (msg.payload) {
      const candidate = collectBodyCandidates(msg.payload)[0];
      if (candidate) {
        let encoded = candidate.part.body?.data || "";
        if (!encoded && candidate.part.body?.attachmentId && msg.id) {
          const response = await this.gmail.users.messages.attachments.get({
            userId: "me",
            messageId: msg.id,
            id: candidate.part.body.attachmentId,
          });
          encoded = response.data.data || "";
        }
        body = decodeBody(encoded);
        bodyMimeType = candidate.type;
        if (candidate.type === "text/html") body = htmlToMarkdown(body);
      }
    }
    const originalBodyLength = body.length;
    const bodyTruncated = originalBodyLength > maxBodyChars;
    if (bodyTruncated) body = `${body.slice(0, maxBodyChars)}\n...(truncated)`;
    const attachments = msg.payload ? extractAttachments(msg.payload) : [];
    const textLines = [fmtMessage(msg)];
    if (body) textLines.push("--- BEGIN UNTRUSTED EMAIL BODY ---", body, "--- END UNTRUSTED EMAIL BODY ---");
    if (attachments.length) {
      textLines.push("Attachments:");
      for (const item of attachments) {
        textLines.push(`  - ${safeDisplay(item.filename)} (${item.mimeType}, ${item.size} bytes, attachmentId: ${item.attachmentId || "none"}, partId: ${item.partId || "none"})`);
      }
    }
    const classificationLabelValues = (msg as gmail_v1.Schema$Message & { classificationLabelValues?: unknown[] }).classificationLabelValues;
    return {
      text: textLines.join("\n"),
      data: {
        id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds || [],
        internalDate: msg.internalDate, sizeEstimate: msg.sizeEstimate, headers: headerData,
        body, bodyMimeType, bodyTruncated, originalBodyLength, attachments,
        classificationLabelValues: classificationLabelValues || [],
      },
    };
  }

  private findPart(payload: gmail_v1.Schema$MessagePart | undefined, partId: string): gmail_v1.Schema$MessagePart | undefined {
    if (!payload) return undefined;
    if (payload.partId === partId) return payload;
    for (const child of payload.parts || []) {
      const found = this.findPart(child, partId);
      if (found) return found;
    }
    return undefined;
  }

  private findAttachmentPart(
    payload: gmail_v1.Schema$MessagePart | undefined,
    attachmentId: string,
  ): gmail_v1.Schema$MessagePart | undefined {
    if (!payload) return undefined;
    if (payload.body?.attachmentId === attachmentId) return payload;
    for (const child of payload.parts || []) {
      const found = this.findAttachmentPart(child, attachmentId);
      if (found) return found;
    }
    return undefined;
  }

  private async searchEmails(args: Record<string, unknown>) {
    const query = optionalString(args, "query");
    const maxResults = optionalInteger(args, "maxResults", 20, 1, MAX_PAGE_RESULTS);
    const labelIds = optionalStringArray(args, "labelIds", { maxItems: 100, allowEmpty: true });
    const pageToken = optionalString(args, "pageToken");
    const includeSpamTrash = optionalBoolean(args, "includeSpamTrash") || false;
    const detailLevel = optionalEnum(args, "detailLevel", ["ids", "metadata"] as const, "metadata");

    const listResp = await this.gmail.users.messages.list({
      userId: "me",
      q: query || undefined,
      maxResults,
      labelIds: labelIds || undefined,
      pageToken: pageToken || undefined,
      includeSpamTrash,
    });

    const messageRefs = listResp.data.messages || [];
    if (messageRefs.length === 0) {
      return structuredResponse(`No emails found${query ? ` for query: "${query}"` : ""}.`, {
        messages: [], nextPageToken: listResp.data.nextPageToken || null,
        resultSizeEstimate: listResp.data.resultSizeEstimate || 0,
      });
    }

    let messageData: Array<Record<string, unknown>>;
    let lines: string[];
    let failures = 0;
    if (detailLevel === "ids") {
      messageData = messageRefs.map((ref) => ({ id: ref.id, threadId: ref.threadId }));
      lines = messageRefs.map((ref) => `- ID: ${ref.id}  Thread: ${ref.threadId}`);
    } else {
      const results = await mapWithConcurrency(messageRefs, async (ref) => {
        const msg = await this.gmail.users.messages.get({
          userId: "me", id: ref.id!, format: "metadata",
          metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
          fields: "id,threadId,labelIds,internalDate,payload/headers",
        });
        return msg.data;
      });
      const messages = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      failures = results.length - messages.length;
      lines = messages.map(fmtMessage);
      messageData = messages.map((msg) => ({
        id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds || [], internalDate: msg.internalDate,
        headers: {
          from: getHeader(msg.payload?.headers, "From"), to: getHeader(msg.payload?.headers, "To"),
          cc: getHeader(msg.payload?.headers, "Cc"), subject: getHeader(msg.payload?.headers, "Subject"),
          date: getHeader(msg.payload?.headers, "Date"),
        },
      }));
    }

    const cursorLine = listResp.data.nextPageToken ? `\nNext page token: ${listResp.data.nextPageToken}` : "";
    const failureLine = failures ? `\n${failures} metadata fetch(es) failed.` : "";
    return structuredResponse(
      `Found ${messageRefs.length} emails (${listResp.data.resultSizeEstimate} estimated total):\n\n${lines.join("\n\n")}${cursorLine}${failureLine}`,
      { messages: messageData, nextPageToken: listResp.data.nextPageToken || null,
        resultSizeEstimate: listResp.data.resultSizeEstimate || 0, detailLevel, failures },
    );
  }

  private async readEmail(args: Record<string, unknown>) {
    const messageId = requireString(args, "messageId");
    const maxBodyChars = optionalInteger(args, "maxBodyChars", DEFAULT_BODY_CHARS, 1, MAX_BODY_CHARS);

    const msg = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const view = await this.messageView(msg.data, maxBodyChars);
    return structuredResponse(view.text, { message: view.data });
  }

  private async sendEmail(args: Record<string, unknown>) {
    const composed = await this.composeRaw(args);
    if (optionalBoolean(args, "dryRun") || false) {
      return structuredResponse(
        `Dry run only; email was not sent.\nFrom: ${composed.from}\nTo: ${composed.to}\nSubject: ${safeDisplay(composed.subject)}\nAttachments: ${composed.attachmentCount}`,
        { dryRun: true, sent: false, ...composed, raw: undefined },
      );
    }

    const response = await this.gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: composed.raw },
    });

    return structuredResponse(
      `Email sent!\nTo: ${composed.to}\nSubject: ${safeDisplay(composed.subject)}\nMessage ID: ${response.data.id}\nThread ID: ${response.data.threadId}`,
      { sent: true, messageId: response.data.id, threadId: response.data.threadId,
        to: composed.to, cc: composed.cc, bcc: composed.bcc, subject: composed.subject,
        attachmentCount: composed.attachmentCount },
    );
  }

  private async replyToEmail(args: Record<string, unknown>) {
    const messageId = requireString(args, "messageId");
    const body = requireString(args, "body");
    const replyAll = optionalBoolean(args, "replyAll") || false;
    const isHtml = optionalBoolean(args, "isHtml") || false;
    const reply = await this.resolveReply(messageId, replyAll);
    const attachments = parseOutboundAttachments(args.attachments);
    const raw = await buildRawMessage({
      from: reply.from, to: reply.to, subject: reply.subject, body, cc: reply.cc,
      inReplyTo: reply.inReplyTo, references: reply.references,
      isHtml,
      plainTextBody: optionalString(args, "plainTextBody"),
      attachments,
    });
    if (optionalBoolean(args, "dryRun") || false) {
      return structuredResponse(
        `Dry run only; reply was not sent.\nTo: ${reply.to}\nCc: ${reply.cc || ""}\nSubject: ${safeDisplay(reply.subject)}`,
        { dryRun: true, sent: false, to: reply.to, cc: reply.cc, subject: reply.subject,
          threadId: reply.original.threadId, attachmentCount: attachments.length },
      );
    }

    const response = await this.gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
        threadId: reply.original.threadId || undefined,
      },
    });

    return structuredResponse(
      `Reply sent!\nTo: ${reply.to}\nCc: ${reply.cc || ""}\nSubject: ${safeDisplay(reply.subject)}\nMessage ID: ${response.data.id}\nThread ID: ${response.data.threadId}`,
      { sent: true, messageId: response.data.id, threadId: response.data.threadId,
        to: reply.to, cc: reply.cc, subject: reply.subject, attachmentCount: attachments.length },
    );
  }

  private async draftEmail(args: Record<string, unknown>) {
    const composed = await this.composeRaw(args);

    const response = await this.gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: { raw: composed.raw },
      },
    });

    const messageId = response.data.message?.id;
    const draftLink = messageId
      ? `https://mail.google.com/mail/#drafts/${messageId}`
      : "https://mail.google.com/mail/#drafts";

    return structuredResponse(
      `Draft created!\nDraft ID: ${response.data.id}\nTo: ${composed.to}\nSubject: ${safeDisplay(composed.subject)}\nMessage ID: ${messageId}\nOpen in Gmail: ${draftLink}`,
      { draftId: response.data.id, messageId, threadId: response.data.message?.threadId,
        to: composed.to, subject: composed.subject, attachmentCount: composed.attachmentCount,
        gmailUrl: draftLink },
    );
  }

  private async sendDraft(args: Record<string, unknown>) {
    const draftId = requireString(args, "draftId");
    if (optionalBoolean(args, "dryRun") || false) {
      const draft = await this.gmail.users.drafts.get({ userId: "me", id: draftId, format: "metadata" });
      const headers = draft.data.message?.payload?.headers;
      return structuredResponse(
        `Dry run only; draft was not sent.\nTo: ${safeDisplay(getHeader(headers, "To"))}\nCc: ${safeDisplay(getHeader(headers, "Cc"))}\nSubject: ${safeDisplay(getHeader(headers, "Subject"))}`,
        { dryRun: true, sent: false, draftId, messageId: draft.data.message?.id,
          to: getHeader(headers, "To"), cc: getHeader(headers, "Cc"), subject: getHeader(headers, "Subject") },
      );
    }

    const response = await this.gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: draftId },
    });

    return structuredResponse(
      `Draft sent!\nMessage ID: ${response.data.id}\nThread ID: ${response.data.threadId}`,
      { sent: true, draftId, messageId: response.data.id, threadId: response.data.threadId },
    );
  }

  private async modifyEmail(args: Record<string, unknown>) {
    const messageId = requireString(args, "messageId");
    const addLabelIds = optionalStringArray(args, "addLabelIds", { maxItems: 100, allowEmpty: true });
    const removeLabelIds = optionalStringArray(args, "removeLabelIds", { maxItems: 100, allowEmpty: true });

    if (!addLabelIds?.length && !removeLabelIds?.length) {
      throw new Error("Specify addLabelIds and/or removeLabelIds to modify");
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

    return structuredResponse(
      `Message ${messageId} modified.\n${changes.join("\n")}`,
      { messageId, addLabelIds: addLabelIds || [], removeLabelIds: removeLabelIds || [] },
    );
  }

  private async trashEmail(args: Record<string, unknown>) {
    const messageId = requireString(args, "messageId");

    await this.gmail.users.messages.trash({
      userId: "me",
      id: messageId,
    });

    return structuredResponse(`Message ${messageId} moved to trash.`, { messageId, trashed: true });
  }

  // ── Threads ────────────────────────────────────────────

  private async listThreads(args: Record<string, unknown>) {
    const query = optionalString(args, "query");
    const maxResults = optionalInteger(args, "maxResults", 20, 1, MAX_PAGE_RESULTS);
    const labelIds = optionalStringArray(args, "labelIds", { maxItems: 100, allowEmpty: true });
    const pageToken = optionalString(args, "pageToken");
    const includeSpamTrash = optionalBoolean(args, "includeSpamTrash") || false;
    const detailLevel = optionalEnum(args, "detailLevel", ["ids", "metadata"] as const, "metadata");

    const response = await this.gmail.users.threads.list({
      userId: "me",
      q: query || undefined,
      maxResults,
      labelIds: labelIds || undefined,
      pageToken: pageToken || undefined,
      includeSpamTrash,
    });

    const threads = response.data.threads || [];
    if (threads.length === 0) {
      return structuredResponse("No threads found.", {
        threads: [], nextPageToken: response.data.nextPageToken || null,
        resultSizeEstimate: response.data.resultSizeEstimate || 0,
      });
    }

    let lines: string[];
    let threadData: Array<Record<string, unknown>>;
    let failures = 0;
    if (detailLevel === "ids") {
      lines = threads.map((thread) => `- Thread ID: ${thread.id}${thread.snippet ? `\n  Snippet: ${safeDisplay(thread.snippet)}` : ""}`);
      threadData = threads.map((thread) => ({ id: thread.id, snippet: thread.snippet, historyId: thread.historyId }));
    } else {
      const results = await mapWithConcurrency(threads, async (item) => {
        const thread = await this.gmail.users.threads.get({
          userId: "me", id: item.id!, format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
          fields: "id,historyId,snippet,messages(id,threadId,labelIds,internalDate,payload/headers)",
        });
        return thread.data;
      });
      const fetched = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      failures = results.length - fetched.length;
      lines = fetched.map((thread) => {
        const latest = thread.messages?.at(-1);
        const headers = latest?.payload?.headers;
        return `- ${safeDisplay(getHeader(headers, "Subject")) || "(no subject)"} (${thread.messages?.length || 0} messages)\n  Latest from: ${safeDisplay(getHeader(headers, "From"))}\n  Date: ${safeDisplay(getHeader(headers, "Date"))}\n  Thread ID: ${thread.id}`;
      });
      threadData = fetched.map((thread) => {
        const latest = thread.messages?.at(-1);
        return { id: thread.id, historyId: thread.historyId, snippet: thread.snippet,
          messageCount: thread.messages?.length || 0, latestMessageId: latest?.id,
          latestHeaders: { from: getHeader(latest?.payload?.headers, "From"),
            to: getHeader(latest?.payload?.headers, "To"), subject: getHeader(latest?.payload?.headers, "Subject"),
            date: getHeader(latest?.payload?.headers, "Date") } };
      });
    }

    return structuredResponse(
      `Found ${threads.length} threads:\n\n${lines.join("\n\n")}${response.data.nextPageToken ? `\nNext page token: ${response.data.nextPageToken}` : ""}${failures ? `\n${failures} metadata fetch(es) failed.` : ""}`,
      { threads: threadData, nextPageToken: response.data.nextPageToken || null,
        resultSizeEstimate: response.data.resultSizeEstimate || 0, detailLevel, failures },
    );
  }

  private async getThread(args: Record<string, unknown>) {
    const threadId = requireString(args, "threadId");
    const maxBodyChars = optionalInteger(args, "maxBodyChars", DEFAULT_BODY_CHARS, 1, MAX_BODY_CHARS);

    const thread = await this.gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });

    const messages = thread.data.messages || [];
    const views = await mapWithConcurrency(messages, (message) => this.messageView(message, maxBodyChars));
    const successful = views.flatMap((view) => view.status === "fulfilled" ? [view.value] : []);
    const formatted = successful.map((view, i) => `[Message ${i + 1}/${successful.length}]\n${view.text}`)
      .join("\n\n" + "=".repeat(60) + "\n\n");

    return structuredResponse(
      `Thread: ${threadId} (${messages.length} messages)\n\n${formatted}`,
      { threadId, historyId: thread.data.historyId, messages: successful.map((view) => view.data),
        failures: views.length - successful.length },
    );
  }

  private async modifyThread(args: Record<string, unknown>) {
    const threadId = requireString(args, "threadId");
    const addLabelIds = optionalStringArray(args, "addLabelIds", { maxItems: 100, allowEmpty: true });
    const removeLabelIds = optionalStringArray(args, "removeLabelIds", { maxItems: 100, allowEmpty: true });
    if (!addLabelIds?.length && !removeLabelIds?.length) {
      throw new Error("Specify addLabelIds and/or removeLabelIds to modify");
    }
    const response = await this.gmail.users.threads.modify({
      userId: "me",
      id: threadId,
      requestBody: { addLabelIds: addLabelIds || [], removeLabelIds: removeLabelIds || [] },
    });
    return structuredResponse(
      `Thread ${threadId} modified.${addLabelIds?.length ? `\nAdded: ${addLabelIds.join(", ")}` : ""}${removeLabelIds?.length ? `\nRemoved: ${removeLabelIds.join(", ")}` : ""}`,
      { threadId, addLabelIds: addLabelIds || [], removeLabelIds: removeLabelIds || [],
        affectedMessageIds: (response.data.messages || []).map((message) => message.id) },
    );
  }

  private async trashThread(args: Record<string, unknown>) {
    const threadId = requireString(args, "threadId");
    const response = await this.gmail.users.threads.trash({ userId: "me", id: threadId });
    return structuredResponse(
      `Thread ${threadId} moved to trash.`,
      { threadId: response.data.id || threadId, trashed: true,
        messageIds: (response.data.messages || []).map((message) => message.id) },
    );
  }

  private async untrashThread(args: Record<string, unknown>) {
    const threadId = requireString(args, "threadId");
    const response = await this.gmail.users.threads.untrash({ userId: "me", id: threadId });
    return structuredResponse(
      `Thread ${threadId} restored from trash.`,
      { threadId: response.data.id || threadId, trashed: false,
        messageIds: (response.data.messages || []).map((message) => message.id) },
    );
  }

  private async untrashEmail(args: Record<string, unknown>) {
    const messageId = requireString(args, "messageId");
    const response = await this.gmail.users.messages.untrash({ userId: "me", id: messageId });
    return structuredResponse(
      `Message ${messageId} restored from trash.`,
      { messageId: response.data.id || messageId, threadId: response.data.threadId, trashed: false },
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
    const format = (label: gmail_v1.Schema$Label) =>
      `  - ${safeDisplay(label.name || "(unnamed)")} (ID: ${label.id})`;
    const output = [
      "System labels:",
      ...(system.length ? system.map(format) : ["  (none)"]),
      "",
      "User labels:",
      ...(user.length ? user.map(format) : ["  (none)"]),
    ].join("\n");

    return structuredResponse(output, {
      labels: labels.map((label) => ({
        id: label.id,
        name: label.name,
        type: label.type,
        color: label.color || null,
        labelListVisibility: label.labelListVisibility,
        messageListVisibility: label.messageListVisibility,
      })),
      systemCount: system.length,
      userCount: user.length,
    });
  }

  private async createLabel(args: Record<string, unknown>) {
    const name = requireString(args, "name");
    const backgroundColor = optionalString(args, "backgroundColor");
    const textColor = optionalString(args, "textColor");
    const labelListVisibility = optionalEnum(
      args,
      "labelListVisibility",
      ["labelShow", "labelShowIfUnread", "labelHide"] as const,
      "labelShow",
    );
    const messageListVisibility = optionalEnum(
      args,
      "messageListVisibility",
      ["show", "hide"] as const,
      "show",
    );

    if (backgroundColor !== undefined && !LABEL_COLORS.has(backgroundColor.toLowerCase())) {
      throw new Error(`Unsupported Gmail label background color: ${backgroundColor}`);
    }
    if (textColor !== undefined && !LABEL_COLORS.has(textColor.toLowerCase())) {
      throw new Error(`Unsupported Gmail label text color: ${textColor}`);
    }

    const label: gmail_v1.Schema$Label = {
      name,
      labelListVisibility,
      messageListVisibility,
    };

    if (backgroundColor !== undefined || textColor !== undefined) {
      label.color = {
        backgroundColor: (backgroundColor || "#000000").toLowerCase(),
        textColor: (textColor || "#ffffff").toLowerCase(),
      };
    }

    const response = await this.gmail.users.labels.create({
      userId: "me",
      requestBody: label,
    });

    return structuredResponse(
      `Label created!\nName: ${safeDisplay(response.data.name || "")}\nID: ${response.data.id}`,
      { label: response.data },
    );
  }

  private async deleteLabel(args: Record<string, unknown>) {
    const labelId = requireString(args, "labelId");

    await this.gmail.users.labels.delete({
      userId: "me",
      id: labelId,
    });

    return structuredResponse(`Label ${labelId} deleted.`, { labelId, deleted: true });
  }

  // ── Batch operations ───────────────────────────────────

  private async batchModifyEmails(args: Record<string, unknown>) {
    const messageIds = optionalStringArray(args, "messageIds", { maxItems: 1000 });
    if (!messageIds) throw new Error("'messageIds' is required");
    const addLabelIds = optionalStringArray(args, "addLabelIds", { maxItems: 100, allowEmpty: true });
    const removeLabelIds = optionalStringArray(args, "removeLabelIds", { maxItems: 100, allowEmpty: true });
    if (!addLabelIds?.length && !removeLabelIds?.length) {
      throw new Error("Specify addLabelIds and/or removeLabelIds to modify");
    }

    await this.gmail.users.messages.batchModify({
      userId: "me",
      requestBody: {
        ids: messageIds,
        addLabelIds: addLabelIds || [],
        removeLabelIds: removeLabelIds || [],
      },
    });

    return structuredResponse(
      `Batch modified ${messageIds.length} messages.${addLabelIds?.length ? `\nAdded: ${addLabelIds.join(", ")}` : ""}${removeLabelIds?.length ? `\nRemoved: ${removeLabelIds.join(", ")}` : ""}`,
      { messageIds, modifiedCount: messageIds.length, addLabelIds: addLabelIds || [], removeLabelIds: removeLabelIds || [] },
    );
  }

  private async batchTrashEmails(args: Record<string, unknown>) {
    const messageIds = optionalStringArray(args, "messageIds", { maxItems: 100 });
    if (!messageIds) throw new Error("'messageIds' is required");

    // Gmail has no batch-trash endpoint. Bound concurrency and preserve per-message outcomes.
    const outcomes = await mapWithConcurrency(messageIds, async (id) => {
      await this.gmail.users.messages.trash({ userId: "me", id });
      return id;
    });
    const succeeded = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
    const failed = outcomes.flatMap((outcome, index) => outcome.status === "rejected"
      ? [{ messageId: messageIds[index], error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) }]
      : []);

    return structuredResponse(
      `Trashed ${succeeded.length} of ${messageIds.length} messages.${failed.length ? `\nFailed: ${failed.map((item) => item.messageId).join(", ")}` : ""}`,
      { requestedCount: messageIds.length, trashedCount: succeeded.length, succeeded, failed },
    );
  }

  // ── Attachments ────────────────────────────────────────

  private async getAttachment(args: Record<string, unknown>) {
    const messageId = requireString(args, "messageId");
    const attachmentId = optionalString(args, "attachmentId");
    const partId = optionalString(args, "partId");
    if (Boolean(attachmentId) === Boolean(partId)) {
      throw new Error("Provide exactly one of 'attachmentId' or 'partId'");
    }
    const outputEncoding = optionalEnum(args, "outputEncoding", ["base64url", "base64"] as const, "base64url");
    const maxBytes = optionalInteger(
      args,
      "maxBytes",
      DEFAULT_ATTACHMENT_RETURN_BYTES,
      1,
      MAX_ATTACHMENT_RETURN_BYTES,
    );
    const includeData = optionalBoolean(args, "includeData") ?? true;

    let encodedData: string | undefined;
    let resolvedAttachmentId = attachmentId;
    let metadata: Record<string, unknown> = {};
    if (attachmentId) {
      if (includeData) {
        const response = await this.gmail.users.messages.attachments.get({
          userId: "me",
          messageId,
          id: attachmentId,
        });
        encodedData = response.data.data || "";
        metadata = { apiReportedSize: response.data.size || null };
      } else {
        const message = await this.gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
        const part = this.findAttachmentPart(message.data.payload, attachmentId);
        if (!part) throw new Error(`Attachment '${attachmentId}' was not found in message '${messageId}'`);
        metadata = {
          filename: part.filename || null,
          mimeType: part.mimeType || "application/octet-stream",
          disposition: contentDisposition(part) || null,
          contentId: getHeader(part.headers, "Content-ID") || null,
          apiReportedSize: part.body?.size || null,
        };
      }
    } else {
      const message = await this.gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
      const part = this.findPart(message.data.payload, partId!);
      if (!part) throw new Error(`MIME part '${partId}' was not found in message '${messageId}'`);
      resolvedAttachmentId = part.body?.attachmentId || undefined;
      metadata = {
        filename: part.filename || null,
        mimeType: part.mimeType || "application/octet-stream",
        disposition: contentDisposition(part) || null,
        contentId: getHeader(part.headers, "Content-ID") || null,
        apiReportedSize: part.body?.size || null,
      };
      const reportedSize = part.body?.size || 0;
      const shouldReadData = includeData && reportedSize <= maxBytes;
      encodedData = shouldReadData ? part.body?.data || undefined : undefined;
      if (shouldReadData && !encodedData && resolvedAttachmentId) {
        const response = await this.gmail.users.messages.attachments.get({
          userId: "me",
          messageId,
          id: resolvedAttachmentId,
        });
        encodedData = response.data.data || "";
      }
      if (shouldReadData && !encodedData && !resolvedAttachmentId) {
        throw new Error(`MIME part '${partId}' has no retrievable body data`);
      }
    }

    const bytes = encodedData === undefined ? undefined : Buffer.from(encodedData, "base64url");
    const reportedSize = typeof metadata.apiReportedSize === "number" ? metadata.apiReportedSize : 0;
    const size = bytes?.length ?? reportedSize;
    const tooLarge = size > maxBytes;
    const data = includeData && !tooLarge && bytes ? bytes.toString(outputEncoding) : undefined;
    const result = {
      messageId,
      attachmentId: resolvedAttachmentId || null,
      partId: partId || null,
      size,
      outputEncoding,
      includeData,
      dataReturned: data !== undefined,
      exceedsMaxBytes: tooLarge,
      data: data || null,
      ...metadata,
    };
    const status = tooLarge
      ? `Attachment is ${size} bytes, above maxBytes=${maxBytes}; data was not returned.`
      : includeData
        ? `Attachment retrieved (${size} bytes).\n${outputEncoding} data:\n${data}`
        : `Attachment metadata retrieved (${size} bytes); data was not requested.`;
    return structuredResponse(
      status,
      result,
    );
  }

  // ── Drafts ─────────────────────────────────────────────

  private async listDrafts(args: Record<string, unknown>) {
    const maxResults = optionalInteger(args, "maxResults", 20, 1, MAX_PAGE_RESULTS);
    const query = optionalString(args, "query");
    const pageToken = optionalString(args, "pageToken");
    const includeSpamTrash = optionalBoolean(args, "includeSpamTrash") || false;
    const detailLevel = optionalEnum(args, "detailLevel", ["ids", "metadata"] as const, "metadata");

    const response = await this.gmail.users.drafts.list({
      userId: "me",
      maxResults,
      q: query || undefined,
      pageToken: pageToken || undefined,
      includeSpamTrash,
    });

    const drafts = response.data.drafts || [];
    if (drafts.length === 0) {
      return structuredResponse("No drafts found.", {
        drafts: [], nextPageToken: response.data.nextPageToken || null,
        resultSizeEstimate: response.data.resultSizeEstimate || 0,
      });
    }

    let draftData: Array<Record<string, unknown>>;
    let lines: string[];
    let failures = 0;
    if (detailLevel === "ids") {
      draftData = drafts.map((draft) => ({
        id: draft.id,
        messageId: draft.message?.id,
        threadId: draft.message?.threadId,
      }));
      lines = draftData.map((draft) =>
        `- Draft ID: ${draft.id}\n  Message ID: ${draft.messageId || "unknown"}\n  Thread ID: ${draft.threadId || "unknown"}`,
      );
    } else {
      const outcomes = await mapWithConcurrency(drafts, async (item) => {
        const draft = await this.gmail.users.drafts.get({
          userId: "me",
          id: item.id!,
          format: "metadata",
          fields: "id,message(id,threadId,labelIds,internalDate,payload/headers)",
        });
        return draft.data;
      });
      const fetched = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
      failures = outcomes.length - fetched.length;
      draftData = fetched.map((draft) => {
        const headers = draft.message?.payload?.headers;
        return {
          id: draft.id,
          messageId: draft.message?.id,
          threadId: draft.message?.threadId,
          labelIds: draft.message?.labelIds || [],
          internalDate: draft.message?.internalDate,
          headers: {
            from: getHeader(headers, "From"),
            to: getHeader(headers, "To"),
            cc: getHeader(headers, "Cc"),
            subject: getHeader(headers, "Subject"),
            date: getHeader(headers, "Date"),
          },
        };
      });
      lines = draftData.map((draft) => {
        const headers = draft.headers as Record<string, string>;
        return `- Draft ID: ${draft.id}\n  To: ${safeDisplay(headers.to || "")}\n  Subject: ${safeDisplay(headers.subject || "")}\n  Message ID: ${draft.messageId}`;
      });
    }

    return structuredResponse(
      `Found ${drafts.length} drafts:\n\n${lines.join("\n\n")}${response.data.nextPageToken ? `\nNext page token: ${response.data.nextPageToken}` : ""}${failures ? `\n${failures} metadata fetch(es) failed.` : ""}`,
      { drafts: draftData, nextPageToken: response.data.nextPageToken || null,
        resultSizeEstimate: response.data.resultSizeEstimate || 0, detailLevel, failures },
    );
  }

  private async deleteDraft(args: Record<string, unknown>) {
    const draftId = requireString(args, "draftId");

    await this.gmail.users.drafts.delete({
      userId: "me",
      id: draftId,
    });

    return structuredResponse(
      `Draft ${draftId} permanently deleted.`,
      { draftId, deleted: true, permanent: true },
    );
  }

  private async getDraft(args: Record<string, unknown>) {
    const draftId = requireString(args, "draftId");
    const maxBodyChars = optionalInteger(args, "maxBodyChars", DEFAULT_BODY_CHARS, 1, MAX_BODY_CHARS);
    const response = await this.gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
    if (!response.data.message) throw new Error(`Draft '${draftId}' has no message`);
    const view = await this.messageView(response.data.message, maxBodyChars);
    return structuredResponse(
      `Draft ID: ${draftId}\n${view.text}`,
      { draftId, message: view.data },
    );
  }

  private async updateDraft(args: Record<string, unknown>) {
    const draftId = requireString(args, "draftId");
    const composed = await this.composeRaw(args);
    let threadId = optionalString(args, "threadId");
    if (!threadId) {
      const current = await this.gmail.users.drafts.get({
        userId: "me",
        id: draftId,
        format: "minimal",
        fields: "message/threadId",
      });
      threadId = current.data.message?.threadId || undefined;
    }
    const response = await this.gmail.users.drafts.update({
      userId: "me",
      id: draftId,
      requestBody: { message: { raw: composed.raw, threadId } },
    });
    return structuredResponse(
      `Draft updated!\nDraft ID: ${response.data.id}\nMessage ID: ${response.data.message?.id}\nTo: ${composed.to}\nSubject: ${safeDisplay(composed.subject)}`,
      { draftId: response.data.id, messageId: response.data.message?.id,
        threadId: response.data.message?.threadId, to: composed.to, subject: composed.subject,
        attachmentCount: composed.attachmentCount },
    );
  }

  private async createReplyDraft(args: Record<string, unknown>) {
    const messageId = requireString(args, "messageId");
    const body = requireString(args, "body");
    const replyAll = optionalBoolean(args, "replyAll") || false;
    const reply = await this.resolveReply(messageId, replyAll);
    const attachments = parseOutboundAttachments(args.attachments);
    const raw = await buildRawMessage({
      from: reply.from,
      to: reply.to,
      cc: reply.cc,
      subject: reply.subject,
      body,
      inReplyTo: reply.inReplyTo,
      references: reply.references,
      isHtml: optionalBoolean(args, "isHtml") || false,
      plainTextBody: optionalString(args, "plainTextBody"),
      attachments,
    });
    const response = await this.gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw, threadId: reply.original.threadId || undefined } },
    });
    return structuredResponse(
      `Reply draft created!\nDraft ID: ${response.data.id}\nTo: ${reply.to}\nCc: ${reply.cc || ""}\nSubject: ${safeDisplay(reply.subject)}`,
      { draftId: response.data.id, messageId: response.data.message?.id,
        threadId: response.data.message?.threadId, to: reply.to, cc: reply.cc,
        subject: reply.subject, attachmentCount: attachments.length },
    );
  }

  // ── Label management ───────────────────────────────────

  private async updateLabel(args: Record<string, unknown>) {
    const labelId = requireString(args, "labelId");
    const name = optionalString(args, "name");
    const backgroundColor = optionalString(args, "backgroundColor");
    const textColor = optionalString(args, "textColor");
    const labelListVisibility = args.labelListVisibility === undefined
      ? undefined
      : optionalEnum(
        args,
        "labelListVisibility",
        ["labelShow", "labelShowIfUnread", "labelHide"] as const,
        "labelShow",
      );
    const messageListVisibility = args.messageListVisibility === undefined
      ? undefined
      : optionalEnum(args, "messageListVisibility", ["show", "hide"] as const, "show");

    if (name !== undefined && name.trim() === "") throw new Error("'name' must not be empty");
    if (backgroundColor !== undefined && !LABEL_COLORS.has(backgroundColor.toLowerCase())) {
      throw new Error(`Unsupported Gmail label background color: ${backgroundColor}`);
    }
    if (textColor !== undefined && !LABEL_COLORS.has(textColor.toLowerCase())) {
      throw new Error(`Unsupported Gmail label text color: ${textColor}`);
    }

    const update: gmail_v1.Schema$Label = {};
    if (name !== undefined) update.name = name;
    if (labelListVisibility !== undefined) update.labelListVisibility = labelListVisibility;
    if (messageListVisibility !== undefined) update.messageListVisibility = messageListVisibility;
    if (backgroundColor !== undefined || textColor !== undefined) {
      let currentColor: gmail_v1.Schema$LabelColor | undefined;
      if (backgroundColor === undefined || textColor === undefined) {
        const current = await this.gmail.users.labels.get({ userId: "me", id: labelId });
        currentColor = current.data.color || undefined;
      }
      update.color = {
        backgroundColor: (backgroundColor || currentColor?.backgroundColor || "#000000").toLowerCase(),
        textColor: (textColor || currentColor?.textColor || "#ffffff").toLowerCase(),
      };
    }
    if (Object.keys(update).length === 0) throw new Error("No label updates were provided");

    const response = await this.gmail.users.labels.patch({
      userId: "me",
      id: labelId,
      requestBody: update,
    });

    return structuredResponse(
      `Label updated: "${safeDisplay(response.data.name || "")}" (ID: ${response.data.id})`,
      { label: response.data },
    );
  }

  // ── Profile & counts ───────────────────────────────────

  private async getProfile(_args: Record<string, unknown>) {
    const response = await this.gmail.users.getProfile({ userId: "me" });
    const p = response.data;
    if (p.emailAddress) this.cachedProfileEmail = p.emailAddress;

    return structuredResponse(
      `Email: ${p.emailAddress}\nTotal messages: ${p.messagesTotal}\nTotal threads: ${p.threadsTotal}\nHistory ID: ${p.historyId}`,
      { emailAddress: p.emailAddress, messagesTotal: p.messagesTotal,
        threadsTotal: p.threadsTotal, historyId: p.historyId },
    );
  }

  private async getLabelCounts(args: Record<string, unknown>) {
    const labelId = requireString(args, "labelId");

    const response = await this.gmail.users.labels.get({
      userId: "me",
      id: labelId,
    });

    const l = response.data;
    return structuredResponse(
      `Label: ${l.name} (${l.id})\nMessages: ${l.messagesTotal} total, ${l.messagesUnread} unread\nThreads: ${l.threadsTotal} total, ${l.threadsUnread} unread`,
      { label: { id: l.id, name: l.name, type: l.type,
        messagesTotal: l.messagesTotal, messagesUnread: l.messagesUnread,
        threadsTotal: l.threadsTotal, threadsUnread: l.threadsUnread,
        color: l.color || null, labelListVisibility: l.labelListVisibility,
        messageListVisibility: l.messageListVisibility } },
    );
  }

  private async listSendAs(_args: Record<string, unknown>) {
    const identities = await this.sendAsIdentities();
    const data = identities.map((identity) => ({
      email: identity.sendAsEmail,
      displayName: identity.displayName,
      replyToAddress: identity.replyToAddress,
      isPrimary: identity.isPrimary || false,
      isDefault: identity.isDefault || false,
      treatAsAlias: identity.treatAsAlias,
      verificationStatus: identity.verificationStatus,
    }));
    const lines = data.map((identity) =>
      `- ${safeDisplay(identity.displayName || "")} <${identity.email}>${identity.isDefault ? " [default]" : ""}${identity.isPrimary ? " [primary]" : ""}\n  Verification: ${identity.verificationStatus || "unknown"}${identity.replyToAddress ? `\n  Reply-To: ${identity.replyToAddress}` : ""}`,
    );
    return structuredResponse(
      identities.length ? `${identities.length} send-as identit${identities.length === 1 ? "y" : "ies"}:\n\n${lines.join("\n\n")}` : "No send-as identities found.",
      { sendAs: data },
    );
  }

  private async listHistory(args: Record<string, unknown>) {
    const startHistoryId = requireString(args, "startHistoryId");
    const historyTypes = optionalStringArray(args, "historyTypes", { maxItems: 4, allowEmpty: true });
    const allowedTypes = new Set(["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]);
    const invalidType = historyTypes?.find((value) => !allowedTypes.has(value));
    if (invalidType) throw new Error(`Unsupported history type: ${invalidType}`);
    const labelId = optionalString(args, "labelId");
    const maxResults = optionalInteger(args, "maxResults", 100, 1, MAX_PAGE_RESULTS);
    const pageToken = optionalString(args, "pageToken");
    const response = await this.gmail.users.history.list({
      userId: "me",
      startHistoryId,
      historyTypes: historyTypes?.length ? historyTypes : undefined,
      labelId: labelId || undefined,
      maxResults,
      pageToken: pageToken || undefined,
    });
    const history = response.data.history || [];
    const data = history.map((record) => ({
      id: record.id,
      messages: (record.messages || []).map((message) => ({ id: message.id, threadId: message.threadId })),
      messagesAdded: (record.messagesAdded || []).map((change) => ({
        id: change.message?.id, threadId: change.message?.threadId,
        labelIds: change.message?.labelIds || [],
      })),
      messagesDeleted: (record.messagesDeleted || []).map((change) => ({
        id: change.message?.id, threadId: change.message?.threadId,
        labelIds: change.message?.labelIds || [],
      })),
      labelsAdded: (record.labelsAdded || []).map((change) => ({
        id: change.message?.id, threadId: change.message?.threadId,
        labelIds: change.labelIds || [],
      })),
      labelsRemoved: (record.labelsRemoved || []).map((change) => ({
        id: change.message?.id, threadId: change.message?.threadId,
        labelIds: change.labelIds || [],
      })),
    }));
    const lines = data.map((record) =>
      `- History ID: ${record.id}\n  Added: ${record.messagesAdded.length}; deleted: ${record.messagesDeleted.length}; labels added: ${record.labelsAdded.length}; labels removed: ${record.labelsRemoved.length}`,
    );
    return structuredResponse(
      `${history.length} history record(s) since ${startHistoryId}.${lines.length ? `\n\n${lines.join("\n\n")}` : ""}${response.data.nextPageToken ? `\nNext page token: ${response.data.nextPageToken}` : ""}\nLatest history ID: ${response.data.historyId || startHistoryId}`,
      { history: data, nextPageToken: response.data.nextPageToken || null,
        historyId: response.data.historyId || null, startHistoryId },
    );
  }

  // ── Filters ────────────────────────────────────────────

  private filterData(filter: gmail_v1.Schema$Filter) {
    const criteria = filter.criteria || {};
    const action = filter.action || {};
    return {
      id: filter.id,
      criteria: {
        from: criteria.from || null,
        to: criteria.to || null,
        subject: criteria.subject || null,
        query: criteria.query || null,
        negatedQuery: criteria.negatedQuery || null,
        hasAttachment: criteria.hasAttachment ?? null,
        excludeChats: criteria.excludeChats ?? null,
        size: criteria.size ?? null,
        sizeComparison: criteria.sizeComparison || null,
      },
      action: {
        addLabelIds: action.addLabelIds || [],
        removeLabelIds: action.removeLabelIds || [],
        forward: action.forward || null,
      },
    };
  }

  private formatFilter(filter: gmail_v1.Schema$Filter): string {
    const data = this.filterData(filter);
    const criteria = Object.entries(data.criteria)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => `${key}:${String(value)}`);
    const actions: string[] = [];
    if (data.action.addLabelIds.length) actions.push(`add labels: ${data.action.addLabelIds.join(", ")}`);
    if (data.action.removeLabelIds.length) actions.push(`remove labels: ${data.action.removeLabelIds.join(", ")}`);
    if (data.action.forward) actions.push(`forward: ${data.action.forward}`);
    return `- ID: ${data.id}\n  Match: ${criteria.join(", ") || "(none)"}\n  Actions: ${actions.join(", ") || "(none)"}`;
  }

  private async createFilter(args: Record<string, unknown>) {
    const from = optionalString(args, "from");
    const to = optionalString(args, "to");
    const subject = optionalString(args, "subject");
    const query = optionalString(args, "query");
    const hasAttachment = optionalBoolean(args, "hasAttachment");
    const negatedQuery = optionalString(args, "negatedQuery");
    const excludeChats = optionalBoolean(args, "excludeChats");
    const rawSize = optionalNumber(args, "size");
    if (rawSize !== undefined && (!Number.isSafeInteger(rawSize) || rawSize < 0)) {
      throw new Error("'size' must be a non-negative integer");
    }
    const size = rawSize;
    const sizeComparison = args.sizeComparison === undefined
      ? undefined
      : optionalEnum(args, "sizeComparison", ["larger", "smaller"] as const, "larger");
    if ((size === undefined) !== (sizeComparison === undefined)) {
      throw new Error("'size' and 'sizeComparison' must be provided together");
    }
    const addLabelIds = optionalStringArray(args, "addLabelIds", { maxItems: 100, allowEmpty: true });
    const removeLabelIds = optionalStringArray(args, "removeLabelIds", { maxItems: 100, allowEmpty: true });
    const forwardInput = optionalString(args, "forward");
    let forward: string | undefined;
    if (forwardInput !== undefined) {
      const parsed = parseAddressList(forwardInput, "forward");
      if (parsed.length !== 1) throw new Error("'forward' must contain exactly one verified forwarding address");
      forward = parsed[0].address;
    }
    const userLabels = (addLabelIds || []).filter((id) => !SYSTEM_LABEL_IDS.has(id));
    if (userLabels.length > 1) {
      throw new Error("A Gmail filter can add at most one user-created label");
    }

    const criteria: gmail_v1.Schema$FilterCriteria = {};
    if (from !== undefined) criteria.from = from;
    if (to !== undefined) criteria.to = to;
    if (subject !== undefined) criteria.subject = subject;
    if (query !== undefined) criteria.query = query;
    if (negatedQuery !== undefined) criteria.negatedQuery = negatedQuery;
    if (hasAttachment !== undefined) criteria.hasAttachment = hasAttachment;
    if (excludeChats !== undefined) criteria.excludeChats = excludeChats;
    if (size !== undefined) criteria.size = size;
    if (sizeComparison !== undefined) criteria.sizeComparison = sizeComparison;

    const action: gmail_v1.Schema$FilterAction = {};
    if (addLabelIds?.length) action.addLabelIds = addLabelIds;
    if (removeLabelIds?.length) action.removeLabelIds = removeLabelIds;
    if (forward) action.forward = forward;
    if (Object.keys(criteria).length === 0) throw new Error("At least one filter criterion is required");
    if (Object.keys(action).length === 0) throw new Error("At least one filter action is required");

    const requestBody = { criteria, action };
    if (optionalBoolean(args, "dryRun") || false) {
      const preview: gmail_v1.Schema$Filter = { id: null, ...requestBody };
      return structuredResponse(
        `Dry run only; filter was not created.\n${this.formatFilter(preview)}`,
        { dryRun: true, created: false, filter: this.filterData(preview),
          warning: forward ? "Forwarding works only for an address already verified in Gmail." : null },
      );
    }

    const response = await this.gmail.users.settings.filters.create({
      userId: "me",
      requestBody,
    });

    return structuredResponse(
      `Filter created!\n${this.formatFilter(response.data)}`,
      { created: true, filter: this.filterData(response.data),
        warning: forward ? "Forwarding works only for an address already verified in Gmail." : null },
    );
  }

  private async listFilters(_args: Record<string, unknown>) {
    const response = await this.gmail.users.settings.filters.list({
      userId: "me",
    });

    const filters = response.data.filter || [];
    if (filters.length === 0) {
      return structuredResponse("No filters configured.", { filters: [] });
    }

    const lines = filters.map((filter) => this.formatFilter(filter));

    return structuredResponse(
      `${filters.length} filter(s):\n\n${lines.join("\n\n")}`,
      { filters: filters.map((filter) => this.filterData(filter)) },
    );
  }

  private async getFilter(args: Record<string, unknown>) {
    const filterId = requireString(args, "filterId");
    const response = await this.gmail.users.settings.filters.get({ userId: "me", id: filterId });
    return structuredResponse(
      this.formatFilter(response.data).replace(/^- /, ""),
      { filter: this.filterData(response.data) },
    );
  }

  private async deleteFilter(args: Record<string, unknown>) {
    const filterId = requireString(args, "filterId");

    await this.gmail.users.settings.filters.delete({
      userId: "me",
      id: filterId,
    });

    return structuredResponse(`Filter ${filterId} deleted.`, { filterId, deleted: true });
  }
}
