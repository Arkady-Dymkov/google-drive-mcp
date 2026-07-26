import { google, type docs_v1, type drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import TurndownService from "turndown";
import type { Service, ToolDefinition } from "../types.js";
import { extractReadableDocumentHtml } from "../html.js";
import {
  requireString,
  requireNumber,
  optionalString,
  optionalNumber,
  optionalBoolean,
  textResponse,
  MIN_MARKDOWN_LENGTH,
  MIN_CONTENT_HTML_LENGTH,
  MAX_BATCH_REQUESTS,
} from "../utils.js";
import { markdownToHtml, documentToMarkdown } from "../markdown.js";

interface FlatDocumentTab {
  tabId: string;
  title: string;
  parentTabId?: string;
  index: number;
  nestingLevel: number;
  documentTab: docs_v1.Schema$DocumentTab;
}

interface LocatedTable {
  startIndex: number;
  table: docs_v1.Schema$Table;
}

const CODE_BLOCK_STYLE_DEFAULTS = {
  fontFamily: "Roboto Mono",
  fontWeight: 400,
  fontSize: 10,
  foregroundColor: "#202124",
  backgroundColor: "#F1F3F4",
  indentStart: 12,
  indentEnd: 12,
  spaceAbove: 6,
  spaceBelow: 6,
} as const;

export class DocsService implements Service {
  private docs!: docs_v1.Docs;
  private drive!: drive_v3.Drive;
  private auth!: OAuth2Client;

  initialize(auth: OAuth2Client): void {
    this.auth = auth;
    this.docs = google.docs({ version: "v1", auth });
    this.drive = google.drive({ version: "v3", auth });
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        tool: {
          name: "read_document",
          description:
            "Read plain text and table content from one or every Google Docs tab, including the current revision and suggestions view. Use read_document_as_markdown to preserve common formatting.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: {
                type: "string",
                description: "The ID of the Google Doc to read",
              },
              tabId: {
                type: "string",
                description:
                  "Optional document tab ID. When omitted, returns every tab.",
              },
              suggestionsViewMode: {
                type: "string",
                enum: [
                  "DEFAULT_FOR_CURRENT_ACCESS",
                  "SUGGESTIONS_INLINE",
                  "PREVIEW_SUGGESTIONS_ACCEPTED",
                  "PREVIEW_WITHOUT_SUGGESTIONS",
                ],
                description:
                  "How suggested edits are rendered. Mutations always use SUGGESTIONS_INLINE.",
              },
            },
            required: ["documentId"],
          },
        },
        handler: (args) => this.readDocument(args),
      },
      {
        tool: {
          name: "list_document_tabs",
          description:
            "List every Google Docs tab, including its ID, title, parent, nesting level, and position.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: { type: "string", description: "The Google Doc ID" },
            },
            required: ["documentId"],
          },
        },
        handler: (args) => this.listDocumentTabs(args),
      },
      {
        tool: {
          name: "create_document_tab",
          description:
            "Create a tab in a Google Doc. The tab can be placed at a root or nested under another tab.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: { type: "string", description: "The Google Doc ID" },
              title: { type: "string", description: "Visible tab title" },
              parentTabId: {
                type: "string",
                description: "Optional parent tab ID for a nested tab",
              },
              index: {
                type: "number",
                description: "Optional zero-based position within the parent",
              },
              iconEmoji: {
                type: "string",
                description: "Optional single emoji displayed with the tab",
              },
              revisionId: {
                type: "string",
                description: "Optional required document revision ID",
              },
            },
            required: ["documentId", "title"],
          },
        },
        handler: (args) => this.createDocumentTab(args),
      },
      {
        tool: {
          name: "update_document_tab",
          description:
            "Rename, reorder, reparent, or change the icon of a Google Docs tab.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: { type: "string", description: "The Google Doc ID" },
              tabId: { type: "string", description: "The tab ID to update" },
              title: { type: "string", description: "New visible title" },
              parentTabId: {
                type: "string",
                description:
                  "New parent tab ID. Pass an empty string to move the tab to the root.",
              },
              index: {
                type: "number",
                description: "New zero-based position within the parent",
              },
              iconEmoji: {
                type: "string",
                description:
                  "New icon emoji. Pass an empty string to restore the default icon.",
              },
              revisionId: {
                type: "string",
                description: "Optional required document revision ID",
              },
            },
            required: ["documentId", "tabId"],
          },
        },
        handler: (args) => this.updateDocumentTab(args),
      },
      {
        tool: {
          name: "delete_document_tab",
          description:
            "Delete a Google Docs tab and all of its child tabs. Requires confirm=true.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: { type: "string", description: "The Google Doc ID" },
              tabId: { type: "string", description: "The tab ID to delete" },
              confirm: {
                type: "boolean",
                description: "Must be true because child tabs are also deleted",
              },
              revisionId: {
                type: "string",
                description: "Optional required document revision ID",
              },
            },
            required: ["documentId", "tabId", "confirm"],
          },
        },
        handler: (args) => this.deleteDocumentTab(args),
      },
      {
        tool: {
          name: "read_restricted_document",
          description:
            "Unsupported best-effort fallback for a Google Doc that cannot be read through the Docs API. Scrapes Google's mobilebasic HTML endpoint, which may change or stop working. Prefer read_document.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: {
                type: "string",
                description: "The ID of the Google Doc to read",
              },
              timeoutMs: {
                type: "number",
                description: "Request timeout in milliseconds (default: 15000, max: 60000)",
              },
            },
            required: ["documentId"],
          },
        },
        handler: (args) => this.readRestrictedDocument(args),
      },
      {
        tool: {
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
                description:
                  "Optional folder ID to create the document in",
              },
            },
            required: ["title"],
          },
        },
        handler: (args) => this.createDocument(args),
      },
      {
        tool: {
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
              tabId: {
                type: "string",
                description: "Optional target tab ID. Defaults to the first tab.",
              },
              revisionId: {
                type: "string",
                description: "Optional required document revision ID",
              },
            },
            required: ["documentId", "text"],
          },
        },
        handler: (args) => this.appendText(args),
      },
      {
        tool: {
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
              },
              tabIds: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional tab IDs to replace within. When omitted, replaces in every tab.",
              },
              revisionId: {
                type: "string",
                description: "Optional required document revision ID",
              },
            },
            required: ["documentId", "findText", "replaceText"],
          },
        },
        handler: (args) => this.replaceText(args),
      },
      {
        tool: {
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
              bold: { type: "boolean", description: "Apply bold formatting" },
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
                description:
                  "Text color as hex (e.g., '#FF0000' for red)",
              },
              tabId: {
                type: "string",
                description: "Optional target tab ID. Defaults to the first tab.",
              },
              revisionId: {
                type: "string",
                description: "Optional required document revision ID",
              },
            },
            required: ["documentId", "findText"],
          },
        },
        handler: (args) => this.formatText(args),
      },
      {
        tool: {
          name: "format_code_block_in_document",
          description:
            "Format every paragraph containing specified text as a visual code-block approximation using monospace text, paragraph shading, indentation, and spacing. Google Docs has no API request for its native code-block building block, so this tool does not create one.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              documentId: {
                type: "string",
                minLength: 1,
                description: "The ID of the Google Doc",
              },
              findText: {
                type: "string",
                minLength: 1,
                description:
                  "Text used to select paragraphs; every paragraph containing this exact text is formatted",
              },
              fontFamily: {
                type: "string",
                minLength: 1,
                maxLength: 100,
                default: CODE_BLOCK_STYLE_DEFAULTS.fontFamily,
                description: "Google Fonts family (default: Roboto Mono)",
              },
              fontWeight: {
                type: "integer",
                minimum: 100,
                maximum: 900,
                multipleOf: 100,
                default: CODE_BLOCK_STYLE_DEFAULTS.fontWeight,
                description: "Font weight from 100 to 900 (default: 400)",
              },
              fontSize: {
                type: "number",
                exclusiveMinimum: 0,
                maximum: 400,
                default: CODE_BLOCK_STYLE_DEFAULTS.fontSize,
                description: "Font size in points (default: 10)",
              },
              foregroundColor: {
                type: "string",
                pattern: "^#?[0-9A-Fa-f]{6}$",
                default: CODE_BLOCK_STYLE_DEFAULTS.foregroundColor,
                description: "Text color as six-digit hex (default: #202124)",
              },
              backgroundColor: {
                type: "string",
                pattern: "^#?[0-9A-Fa-f]{6}$",
                default: CODE_BLOCK_STYLE_DEFAULTS.backgroundColor,
                description: "Paragraph shading as six-digit hex (default: #F1F3F4)",
              },
              indentStart: {
                type: "number",
                minimum: 0,
                maximum: 720,
                default: CODE_BLOCK_STYLE_DEFAULTS.indentStart,
                description: "Start indentation in points (default: 12)",
              },
              indentEnd: {
                type: "number",
                minimum: 0,
                maximum: 720,
                default: CODE_BLOCK_STYLE_DEFAULTS.indentEnd,
                description: "End indentation in points (default: 12)",
              },
              spaceAbove: {
                type: "number",
                minimum: 0,
                maximum: 720,
                default: CODE_BLOCK_STYLE_DEFAULTS.spaceAbove,
                description: "Space above each paragraph in points (default: 6)",
              },
              spaceBelow: {
                type: "number",
                minimum: 0,
                maximum: 720,
                default: CODE_BLOCK_STYLE_DEFAULTS.spaceBelow,
                description: "Space below each paragraph in points (default: 6)",
              },
              tabId: {
                type: "string",
                minLength: 1,
                description: "Optional target tab ID. Defaults to the first tab.",
              },
              revisionId: {
                type: "string",
                minLength: 1,
                description:
                  "Optional required document revision ID. Defaults to the revision read while locating paragraphs.",
              },
            },
            required: ["documentId", "findText"],
          },
        },
        handler: (args) => this.formatCodeBlock(args),
      },
      {
        tool: {
          name: "insert_table_in_document",
          description:
            "Insert a table at a zero-based UTF-16 index or at the end of a selected Google Docs tab.",
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
              index: {
                type: "number",
                description:
                  "Optional zero-based UTF-16 insertion index. Defaults to the end of the tab.",
              },
              tabId: {
                type: "string",
                description: "Optional target tab ID. Defaults to the first tab.",
              },
              revisionId: {
                type: "string",
                description: "Optional required document revision ID",
              },
            },
            required: ["documentId", "rows", "columns"],
          },
        },
        handler: (args) => this.insertTable(args),
      },
      {
        tool: {
          name: "list_document_tables",
          description:
            "List tables in a Google Doc, including tab IDs, table start indexes, dimensions, and cell text.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: { type: "string", description: "The Google Doc ID" },
              tabId: {
                type: "string",
                description: "Optional tab ID. When omitted, returns tables from every tab.",
              },
            },
            required: ["documentId"],
          },
        },
        handler: (args) => this.listDocumentTables(args),
      },
      {
        tool: {
          name: "set_table_cell_text",
          description:
            "Replace the text in a Google Docs table cell, preserving the cell itself.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: { type: "string", description: "The Google Doc ID" },
              tabId: { type: "string", description: "The containing tab ID" },
              tableStartIndex: {
                type: "number",
                description: "The table's zero-based UTF-16 start index",
              },
              rowIndex: { type: "number", description: "Zero-based row index" },
              columnIndex: {
                type: "number",
                description: "Zero-based column index",
              },
              text: { type: "string", description: "Replacement cell text" },
              revisionId: {
                type: "string",
                description: "Optional required document revision ID",
              },
            },
            required: [
              "documentId",
              "tabId",
              "tableStartIndex",
              "rowIndex",
              "columnIndex",
              "text",
            ],
          },
        },
        handler: (args) => this.setTableCellText(args),
      },
      ...this.tableMutationToolDefinitions(),
      {
        tool: {
          name: "merge_table_cells",
          description: "Merge a rectangular range of cells in a Google Docs table.",
          inputSchema: this.tableRangeInputSchema(),
        },
        handler: (args) => this.mergeTableCells(args),
      },
      {
        tool: {
          name: "unmerge_table_cells",
          description:
            "Unmerge cells in a Google Docs table range. The range must cover merged cells exactly.",
          inputSchema: this.tableRangeInputSchema(),
        },
        handler: (args) => this.unmergeTableCells(args),
      },
      {
        tool: {
          name: "update_table_cell_style",
          description:
            "Update background, vertical alignment, or padding for a Google Docs table cell range.",
          inputSchema: {
            ...this.tableRangeInputSchema(),
            properties: {
              ...this.tableRangeInputSchema().properties,
              backgroundColor: {
                type: "string",
                description: "Background color as a six-digit hex value, for example #FFF2CC",
              },
              contentAlignment: {
                type: "string",
                enum: ["TOP", "MIDDLE", "BOTTOM"],
                description: "Vertical content alignment",
              },
              paddingTop: { type: "number", description: "Top padding in points" },
              paddingBottom: {
                type: "number",
                description: "Bottom padding in points",
              },
              paddingLeft: { type: "number", description: "Left padding in points" },
              paddingRight: {
                type: "number",
                description: "Right padding in points",
              },
            },
          },
        },
        handler: (args) => this.updateTableCellStyle(args),
      },
      {
        tool: {
          name: "pin_table_header_rows",
          description:
            "Set how many leading rows of a Google Docs table repeat as pinned headers.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: { type: "string", description: "The Google Doc ID" },
              tabId: { type: "string", description: "The containing tab ID" },
              tableStartIndex: {
                type: "number",
                description: "The table's zero-based UTF-16 start index",
              },
              pinnedHeaderRowsCount: {
                type: "number",
                description: "Number of leading rows to pin; use 0 to unpin all",
              },
              revisionId: {
                type: "string",
                description: "Optional required document revision ID",
              },
            },
            required: [
              "documentId",
              "tabId",
              "tableStartIndex",
              "pinnedHeaderRowsCount",
            ],
          },
        },
        handler: (args) => this.pinTableHeaderRows(args),
      },
      {
        tool: {
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
                description:
                  "Text to find - the paragraph containing this text will be styled",
              },
              alignment: {
                type: "string",
                enum: ["START", "CENTER", "END", "JUSTIFIED"],
                description: "Paragraph alignment",
              },
              lineSpacing: {
                type: "number",
                description:
                  "Line spacing multiplier (e.g., 1.5 for 1.5x spacing)",
              },
              bulletPreset: {
                type: "string",
                enum: [
                  "BULLET_DISC_CIRCLE_SQUARE",
                  "BULLET_ARROW_DIAMOND_DISC",
                  "NUMBERED_DECIMAL_NESTED",
                ],
                description:
                  "Convert paragraph to a bulleted or numbered list",
              },
              tabId: {
                type: "string",
                description: "Optional target tab ID. Defaults to the first tab.",
              },
              revisionId: {
                type: "string",
                description: "Optional required document revision ID",
              },
            },
            required: ["documentId", "findText"],
          },
        },
        handler: (args) => this.updateParagraphStyle(args),
      },
      {
        tool: {
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
                minItems: 1,
                maxItems: MAX_BATCH_REQUESTS,
                description:
                  "Array of Google Docs API request objects (insertText, deleteContentRange, replaceAllText, updateTextStyle, etc.)",
                items: { type: "object" },
              },
              requiredRevisionId: {
                type: "string",
                description:
                  "Reject the update if the document is no longer at this revision",
              },
              targetRevisionId: {
                type: "string",
                description:
                  "Merge the update against this recent revision, resolving collaborator changes",
              },
            },
            required: ["documentId", "requests"],
          },
        },
        handler: (args) => this.batchUpdate(args),
      },
      {
        tool: {
          name: "read_document_as_markdown",
          description:
            "Read a Google Doc and return its content as Markdown, preserving headings, bold, italic, links, lists, and tables.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: {
                type: "string",
                description: "The ID of the Google Doc to read",
              },
              tabId: {
                type: "string",
                description:
                  "Optional document tab ID. When omitted, returns every tab.",
              },
              suggestionsViewMode: {
                type: "string",
                enum: [
                  "DEFAULT_FOR_CURRENT_ACCESS",
                  "SUGGESTIONS_INLINE",
                  "PREVIEW_SUGGESTIONS_ACCEPTED",
                  "PREVIEW_WITHOUT_SUGGESTIONS",
                ],
                description: "How suggested edits are rendered in the Markdown preview",
              },
            },
            required: ["documentId"],
          },
        },
        handler: (args) => this.readDocumentAsMarkdown(args),
      },
      {
        tool: {
          name: "create_document_from_markdown",
          description:
            "Create a new Google Doc from Markdown with headings, bold, italic, links, lists, tables, blockquotes, images, and preformatted fenced code. Fenced code is imported through HTML and does not become a native Google Docs code-block building block.",
          inputSchema: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Title of the new document",
              },
              markdown: {
                type: "string",
                description: "Markdown content to convert into a formatted Google Doc",
              },
              folderId: {
                type: "string",
                description: "Optional folder ID to create the document in",
              },
            },
            required: ["title", "markdown"],
          },
        },
        handler: (args) => this.createDocumentFromMarkdown(args),
      },
      {
        tool: {
          name: "insert_text",
          description:
            "Insert text at a specific position (index) in a Google Doc. Use read_document_as_markdown or read_document to find positions.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: {
                type: "string",
                description: "The ID of the Google Doc",
              },
              text: {
                type: "string",
                description: "The text to insert",
              },
              index: {
                type: "number",
                description:
                  "Zero-based UTF-16 code-unit index in the selected tab",
              },
              tabId: {
                type: "string",
                description: "Optional target tab ID. Defaults to the first tab.",
              },
              revisionId: {
                type: "string",
                description: "Optional required document revision ID",
              },
            },
            required: ["documentId", "text", "index"],
          },
        },
        handler: (args) => this.insertText(args),
      },
      {
        tool: {
          name: "delete_range",
          description:
            "Delete content in a Google Doc between two index positions.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: {
                type: "string",
                description: "The ID of the Google Doc",
              },
              startIndex: {
                type: "number",
                description:
                  "Zero-based UTF-16 start index of the range (inclusive)",
              },
              endIndex: {
                type: "number",
                description:
                  "Zero-based UTF-16 end index of the range (exclusive)",
              },
              tabId: {
                type: "string",
                description: "Optional target tab ID. Defaults to the first tab.",
              },
              revisionId: {
                type: "string",
                description: "Optional required document revision ID",
              },
            },
            required: ["documentId", "startIndex", "endIndex"],
          },
        },
        handler: (args) => this.deleteRange(args),
      },
      {
        tool: {
          name: "insert_image",
          description:
            "Insert an image into a Google Doc from a URL at a specific position.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: {
                type: "string",
                description: "The ID of the Google Doc",
              },
              imageUrl: {
                type: "string",
                description: "The publicly accessible URL of the image",
              },
              index: {
                type: "number",
                description:
                  "Zero-based UTF-16 index. If omitted, inserts at the end of the selected tab.",
              },
              width: {
                type: "number",
                description: "Optional width in points (72 points = 1 inch)",
              },
              height: {
                type: "number",
                description: "Optional height in points (72 points = 1 inch)",
              },
              tabId: {
                type: "string",
                description: "Optional target tab ID. Defaults to the first tab.",
              },
              revisionId: {
                type: "string",
                description: "Optional required document revision ID",
              },
            },
            required: ["documentId", "imageUrl"],
          },
        },
        handler: (args) => this.insertImage(args),
      },
      {
        tool: {
          name: "insert_page_break",
          description: "Insert a page break at a specific position in a Google Doc.",
          inputSchema: {
            type: "object",
            properties: {
              documentId: {
                type: "string",
                description: "The ID of the Google Doc",
              },
              index: {
                type: "number",
                description:
                  "Zero-based UTF-16 index. If omitted, inserts at the end of the selected tab.",
              },
              tabId: {
                type: "string",
                description: "Optional target tab ID. Defaults to the first tab.",
              },
              revisionId: {
                type: "string",
                description: "Optional required document revision ID",
              },
            },
            required: ["documentId"],
          },
        },
        handler: (args) => this.insertPageBreak(args),
      },
    ];
  }

  private tableRangeInputSchema() {
    return {
      type: "object" as const,
      properties: {
        documentId: { type: "string" as const, description: "The Google Doc ID" },
        tabId: { type: "string" as const, description: "The containing tab ID" },
        tableStartIndex: {
          type: "number" as const,
          description: "The table's zero-based UTF-16 start index",
        },
        rowIndex: { type: "number" as const, description: "Zero-based starting row" },
        columnIndex: {
          type: "number" as const,
          description: "Zero-based starting column",
        },
        rowSpan: {
          type: "number" as const,
          description: "Number of rows in the range (default: 1)",
        },
        columnSpan: {
          type: "number" as const,
          description: "Number of columns in the range (default: 1)",
        },
        revisionId: {
          type: "string" as const,
          description: "Optional required document revision ID",
        },
      },
      required: [
        "documentId",
        "tabId",
        "tableStartIndex",
        "rowIndex",
        "columnIndex",
      ],
    };
  }

  private tableMutationToolDefinitions(): ToolDefinition[] {
    const schema = {
      type: "object" as const,
      properties: {
        documentId: { type: "string" as const, description: "The Google Doc ID" },
        tabId: { type: "string" as const, description: "The containing tab ID" },
        tableStartIndex: {
          type: "number" as const,
          description: "The table's zero-based UTF-16 start index",
        },
        rowIndex: { type: "number" as const, description: "Zero-based row index" },
        columnIndex: {
          type: "number" as const,
          description: "Zero-based column index",
        },
        insertAfter: {
          type: "boolean" as const,
          description: "For insert operations, insert after/right instead of before/left",
        },
        revisionId: {
          type: "string" as const,
          description: "Optional required document revision ID",
        },
      },
      required: [
        "documentId",
        "tabId",
        "tableStartIndex",
        "rowIndex",
        "columnIndex",
      ],
    };

    return [
      {
        tool: {
          name: "insert_table_row",
          description: "Insert a row above or below a Google Docs table cell.",
          inputSchema: schema,
        },
        handler: (args) => this.mutateTableDimension(args, "insertRow"),
      },
      {
        tool: {
          name: "delete_table_row",
          description:
            "Delete the row containing a Google Docs table cell. Deleting the final row deletes the table.",
          inputSchema: schema,
        },
        handler: (args) => this.mutateTableDimension(args, "deleteRow"),
      },
      {
        tool: {
          name: "insert_table_column",
          description: "Insert a column to the left or right of a Google Docs table cell.",
          inputSchema: schema,
        },
        handler: (args) => this.mutateTableDimension(args, "insertColumn"),
      },
      {
        tool: {
          name: "delete_table_column",
          description:
            "Delete the column containing a Google Docs table cell. Deleting the final column deletes the table.",
          inputSchema: schema,
        },
        handler: (args) => this.mutateTableDimension(args, "deleteColumn"),
      },
    ];
  }

  private requireInteger(
    args: Record<string, unknown>,
    field: string,
    minimum = 0,
  ): number {
    const value = requireNumber(args, field);
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`'${field}' must be an integer greater than or equal to ${minimum}`);
    }
    return value;
  }

  private optionalInteger(
    args: Record<string, unknown>,
    field: string,
    minimum = 0,
  ): number | undefined {
    const value = optionalNumber(args, field);
    if (value !== undefined && (!Number.isInteger(value) || value < minimum)) {
      throw new Error(`'${field}' must be an integer greater than or equal to ${minimum}`);
    }
    return value;
  }

  private requireBoolean(args: Record<string, unknown>, field: string): boolean {
    const value = args[field];
    if (typeof value !== "boolean") {
      throw new Error(`'${field}' is required and must be a boolean`);
    }
    return value;
  }

  private requireText(args: Record<string, unknown>, field: string): string {
    const value = args[field];
    if (typeof value !== "string") {
      throw new Error(`'${field}' is required and must be a string`);
    }
    return value;
  }

  private optionalStringArray(
    args: Record<string, unknown>,
    field: string,
  ): string[] | undefined {
    const value = args[field];
    if (value === undefined || value === null) return undefined;
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((item) => typeof item !== "string" || item.trim() === "")
    ) {
      throw new Error(`'${field}' must be a non-empty array of non-empty strings`);
    }
    return value;
  }

  private hexColor(value: string): docs_v1.Schema$OptionalColor {
    const match = /^#?([0-9a-f]{6})$/i.exec(value);
    if (!match) {
      throw new Error("Colors must be six-digit hexadecimal values, such as '#FF0000'");
    }
    const hex = match[1];
    return {
      color: {
        rgbColor: {
          red: parseInt(hex.slice(0, 2), 16) / 255,
          green: parseInt(hex.slice(2, 4), 16) / 255,
          blue: parseInt(hex.slice(4, 6), 16) / 255,
        },
      },
    };
  }

  private suggestionsViewMode(
    args: Record<string, unknown>,
  ): string | undefined {
    const mode = optionalString(args, "suggestionsViewMode");
    if (
      mode !== undefined &&
      ![
        "DEFAULT_FOR_CURRENT_ACCESS",
        "SUGGESTIONS_INLINE",
        "PREVIEW_SUGGESTIONS_ACCEPTED",
        "PREVIEW_WITHOUT_SUGGESTIONS",
      ].includes(mode)
    ) {
      throw new Error("Unsupported 'suggestionsViewMode'");
    }
    return mode;
  }

  private async getDocumentSnapshot(
    documentId: string,
    suggestionsViewMode = "SUGGESTIONS_INLINE",
  ) {
    return this.docs.documents.get({
      documentId,
      includeTabsContent: true,
      suggestionsViewMode,
    });
  }

  private flattenDocumentTabs(document: docs_v1.Schema$Document): FlatDocumentTab[] {
    const flattened: FlatDocumentTab[] = [];
    const visit = (tabs: docs_v1.Schema$Tab[] | undefined, parent?: string) => {
      for (const tab of tabs || []) {
        const properties = tab.tabProperties;
        if (!properties?.tabId || !tab.documentTab) continue;
        flattened.push({
          tabId: properties.tabId,
          title: properties.title || "Untitled tab",
          parentTabId: properties.parentTabId || parent,
          index: properties.index ?? 0,
          nestingLevel: properties.nestingLevel ?? 0,
          documentTab: tab.documentTab,
        });
        visit(tab.childTabs, properties.tabId);
      }
    };
    visit(document.tabs);

    // Compatibility with older/single-tab responses and lightweight mocks.
    if (flattened.length === 0 && document.body) {
      flattened.push({
        tabId: "",
        title: document.title || "Document",
        index: 0,
        nestingLevel: 0,
        documentTab: {
          body: document.body,
          lists: document.lists,
          headers: document.headers,
          footers: document.footers,
          footnotes: document.footnotes,
          inlineObjects: document.inlineObjects,
          namedRanges: document.namedRanges,
          namedStyles: document.namedStyles,
          positionedObjects: document.positionedObjects,
          documentStyle: document.documentStyle,
        },
      });
    }
    return flattened;
  }

  private selectDocumentTab(
    document: docs_v1.Schema$Document,
    requestedTabId?: string,
  ): FlatDocumentTab {
    const tabs = this.flattenDocumentTabs(document);
    const tab = requestedTabId
      ? tabs.find((candidate) => candidate.tabId === requestedTabId)
      : tabs[0];
    if (!tab) {
      const available = tabs.map((candidate) => candidate.tabId).filter(Boolean);
      throw new Error(
        requestedTabId
          ? `Tab '${requestedTabId}' was not found. Available tab IDs: ${available.join(", ") || "none"}`
          : "The document has no readable tabs",
      );
    }
    return tab;
  }

  private tabLocation(tabId: string, index: number): docs_v1.Schema$Location {
    return tabId ? { index, tabId } : { index };
  }

  private tabRange(
    tabId: string,
    startIndex: number,
    endIndex: number,
  ): docs_v1.Schema$Range {
    return tabId ? { startIndex, endIndex, tabId } : { startIndex, endIndex };
  }

  private writeControl(revisionId?: string): docs_v1.Schema$WriteControl | undefined {
    return revisionId ? { requiredRevisionId: revisionId } : undefined;
  }

  private structuralElementsToText(
    content: docs_v1.Schema$StructuralElement[] | undefined,
  ): string {
    let text = "";
    for (const element of content || []) {
      if (element.paragraph) {
        for (const paragraphElement of element.paragraph.elements || []) {
          text += paragraphElement.textRun?.content || "";
        }
      } else if (element.table) {
        const rows = (element.table.tableRows || []).map((row) =>
          (row.tableCells || [])
            .map((cell) => this.structuralElementsToText(cell.content).replace(/\n+$/, ""))
            .join(" | "),
        );
        text += `\n${rows.join("\n")}\n`;
      } else if (element.tableOfContents) {
        text += this.structuralElementsToText(element.tableOfContents.content);
      }
    }
    return text;
  }

  private walkStructuralElements(
    content: docs_v1.Schema$StructuralElement[] | undefined,
    visit: (element: docs_v1.Schema$StructuralElement) => void,
  ): void {
    for (const element of content || []) {
      visit(element);
      if (element.table) {
        for (const row of element.table.tableRows || []) {
          for (const cell of row.tableCells || []) {
            this.walkStructuralElements(cell.content, visit);
          }
        }
      }
      if (element.tableOfContents) {
        this.walkStructuralElements(element.tableOfContents.content, visit);
      }
    }
  }

  private findTextRanges(
    content: docs_v1.Schema$StructuralElement[],
    searchText: string,
  ): Array<{ startIndex: number; endIndex: number }> {
    const ranges: Array<{ startIndex: number; endIndex: number }> = [];
    this.walkStructuralElements(content, (element) => {
      const runs = (element.paragraph?.elements || [])
        .filter(
          (item): item is docs_v1.Schema$ParagraphElement & {
            startIndex: number;
            textRun: { content: string };
          } =>
            typeof item.startIndex === "number" &&
            typeof item.textRun?.content === "string",
        )
        .sort((a, b) => a.startIndex - b.startIndex);

      let chunkText = "";
      let chunkStart: number | undefined;
      let expectedIndex: number | undefined;
      const flush = () => {
        if (chunkStart === undefined) return;
        let offset = 0;
        while (true) {
          const found = chunkText.indexOf(searchText, offset);
          if (found === -1) break;
          ranges.push({
            startIndex: chunkStart + found,
            endIndex: chunkStart + found + searchText.length,
          });
          offset = found + Math.max(1, searchText.length);
        }
        chunkText = "";
        chunkStart = undefined;
        expectedIndex = undefined;
      };

      for (const run of runs) {
        if (expectedIndex !== undefined && run.startIndex !== expectedIndex) flush();
        if (chunkStart === undefined) chunkStart = run.startIndex;
        chunkText += run.textRun.content;
        expectedIndex = run.startIndex + run.textRun.content.length;
      }
      flush();
    });
    return ranges;
  }

  private findParagraphRanges(
    content: docs_v1.Schema$StructuralElement[],
    searchText: string,
  ): Array<{ startIndex: number; endIndex: number }> {
    const ranges: Array<{ startIndex: number; endIndex: number }> = [];
    this.walkStructuralElements(content, (element) => {
      if (!element.paragraph) return;
      const paragraphText = (element.paragraph.elements || [])
        .map((item) => item.textRun?.content || "")
        .join("");
      if (
        paragraphText.includes(searchText) &&
        typeof element.startIndex === "number" &&
        typeof element.endIndex === "number"
      ) {
        ranges.push({ startIndex: element.startIndex, endIndex: element.endIndex });
      }
    });
    return ranges;
  }

  private listTablesInContent(
    content: docs_v1.Schema$StructuralElement[] | undefined,
  ): LocatedTable[] {
    const tables: LocatedTable[] = [];
    this.walkStructuralElements(content, (element) => {
      if (element.table && typeof element.startIndex === "number") {
        tables.push({ startIndex: element.startIndex, table: element.table });
      }
    });
    return tables;
  }

  private requireTable(
    tab: FlatDocumentTab,
    tableStartIndex: number,
  ): docs_v1.Schema$Table {
    const located = this.listTablesInContent(tab.documentTab.body?.content).find(
      (candidate) => candidate.startIndex === tableStartIndex,
    );
    if (!located) {
      throw new Error(
        `No table starts at index ${tableStartIndex} in tab '${tab.tabId || tab.title}'`,
      );
    }
    return located.table;
  }

  private requireTableCoordinate(
    table: docs_v1.Schema$Table,
    rowIndex: number,
    columnIndex: number,
  ): void {
    const rows = table.rows ?? table.tableRows?.length ?? 0;
    const columns = table.columns ?? 0;
    if (rowIndex >= rows || columnIndex >= columns) {
      throw new Error(
        `Cell [${rowIndex}, ${columnIndex}] is outside this ${rows} x ${columns} table`,
      );
    }
  }

  private findTableCell(
    table: docs_v1.Schema$Table,
    rowIndex: number,
    columnIndex: number,
  ): docs_v1.Schema$TableCell {
    this.requireTableCoordinate(table, rowIndex, columnIndex);
    const row = table.tableRows?.[rowIndex];
    let gridColumn = 0;
    for (const cell of row?.tableCells || []) {
      const span = cell.tableCellStyle?.columnSpan || 1;
      if (columnIndex >= gridColumn && columnIndex < gridColumn + span) return cell;
      gridColumn += span;
    }
    throw new Error(`Unable to locate cell [${rowIndex}, ${columnIndex}]`);
  }

  private async readDocument(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const tabId = optionalString(args, "tabId");
    const suggestionsViewMode =
      this.suggestionsViewMode(args) || "DEFAULT_FOR_CURRENT_ACCESS";
    const response = await this.getDocumentSnapshot(documentId, suggestionsViewMode);
    const tabs = this.flattenDocumentTabs(response.data);
    const selectedTabs = tabId
      ? [this.selectDocumentTab(response.data, tabId)]
      : tabs;

    const sections = selectedTabs.map((tab) => {
      const heading = tab.tabId
        ? `Tab: ${tab.title} (ID: ${tab.tabId})`
        : `Tab: ${tab.title}`;
      return `${heading}\n\n${this.structuralElementsToText(tab.documentTab.body?.content)}`;
    });
    return textResponse(
      `Document: ${response.data.title || "Untitled"}\nRevision: ${response.data.revisionId || "unknown"}\nSuggestions view: ${response.data.suggestionsViewMode || suggestionsViewMode}\n\n${sections.join("\n\n---\n\n")}`,
    );
  }

  private async listDocumentTabs(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const response = await this.getDocumentSnapshot(documentId);
    const tabs = this.flattenDocumentTabs(response.data);
    const lines = tabs.map((tab) => {
      const indent = "  ".repeat(tab.nestingLevel);
      return `${indent}- ${tab.title} (ID: ${tab.tabId || "legacy-first-tab"}, index: ${tab.index}, parent: ${tab.parentTabId || "root"})`;
    });
    return textResponse(
      `Document: ${response.data.title || "Untitled"}\nRevision: ${response.data.revisionId || "unknown"}\nTabs (${tabs.length}):\n${lines.join("\n") || "No tabs found."}`,
    );
  }

  private async createDocumentTab(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const title = requireString(args, "title");
    const parentTabId = optionalString(args, "parentTabId");
    const index = this.optionalInteger(args, "index");
    const iconEmoji = optionalString(args, "iconEmoji");
    const revisionId = optionalString(args, "revisionId");
    const tabProperties: docs_v1.Schema$TabProperties = { title };
    if (parentTabId !== undefined) tabProperties.parentTabId = parentTabId;
    if (index !== undefined) tabProperties.index = index;
    if (iconEmoji !== undefined) tabProperties.iconEmoji = iconEmoji;

    const response = await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{ addDocumentTab: { tabProperties } }],
        writeControl: this.writeControl(revisionId),
      },
    });
    const created = response.data.replies?.[0]?.addDocumentTab?.tabProperties;
    return textResponse(
      `Tab created: ${created?.title || title}\nTab ID: ${created?.tabId || "not returned"}\nRevision: ${response.data.writeControl?.requiredRevisionId || "unknown"}`,
    );
  }

  private async updateDocumentTab(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const tabId = requireString(args, "tabId");
    const title = optionalString(args, "title");
    const parentTabId = optionalString(args, "parentTabId");
    const index = this.optionalInteger(args, "index");
    const iconEmoji = optionalString(args, "iconEmoji");
    const revisionId = optionalString(args, "revisionId");
    const tabProperties: docs_v1.Schema$TabProperties = { tabId };
    const fields: string[] = [];
    if (title !== undefined) {
      if (title.trim() === "") throw new Error("'title' cannot be empty");
      tabProperties.title = title;
      fields.push("title");
    }
    if (parentTabId !== undefined) {
      tabProperties.parentTabId = parentTabId;
      fields.push("parentTabId");
    }
    if (index !== undefined) {
      tabProperties.index = index;
      fields.push("index");
    }
    if (iconEmoji !== undefined) {
      tabProperties.iconEmoji = iconEmoji;
      fields.push("iconEmoji");
    }
    if (fields.length === 0) {
      throw new Error(
        "Provide at least one of 'title', 'parentTabId', 'index', or 'iconEmoji'",
      );
    }

    const response = await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            updateDocumentTabProperties: {
              tabProperties,
              fields: fields.join(","),
            },
          },
        ],
        writeControl: this.writeControl(revisionId),
      },
    });
    return textResponse(
      `Tab ${tabId} updated (${fields.join(", ")}).\nRevision: ${response.data.writeControl?.requiredRevisionId || "unknown"}`,
    );
  }

  private async deleteDocumentTab(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const tabId = requireString(args, "tabId");
    if (!this.requireBoolean(args, "confirm")) {
      throw new Error("'confirm' must be true; deleting a tab also deletes its child tabs");
    }
    const revisionId = optionalString(args, "revisionId");
    const response = await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{ deleteTab: { tabId } }],
        writeControl: this.writeControl(revisionId),
      },
    });
    return textResponse(
      `Tab ${tabId} and its child tabs were deleted.\nRevision: ${response.data.writeControl?.requiredRevisionId || "unknown"}`,
    );
  }

  private async readRestrictedDocument(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    if (!/^[A-Za-z0-9_-]+$/.test(documentId)) {
      throw new Error("'documentId' has an invalid format");
    }
    const timeoutMs = optionalNumber(args, "timeoutMs") ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new Error("'timeoutMs' must be an integer between 1000 and 60000");
    }

    const accessToken = await this.auth.getAccessToken();
    if (!accessToken.token) {
      throw new Error("Failed to obtain access token");
    }

    const url = `https://docs.google.com/document/d/${documentId}/mobilebasic`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch document: ${response.status} ${response.statusText}`,
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("text/html")) {
      throw new Error(
        `Unsupported mobilebasic response content type: ${contentType || "missing"}`,
      );
    }

    const html = await response.text();
    if (
      /accounts\.google\.com|ServiceLogin|<form[^>]+(?:signin|login)/i.test(
        `${response.url}\n${html.slice(0, 20_000)}`,
      )
    ) {
      throw new Error(
        "The mobilebasic endpoint returned an authentication page, not document content",
      );
    }
    const extracted = extractReadableDocumentHtml(html);
    const title = extracted.title;
    let contentHtml = extracted.primaryContentHtml;

    if (!contentHtml || contentHtml.length < MIN_CONTENT_HTML_LENGTH) {
      contentHtml = extracted.fallbackContentHtml;
    }

    const turndownService = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      fence: "```",
      emDelimiter: "*",
      strongDelimiter: "**",
      linkStyle: "inlined",
    });

    turndownService.addRule("removeEmptySpans", {
      filter: (node) => {
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
      } catch {
        markdown = extracted.plainText;
      }
    }

    if (!markdown || markdown.trim().length < MIN_MARKDOWN_LENGTH) {
      markdown = extracted.fallbackMarkdown;
    }

    markdown = markdown.replace(/\n{4,}/g, "\n\n\n").trim();

    if (markdown.length < MIN_MARKDOWN_LENGTH) {
      throw new Error(
        "The unsupported mobilebasic fallback did not return enough document content to trust",
      );
    }

    return textResponse(
      `# ${title}\n\n${markdown}\n\n---\n*Warning: extracted through Google's unsupported mobilebasic HTML endpoint; formatting and content may be incomplete.*`,
    );
  }

  private async createDocument(args: Record<string, unknown>) {
    const title = requireString(args, "title");
    const content = optionalString(args, "content");
    const folderId = optionalString(args, "folderId");

    const doc = await this.docs.documents.create({
      requestBody: { title },
    });

    const documentId = doc.data.documentId!;
    try {
      if (content) {
        await this.docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [
              { insertText: { location: { index: 1 }, text: content } },
            ],
          },
        });
      }

      if (folderId) {
        await this.drive.files.update({
          fileId: documentId,
          addParents: folderId,
          removeParents: "root",
          fields: "id, parents",
          supportsAllDrives: true,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Document ${documentId} was created, but initial content/folder setup was incomplete: ${message}`,
      );
    }

    return textResponse(
      `Document created successfully!\nTitle: ${title}\nID: ${documentId}\nURL: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async appendText(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const text = requireString(args, "text");
    const tabId = optionalString(args, "tabId");
    const revisionId = optionalString(args, "revisionId");

    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            insertText: {
              endOfSegmentLocation: tabId ? { tabId } : {},
              text,
            },
          },
        ],
        writeControl: this.writeControl(revisionId),
      },
    });

    return textResponse(
      `Text appended successfully!\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async replaceText(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const findText = requireString(args, "findText");
    const replaceText = this.requireText(args, "replaceText");
    const matchCase = optionalBoolean(args, "matchCase");
    const tabIds = this.optionalStringArray(args, "tabIds");
    const revisionId = optionalString(args, "revisionId");

    const response = await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            replaceAllText: {
              containsText: { text: findText, matchCase: matchCase || false },
              replaceText,
              tabsCriteria: tabIds ? { tabIds } : undefined,
            },
          },
        ],
        writeControl: this.writeControl(revisionId),
      },
    });

    const occurrences =
      response.data.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;

    return textResponse(
      `Replaced ${occurrences} occurrence(s) of "${findText}" with "${replaceText}"\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async formatText(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const findText = requireString(args, "findText");
    const bold = optionalBoolean(args, "bold");
    const italic = optionalBoolean(args, "italic");
    const underline = optionalBoolean(args, "underline");
    const fontSize = optionalNumber(args, "fontSize");
    const foregroundColor = optionalString(args, "foregroundColor");
    const tabId = optionalString(args, "tabId");
    const revisionId = optionalString(args, "revisionId");

    if (fontSize !== undefined && (!Number.isFinite(fontSize) || fontSize <= 0)) {
      throw new Error("'fontSize' must be a positive number");
    }

    const doc = await this.getDocumentSnapshot(documentId);
    const tab = this.selectDocumentTab(doc.data, tabId);
    const content = tab.documentTab.body?.content || [];
    const ranges = this.findTextRanges(content, findText);

    if (ranges.length === 0) {
      return textResponse(`Text "${findText}" not found in document.`);
    }

    const textStyle: docs_v1.Schema$TextStyle = {};
    const fields: string[] = [];

    if (bold !== undefined) {
      textStyle.bold = bold;
      fields.push("bold");
    }
    if (italic !== undefined) {
      textStyle.italic = italic;
      fields.push("italic");
    }
    if (underline !== undefined) {
      textStyle.underline = underline;
      fields.push("underline");
    }
    if (fontSize !== undefined) {
      textStyle.fontSize = { magnitude: fontSize, unit: "PT" };
      fields.push("fontSize");
    }
    if (foregroundColor) {
      textStyle.foregroundColor = this.hexColor(foregroundColor);
      fields.push("foregroundColor");
    }

    if (fields.length === 0) {
      throw new Error(
        "Provide at least one of 'bold', 'italic', 'underline', 'fontSize', or 'foregroundColor'",
      );
    }

    // Apply in reverse order to maintain indices
    const requests = ranges
      .sort((a, b) => b.startIndex - a.startIndex)
      .map((range) => ({
        updateTextStyle: {
          range: this.tabRange(tab.tabId, range.startIndex, range.endIndex),
          textStyle,
          fields: fields.join(","),
        },
      }));

    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests,
        writeControl: this.writeControl(revisionId || doc.data.revisionId || undefined),
      },
    });

    return textResponse(
      `Formatted ${ranges.length} occurrence(s) of "${findText}"\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async formatCodeBlock(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const findText = requireString(args, "findText");
    const requestedFontFamily = optionalString(args, "fontFamily");
    const fontFamily = requestedFontFamily?.trim() || CODE_BLOCK_STYLE_DEFAULTS.fontFamily;
    const fontWeight = optionalNumber(args, "fontWeight") ?? CODE_BLOCK_STYLE_DEFAULTS.fontWeight;
    const fontSize = optionalNumber(args, "fontSize") ?? CODE_BLOCK_STYLE_DEFAULTS.fontSize;
    const foregroundColor =
      optionalString(args, "foregroundColor") ?? CODE_BLOCK_STYLE_DEFAULTS.foregroundColor;
    const backgroundColor =
      optionalString(args, "backgroundColor") ?? CODE_BLOCK_STYLE_DEFAULTS.backgroundColor;
    const indentStart = optionalNumber(args, "indentStart") ?? CODE_BLOCK_STYLE_DEFAULTS.indentStart;
    const indentEnd = optionalNumber(args, "indentEnd") ?? CODE_BLOCK_STYLE_DEFAULTS.indentEnd;
    const spaceAbove = optionalNumber(args, "spaceAbove") ?? CODE_BLOCK_STYLE_DEFAULTS.spaceAbove;
    const spaceBelow = optionalNumber(args, "spaceBelow") ?? CODE_BLOCK_STYLE_DEFAULTS.spaceBelow;
    const tabId = optionalString(args, "tabId");
    const revisionId = optionalString(args, "revisionId");

    if (requestedFontFamily !== undefined && requestedFontFamily.trim() === "") {
      throw new Error("'fontFamily' must be a non-empty string");
    }
    if (fontFamily.length > 100) {
      throw new Error("'fontFamily' must be at most 100 characters");
    }
    if (
      !Number.isInteger(fontWeight) ||
      fontWeight < 100 ||
      fontWeight > 900 ||
      fontWeight % 100 !== 0
    ) {
      throw new Error("'fontWeight' must be a multiple of 100 from 100 to 900");
    }
    if (fontSize <= 0 || fontSize > 400) {
      throw new Error("'fontSize' must be greater than 0 and at most 400 points");
    }
    for (const [field, value] of Object.entries({
      indentStart,
      indentEnd,
      spaceAbove,
      spaceBelow,
    })) {
      if (value < 0 || value > 720) {
        throw new Error(`'${field}' must be between 0 and 720 points`);
      }
    }
    if (tabId !== undefined && tabId.trim() === "") {
      throw new Error("'tabId' must be a non-empty string");
    }
    if (revisionId !== undefined && revisionId.trim() === "") {
      throw new Error("'revisionId' must be a non-empty string");
    }

    const textStyle: docs_v1.Schema$TextStyle = {
      weightedFontFamily: { fontFamily, weight: fontWeight },
      fontSize: { magnitude: fontSize, unit: "PT" },
      foregroundColor: this.hexColor(foregroundColor),
    };
    const paragraphStyle: docs_v1.Schema$ParagraphStyle = {
      shading: { backgroundColor: this.hexColor(backgroundColor) },
      indentStart: { magnitude: indentStart, unit: "PT" },
      indentEnd: { magnitude: indentEnd, unit: "PT" },
      spaceAbove: { magnitude: spaceAbove, unit: "PT" },
      spaceBelow: { magnitude: spaceBelow, unit: "PT" },
    };

    const doc = await this.getDocumentSnapshot(documentId);
    const tab = this.selectDocumentTab(doc.data, tabId);
    const paragraphRanges = this.findParagraphRanges(
      tab.documentTab.body?.content || [],
      findText,
    );
    if (paragraphRanges.length === 0) {
      return textResponse(`Text "${findText}" not found in any paragraph.`);
    }
    const requiredRevisionId = revisionId || doc.data.revisionId || undefined;
    if (!requiredRevisionId) {
      throw new Error(
        "A document revision ID is required to apply code-block formatting safely",
      );
    }

    const requests: docs_v1.Schema$Request[] = [];
    for (const range of paragraphRanges) {
      const tabRange = this.tabRange(tab.tabId, range.startIndex, range.endIndex);
      requests.push(
        {
          updateTextStyle: {
            range: tabRange,
            textStyle,
            fields: "weightedFontFamily,fontSize,foregroundColor",
          },
        },
        {
          updateParagraphStyle: {
            range: tabRange,
            paragraphStyle,
            fields: "shading,indentStart,indentEnd,spaceAbove,spaceBelow",
          },
        },
      );
    }

    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests,
        writeControl: this.writeControl(requiredRevisionId),
      },
    });

    return textResponse(
      `Applied visual code-block formatting to ${paragraphRanges.length} paragraph(s). This is not a native Google Docs code-block building block.\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async insertTable(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const rows = this.requireInteger(args, "rows", 1);
    const columns = this.requireInteger(args, "columns", 1);
    const tabId = optionalString(args, "tabId");
    const index = this.optionalInteger(args, "index", 1);
    const revisionId = optionalString(args, "revisionId");
    const headerRowValue = args.headerRow;
    if (
      headerRowValue !== undefined &&
      (!Array.isArray(headerRowValue) ||
        headerRowValue.some((value) => typeof value !== "string"))
    ) {
      throw new Error("'headerRow' must be an array of strings");
    }
    const headerRow = headerRowValue as string[] | undefined;
    if (headerRow && headerRow.length > columns) {
      throw new Error(`'headerRow' has ${headerRow.length} cells but the table has ${columns} columns`);
    }

    const insertTable: docs_v1.Schema$InsertTableRequest = { rows, columns };
    if (index !== undefined) {
      insertTable.location = this.tabLocation(tabId || "", index);
    } else {
      insertTable.endOfSegmentLocation = tabId ? { tabId } : {};
    }

    const insertion = await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{ insertTable }],
        writeControl: this.writeControl(revisionId),
      },
    });

    if (headerRow && headerRow.length > 0) {
      try {
        const updatedDoc = await this.getDocumentSnapshot(documentId);
        const selectedTab = this.selectDocumentTab(updatedDoc.data, tabId);
        const tables = this.listTablesInContent(selectedTab.documentTab.body?.content);
        const expectedStart = index === undefined ? undefined : index + 1;
        const locatedTable =
          tables.find((table) => table.startIndex === expectedStart) ||
          tables.sort((a, b) => b.startIndex - a.startIndex)[0];
        const cells = locatedTable?.table.tableRows?.[0]?.tableCells || [];
        if (!locatedTable || cells.length === 0) {
          throw new Error("the newly inserted table could not be located");
        }
        const requests: docs_v1.Schema$Request[] = [];
        for (let cellIndex = headerRow.length - 1; cellIndex >= 0; cellIndex--) {
          const cell = cells[cellIndex];
          if (typeof cell?.startIndex !== "number") {
            throw new Error(`header cell ${cellIndex} has no writable index`);
          }
          const insertIndex =
            cell.content?.[0]?.startIndex ?? cell.startIndex + 1;
          if (headerRow[cellIndex] !== "") {
            requests.push({
              insertText: {
                location: this.tabLocation(selectedTab.tabId, insertIndex),
                text: headerRow[cellIndex],
              },
            });
          }
        }
        if (requests.length > 0) {
          await this.docs.documents.batchUpdate({
            documentId,
            requestBody: {
              requests,
              writeControl: this.writeControl(
                updatedDoc.data.revisionId ||
                  insertion.data.writeControl?.requiredRevisionId ||
                  undefined,
              ),
            },
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `The ${rows} x ${columns} table was created, but its header could not be populated: ${message}`,
        );
      }
    }

    return textResponse(
      `Table inserted successfully (${rows} rows x ${columns} columns)\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async listDocumentTables(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const tabId = optionalString(args, "tabId");
    const response = await this.getDocumentSnapshot(documentId);
    const tabs = tabId
      ? [this.selectDocumentTab(response.data, tabId)]
      : this.flattenDocumentTabs(response.data);
    const tables = tabs.flatMap((tab) =>
      this.listTablesInContent(tab.documentTab.body?.content).map((located) => ({
        tabId: tab.tabId,
        tabTitle: tab.title,
        tableStartIndex: located.startIndex,
        rows: located.table.rows ?? located.table.tableRows?.length ?? 0,
        columns: located.table.columns ?? 0,
        cells: (located.table.tableRows || []).map((row) =>
          (row.tableCells || []).map((cell) =>
            this.structuralElementsToText(cell.content).replace(/\n+$/, ""),
          ),
        ),
      })),
    );
    return textResponse(
      `Tables (${tables.length}):\n${JSON.stringify(tables, null, 2)}`,
    );
  }

  private async setTableCellText(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const tabId = requireString(args, "tabId");
    const tableStartIndex = this.requireInteger(args, "tableStartIndex");
    const rowIndex = this.requireInteger(args, "rowIndex");
    const columnIndex = this.requireInteger(args, "columnIndex");
    const text = this.requireText(args, "text");
    const revisionId = optionalString(args, "revisionId");
    const snapshot = await this.getDocumentSnapshot(documentId);
    const tab = this.selectDocumentTab(snapshot.data, tabId);
    const table = this.requireTable(tab, tableStartIndex);
    const cell = this.findTableCell(table, rowIndex, columnIndex);
    if (
      typeof cell.startIndex !== "number" ||
      typeof cell.endIndex !== "number"
    ) {
      throw new Error("The selected cell does not expose writable indexes");
    }
    if (this.listTablesInContent(cell.content).length > 0) {
      throw new Error("Refusing to replace a cell that contains a nested table");
    }

    const firstContent = cell.content?.[0];
    const lastContent = cell.content?.[cell.content.length - 1];
    const startIndex = firstContent?.startIndex ?? cell.startIndex + 1;
    // Preserve the cell's mandatory final newline.
    const endIndex = (lastContent?.endIndex ?? cell.endIndex) - 1;
    const requests: docs_v1.Schema$Request[] = [];
    if (endIndex > startIndex) {
      requests.push({
        deleteContentRange: {
          range: this.tabRange(tab.tabId, startIndex, endIndex),
        },
      });
    }
    if (text !== "") {
      requests.push({
        insertText: {
          location: this.tabLocation(tab.tabId, startIndex),
          text,
        },
      });
    }
    if (requests.length === 0) {
      return textResponse(`Cell [${rowIndex}, ${columnIndex}] is already empty.`);
    }
    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests,
        writeControl: this.writeControl(
          revisionId || snapshot.data.revisionId || undefined,
        ),
      },
    });
    return textResponse(
      `Updated cell [${rowIndex}, ${columnIndex}] in table ${tableStartIndex}.`,
    );
  }

  private async mutateTableDimension(
    args: Record<string, unknown>,
    operation: "insertRow" | "deleteRow" | "insertColumn" | "deleteColumn",
  ) {
    const documentId = requireString(args, "documentId");
    const tabId = requireString(args, "tabId");
    const tableStartIndex = this.requireInteger(args, "tableStartIndex");
    const rowIndex = this.requireInteger(args, "rowIndex");
    const columnIndex = this.requireInteger(args, "columnIndex");
    const insertAfter = optionalBoolean(args, "insertAfter") ?? false;
    const revisionId = optionalString(args, "revisionId");
    const snapshot = await this.getDocumentSnapshot(documentId);
    const tab = this.selectDocumentTab(snapshot.data, tabId);
    const table = this.requireTable(tab, tableStartIndex);
    this.requireTableCoordinate(table, rowIndex, columnIndex);
    const tableCellLocation: docs_v1.Schema$TableCellLocation = {
      tableStartLocation: this.tabLocation(tab.tabId, tableStartIndex),
      rowIndex,
      columnIndex,
    };
    let request: docs_v1.Schema$Request;
    switch (operation) {
      case "insertRow":
        request = {
          insertTableRow: { tableCellLocation, insertBelow: insertAfter },
        };
        break;
      case "deleteRow":
        request = { deleteTableRow: { tableCellLocation } };
        break;
      case "insertColumn":
        request = {
          insertTableColumn: { tableCellLocation, insertRight: insertAfter },
        };
        break;
      case "deleteColumn":
        request = { deleteTableColumn: { tableCellLocation } };
        break;
    }
    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [request],
        writeControl: this.writeControl(
          revisionId || snapshot.data.revisionId || undefined,
        ),
      },
    });
    return textResponse(`${operation} completed for table ${tableStartIndex}.`);
  }

  private async updateTableRange(
    args: Record<string, unknown>,
    operation: "merge" | "unmerge",
  ) {
    const documentId = requireString(args, "documentId");
    const tabId = requireString(args, "tabId");
    const tableStartIndex = this.requireInteger(args, "tableStartIndex");
    const rowIndex = this.requireInteger(args, "rowIndex");
    const columnIndex = this.requireInteger(args, "columnIndex");
    const rowSpan = this.optionalInteger(args, "rowSpan", 1) ?? 1;
    const columnSpan = this.optionalInteger(args, "columnSpan", 1) ?? 1;
    const revisionId = optionalString(args, "revisionId");
    const snapshot = await this.getDocumentSnapshot(documentId);
    const tab = this.selectDocumentTab(snapshot.data, tabId);
    const table = this.requireTable(tab, tableStartIndex);
    this.requireTableCoordinate(table, rowIndex, columnIndex);
    const rows = table.rows ?? table.tableRows?.length ?? 0;
    const columns = table.columns ?? 0;
    if (rowIndex + rowSpan > rows || columnIndex + columnSpan > columns) {
      throw new Error("The requested table range extends beyond the table bounds");
    }
    const tableRange: docs_v1.Schema$TableRange = {
      tableCellLocation: {
        tableStartLocation: this.tabLocation(tab.tabId, tableStartIndex),
        rowIndex,
        columnIndex,
      },
      rowSpan,
      columnSpan,
    };
    const request: docs_v1.Schema$Request =
      operation === "merge"
        ? { mergeTableCells: { tableRange } }
        : { unmergeTableCells: { tableRange } };
    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [request],
        writeControl: this.writeControl(
          revisionId || snapshot.data.revisionId || undefined,
        ),
      },
    });
    return textResponse(
      `${operation === "merge" ? "Merged" : "Unmerged"} ${rowSpan} x ${columnSpan} cells at [${rowIndex}, ${columnIndex}].`,
    );
  }

  private mergeTableCells(args: Record<string, unknown>) {
    return this.updateTableRange(args, "merge");
  }

  private unmergeTableCells(args: Record<string, unknown>) {
    return this.updateTableRange(args, "unmerge");
  }

  private async updateTableCellStyle(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const tabId = requireString(args, "tabId");
    const tableStartIndex = this.requireInteger(args, "tableStartIndex");
    const rowIndex = this.requireInteger(args, "rowIndex");
    const columnIndex = this.requireInteger(args, "columnIndex");
    const rowSpan = this.optionalInteger(args, "rowSpan", 1) ?? 1;
    const columnSpan = this.optionalInteger(args, "columnSpan", 1) ?? 1;
    const revisionId = optionalString(args, "revisionId");
    const backgroundColor = optionalString(args, "backgroundColor");
    const contentAlignment = optionalString(args, "contentAlignment");
    const style: docs_v1.Schema$TableCellStyle = {};
    const fields: string[] = [];
    if (backgroundColor !== undefined) {
      style.backgroundColor = this.hexColor(backgroundColor);
      fields.push("backgroundColor");
    }
    if (contentAlignment !== undefined) {
      if (!["TOP", "MIDDLE", "BOTTOM"].includes(contentAlignment)) {
        throw new Error("'contentAlignment' must be TOP, MIDDLE, or BOTTOM");
      }
      style.contentAlignment = contentAlignment;
      fields.push("contentAlignment");
    }
    for (const [argument, field] of [
      ["paddingTop", "paddingTop"],
      ["paddingBottom", "paddingBottom"],
      ["paddingLeft", "paddingLeft"],
      ["paddingRight", "paddingRight"],
    ] as const) {
      const value = optionalNumber(args, argument);
      if (value !== undefined) {
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`'${argument}' must be a non-negative number`);
        }
        style[field] = { magnitude: value, unit: "PT" };
        fields.push(field);
      }
    }
    if (fields.length === 0) {
      throw new Error(
        "Provide backgroundColor, contentAlignment, or at least one padding value",
      );
    }
    const snapshot = await this.getDocumentSnapshot(documentId);
    const tab = this.selectDocumentTab(snapshot.data, tabId);
    const table = this.requireTable(tab, tableStartIndex);
    this.requireTableCoordinate(table, rowIndex, columnIndex);
    const rows = table.rows ?? table.tableRows?.length ?? 0;
    const columns = table.columns ?? 0;
    if (rowIndex + rowSpan > rows || columnIndex + columnSpan > columns) {
      throw new Error("The requested style range extends beyond the table bounds");
    }
    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            updateTableCellStyle: {
              tableRange: {
                tableCellLocation: {
                  tableStartLocation: this.tabLocation(tab.tabId, tableStartIndex),
                  rowIndex,
                  columnIndex,
                },
                rowSpan,
                columnSpan,
              },
              tableCellStyle: style,
              fields: fields.join(","),
            },
          },
        ],
        writeControl: this.writeControl(
          revisionId || snapshot.data.revisionId || undefined,
        ),
      },
    });
    return textResponse(
      `Updated ${fields.join(", ")} for table ${tableStartIndex} cells.`,
    );
  }

  private async pinTableHeaderRows(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const tabId = requireString(args, "tabId");
    const tableStartIndex = this.requireInteger(args, "tableStartIndex");
    const pinnedHeaderRowsCount = this.requireInteger(
      args,
      "pinnedHeaderRowsCount",
    );
    const revisionId = optionalString(args, "revisionId");
    const snapshot = await this.getDocumentSnapshot(documentId);
    const tab = this.selectDocumentTab(snapshot.data, tabId);
    const table = this.requireTable(tab, tableStartIndex);
    const rows = table.rows ?? table.tableRows?.length ?? 0;
    if (pinnedHeaderRowsCount > rows) {
      throw new Error(
        `'pinnedHeaderRowsCount' cannot exceed the table's ${rows} rows`,
      );
    }
    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            pinTableHeaderRows: {
              tableStartLocation: this.tabLocation(tab.tabId, tableStartIndex),
              pinnedHeaderRowsCount,
            },
          },
        ],
        writeControl: this.writeControl(
          revisionId || snapshot.data.revisionId || undefined,
        ),
      },
    });
    return textResponse(
      `Pinned ${pinnedHeaderRowsCount} header row(s) for table ${tableStartIndex}.`,
    );
  }

  private async updateParagraphStyle(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const findText = requireString(args, "findText");
    const alignment = optionalString(args, "alignment");
    const lineSpacing = optionalNumber(args, "lineSpacing");
    const bulletPreset = optionalString(args, "bulletPreset");
    const tabId = optionalString(args, "tabId");
    const revisionId = optionalString(args, "revisionId");
    if (alignment && !["START", "CENTER", "END", "JUSTIFIED"].includes(alignment)) {
      throw new Error("'alignment' must be START, CENTER, END, or JUSTIFIED");
    }
    if (lineSpacing !== undefined && (!Number.isFinite(lineSpacing) || lineSpacing <= 0)) {
      throw new Error("'lineSpacing' must be a positive multiplier");
    }
    if (
      bulletPreset &&
      ![
        "BULLET_DISC_CIRCLE_SQUARE",
        "BULLET_ARROW_DIAMOND_DISC",
        "NUMBERED_DECIMAL_NESTED",
      ].includes(bulletPreset)
    ) {
      throw new Error("Unsupported 'bulletPreset'");
    }

    const doc = await this.getDocumentSnapshot(documentId);
    const tab = this.selectDocumentTab(doc.data, tabId);
    const content = tab.documentTab.body?.content || [];
    const paragraphRanges = this.findParagraphRanges(content, findText);
    if (paragraphRanges.length === 0) {
      return textResponse(
        `Text "${findText}" not found in any paragraph.`,
      );
    }

    const requests: docs_v1.Schema$Request[] = [];

    if (alignment || lineSpacing) {
      const paragraphStyle: docs_v1.Schema$ParagraphStyle = {};
      const fields: string[] = [];

      if (alignment) {
        paragraphStyle.alignment = alignment;
        fields.push("alignment");
      }
      if (lineSpacing !== undefined) {
        paragraphStyle.lineSpacing = lineSpacing * 100;
        fields.push("lineSpacing");
      }
      for (const range of paragraphRanges) {
        requests.push({
          updateParagraphStyle: {
            range: this.tabRange(tab.tabId, range.startIndex, range.endIndex),
            paragraphStyle,
            fields: fields.join(","),
          },
        });
      }
    }

    // Bullet creation can remove leading tabs and shift indexes, so style first.
    if (bulletPreset) {
      for (const range of [...paragraphRanges].sort(
        (a, b) => b.startIndex - a.startIndex,
      )) {
        requests.push({
          createParagraphBullets: {
            range: this.tabRange(tab.tabId, range.startIndex, range.endIndex),
            bulletPreset,
          },
        });
      }
    }

    if (requests.length === 0) {
      return textResponse(
        "No style changes specified. Please provide alignment, lineSpacing, or bulletPreset.",
      );
    }

    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests,
        writeControl: this.writeControl(revisionId || doc.data.revisionId || undefined),
      },
    });

    return textResponse(
      `Updated ${paragraphRanges.length} paragraph(s).\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async batchUpdate(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const requests = args.requests;
    const requiredRevisionId = optionalString(args, "requiredRevisionId");
    const targetRevisionId = optionalString(args, "targetRevisionId");

    if (!Array.isArray(requests) || requests.length === 0) {
      throw new Error("'requests' must be a non-empty array");
    }
    if (requests.length > MAX_BATCH_REQUESTS) {
      throw new Error(`'requests' cannot contain more than ${MAX_BATCH_REQUESTS} items`);
    }
    if (requests.some((request) => !request || typeof request !== "object" || Array.isArray(request))) {
      throw new Error("Every item in 'requests' must be an object");
    }
    if (requiredRevisionId && targetRevisionId) {
      throw new Error(
        "Use either 'requiredRevisionId' or 'targetRevisionId', not both",
      );
    }

    const response = await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: requests as docs_v1.Schema$Request[],
        writeControl:
          requiredRevisionId || targetRevisionId
            ? { requiredRevisionId, targetRevisionId }
            : undefined,
      },
    });

    const repliesCount = response.data.replies?.length || 0;

    return textResponse(
      `Batch update completed successfully!\nOperations executed: ${requests.length}\nReplies received: ${repliesCount}\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async readDocumentAsMarkdown(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const tabId = optionalString(args, "tabId");
    const suggestionsViewMode =
      this.suggestionsViewMode(args) || "DEFAULT_FOR_CURRENT_ACCESS";
    const doc = await this.getDocumentSnapshot(documentId, suggestionsViewMode);
    const title = doc.data.title || "Untitled";
    const tabs = tabId
      ? [this.selectDocumentTab(doc.data, tabId)]
      : this.flattenDocumentTabs(doc.data);
    const markdown = tabs
      .map((tab) => {
        const legacyDocument: docs_v1.Schema$Document = {
          ...doc.data,
          body: tab.documentTab.body,
          lists: tab.documentTab.lists,
          headers: tab.documentTab.headers,
          footers: tab.documentTab.footers,
          footnotes: tab.documentTab.footnotes,
          inlineObjects: tab.documentTab.inlineObjects,
          namedRanges: tab.documentTab.namedRanges,
          namedStyles: tab.documentTab.namedStyles,
          positionedObjects: tab.documentTab.positionedObjects,
          documentStyle: tab.documentTab.documentStyle,
          tabs: undefined,
        };
        const content = documentToMarkdown(legacyDocument);
        return tabs.length > 1 || tabId
          ? `## ${tab.title}\n\n<!-- tabId: ${tab.tabId} -->\n\n${content}`
          : content;
      })
      .join("\n\n---\n\n");

    return textResponse(
      `# ${title}\n\n<!-- revisionId: ${doc.data.revisionId || "unknown"}; suggestionsViewMode: ${doc.data.suggestionsViewMode || suggestionsViewMode} -->\n\n${markdown}`,
    );
  }

  private async createDocumentFromMarkdown(args: Record<string, unknown>) {
    const title = requireString(args, "title");
    const markdown = requireString(args, "markdown");
    const folderId = optionalString(args, "folderId");

    const safeTitle = title.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = `<html><head><title>${safeTitle}</title></head><body>${markdownToHtml(markdown)}</body></html>`;

    const { Readable } = await import("stream");
    const response = await this.drive.files.create({
      requestBody: {
        name: title,
        mimeType: "application/vnd.google-apps.document",
        parents: folderId ? [folderId] : undefined,
      },
      media: {
        mimeType: "text/html",
        body: Readable.from(Buffer.from(html, "utf-8")),
      },
      fields: "id, name, webViewLink",
      supportsAllDrives: true,
    });

    const file = response.data;
    return textResponse(
      `Document created from Markdown!\nTitle: ${title}\nID: ${file.id}\nURL: ${file.webViewLink}`,
    );
  }

  private async insertText(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const text = requireString(args, "text");
    const index = this.requireInteger(args, "index");
    const tabId = optionalString(args, "tabId");
    const revisionId = optionalString(args, "revisionId");

    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          { insertText: { location: this.tabLocation(tabId || "", index), text } },
        ],
        writeControl: this.writeControl(revisionId),
      },
    });

    return textResponse(
      `Text inserted at index ${index}.\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async deleteRange(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const startIndex = this.requireInteger(args, "startIndex");
    const endIndex = this.requireInteger(args, "endIndex");
    const tabId = optionalString(args, "tabId");
    const revisionId = optionalString(args, "revisionId");
    if (endIndex <= startIndex) {
      throw new Error("'endIndex' must be greater than 'startIndex'");
    }

    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            deleteContentRange: {
              range: this.tabRange(tabId || "", startIndex, endIndex),
            },
          },
        ],
        writeControl: this.writeControl(revisionId),
      },
    });

    return textResponse(
      `Deleted range [${startIndex}, ${endIndex}).\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async insertImage(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const imageUrl = requireString(args, "imageUrl");
    const width = optionalNumber(args, "width");
    const height = optionalNumber(args, "height");
    const index = this.optionalInteger(args, "index");
    const tabId = optionalString(args, "tabId");
    const revisionId = optionalString(args, "revisionId");
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(imageUrl);
    } catch {
      throw new Error("'imageUrl' must be a valid public HTTP(S) URL");
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || imageUrl.length > 2048) {
      throw new Error("'imageUrl' must be an HTTP(S) URL no longer than 2048 characters");
    }
    for (const [field, value] of [["width", width], ["height", height]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        throw new Error(`'${field}' must be a positive number`);
      }
    }

    const request: docs_v1.Schema$Request = {
      insertInlineImage: {
        ...(index === undefined
          ? { endOfSegmentLocation: tabId ? { tabId } : {} }
          : { location: this.tabLocation(tabId || "", index) }),
        uri: imageUrl,
      },
    };

    if (width || height) {
      request.insertInlineImage!.objectSize = {};
      if (width) {
        request.insertInlineImage!.objectSize.width = {
          magnitude: width,
          unit: "PT",
        };
      }
      if (height) {
        request.insertInlineImage!.objectSize.height = {
          magnitude: height,
          unit: "PT",
        };
      }
    }

    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [request],
        writeControl: this.writeControl(revisionId),
      },
    });

    return textResponse(
      `Image inserted ${index === undefined ? "at the end of the tab" : `at index ${index}`}.\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async insertPageBreak(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const index = this.optionalInteger(args, "index");
    const tabId = optionalString(args, "tabId");
    const revisionId = optionalString(args, "revisionId");

    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            insertPageBreak:
              index === undefined
                ? { endOfSegmentLocation: tabId ? { tabId } : {} }
                : { location: this.tabLocation(tabId || "", index) },
          },
        ],
        writeControl: this.writeControl(revisionId),
      },
    });

    return textResponse(
      `Page break inserted ${index === undefined ? "at the end of the tab" : `at index ${index}`}.\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }
}
