import { google, type docs_v1, type drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import type { Service, ToolDefinition } from "../types.js";
import {
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  textResponse,
  MIN_MARKDOWN_LENGTH,
  MIN_CONTENT_HTML_LENGTH,
} from "../utils.js";

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
        handler: (args) => this.readDocument(args),
      },
      {
        tool: {
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
            },
            required: ["documentId", "findText"],
          },
        },
        handler: (args) => this.formatText(args),
      },
      {
        tool: {
          name: "insert_table_in_document",
          description: "Insert a table at the end of a Google Doc.",
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
        handler: (args) => this.insertTable(args),
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
                description:
                  "Array of Google Docs API request objects (insertText, deleteContentRange, replaceAllText, updateTextStyle, etc.)",
              },
            },
            required: ["documentId", "requests"],
          },
        },
        handler: (args) => this.batchUpdate(args),
      },
    ];
  }

  private getDocumentEndIndex(
    content: docs_v1.Schema$StructuralElement[],
  ): number {
    const lastElement = content[content.length - 1];
    return lastElement?.endIndex || 1;
  }

  private findTextRanges(
    content: docs_v1.Schema$StructuralElement[],
    searchText: string,
  ): Array<{ startIndex: number; endIndex: number }> {
    const ranges: Array<{ startIndex: number; endIndex: number }> = [];

    for (const element of content) {
      if (!element.paragraph) continue;
      for (const textElement of element.paragraph.elements || []) {
        if (!textElement.textRun?.content) continue;
        const text = textElement.textRun.content;
        const startOffset = textElement.startIndex || 0;
        let searchIndex = 0;

        while (true) {
          const foundIndex = text.indexOf(searchText, searchIndex);
          if (foundIndex === -1) break;
          ranges.push({
            startIndex: startOffset + foundIndex,
            endIndex: startOffset + foundIndex + searchText.length,
          });
          searchIndex = foundIndex + 1;
        }
      }
    }

    return ranges;
  }

  private async readDocument(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");

    const doc = await this.docs.documents.get({ documentId });
    const title = doc.data.title;
    const body = doc.data.body;

    let text = "";
    if (body?.content) {
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

    return textResponse(`Document: ${title}\n\n${text}`);
  }

  private async readRestrictedDocument(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");

    const accessToken = await this.auth.getAccessToken();
    if (!accessToken.token) {
      throw new Error("Failed to obtain access token");
    }

    const url = `https://docs.google.com/document/d/${documentId}/mobilebasic`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch document: ${response.status} ${response.statusText}`,
      );
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    let title =
      $("title").text().trim() ||
      $("h1").first().text().trim() ||
      "Untitled Document";
    title = title.replace(/ - Google Docs$/i, "").trim();

    let contentHtml = "";
    const mainContent = $(
      ".doc-content, .document-content, #contents, main",
    );
    if (mainContent.length > 0) {
      contentHtml = mainContent.html() || "";
    }

    if (!contentHtml || contentHtml.length < MIN_CONTENT_HTML_LENGTH) {
      const contentElements: string[] = [];
      $("h1, h2, h3, h4, h5, h6, p, ul, ol, table").each((_i, elem) => {
        const elementHtml = $(elem).prop("outerHTML");
        if (elementHtml && $(elem).text().trim().length > 0) {
          contentElements.push(elementHtml);
        }
      });
      contentHtml = contentElements.join("\n");
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
        markdown = $("body").text().trim();
      }
    }

    if (!markdown || markdown.trim().length < MIN_MARKDOWN_LENGTH) {
      const paragraphs: string[] = [];
      $("p, h1, h2, h3, h4, h5, h6").each((_i, elem) => {
        const text = $(elem).text().trim();
        if (text.length > 0) {
          const tagName = (elem as unknown as { tagName?: string }).tagName?.toLowerCase();
          if (tagName?.startsWith("h")) {
            const level = parseInt(tagName.slice(1));
            paragraphs.push(`${"#".repeat(level)} ${text}`);
          } else {
            paragraphs.push(text);
          }
        }
      });
      markdown = paragraphs.join("\n\n");
    }

    markdown = markdown.replace(/\n{4,}/g, "\n\n\n").trim();

    return textResponse(
      `# ${title}\n\n${markdown}\n\n---\n*Content extracted from restricted document using mobilebasic endpoint and converted to Markdown*`,
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
      });
    }

    return textResponse(
      `Document created successfully!\nTitle: ${title}\nID: ${documentId}\nURL: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async appendText(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const text = requireString(args, "text");

    const doc = await this.docs.documents.get({ documentId });
    const content = doc.data.body?.content || [];
    const endIndex = this.getDocumentEndIndex(content);

    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          { insertText: { location: { index: endIndex - 1 }, text } },
        ],
      },
    });

    return textResponse(
      `Text appended successfully!\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async replaceText(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const findText = requireString(args, "findText");
    const replaceText = requireString(args, "replaceText");
    const matchCase = optionalBoolean(args, "matchCase");

    const response = await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            replaceAllText: {
              containsText: { text: findText, matchCase: matchCase || false },
              replaceText,
            },
          },
        ],
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

    const doc = await this.docs.documents.get({ documentId });
    const content = doc.data.body?.content || [];
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
      const hex = foregroundColor.replace("#", "");
      textStyle.foregroundColor = {
        color: {
          rgbColor: {
            red: parseInt(hex.substring(0, 2), 16) / 255,
            green: parseInt(hex.substring(2, 4), 16) / 255,
            blue: parseInt(hex.substring(4, 6), 16) / 255,
          },
        },
      };
      fields.push("foregroundColor");
    }

    // Apply in reverse order to maintain indices
    const requests = ranges
      .sort((a, b) => b.startIndex - a.startIndex)
      .map((range) => ({
        updateTextStyle: {
          range: { startIndex: range.startIndex, endIndex: range.endIndex },
          textStyle,
          fields: fields.join(","),
        },
      }));

    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests },
    });

    return textResponse(
      `Formatted ${ranges.length} occurrence(s) of "${findText}"\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async insertTable(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const rows = requireNumber(args, "rows");
    const columns = requireNumber(args, "columns");
    const headerRow = args.headerRow as string[] | undefined;

    const doc = await this.docs.documents.get({ documentId });
    const content = doc.data.body?.content || [];
    const endIndex = this.getDocumentEndIndex(content);

    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            insertTable: {
              rows,
              columns,
              location: { index: endIndex - 1 },
            },
          },
        ],
      },
    });

    if (headerRow && headerRow.length > 0) {
      const updatedDoc = await this.docs.documents.get({ documentId });
      const updatedContent = updatedDoc.data.body?.content || [];

      // Find the LAST table (the newly inserted one)
      const tables = updatedContent.filter(
        (el) => el.table,
      );
      const table = tables[tables.length - 1];

      if (table?.table?.tableRows?.[0]?.tableCells) {
        const cells = table.table.tableRows[0].tableCells;
        const requests: docs_v1.Schema$Request[] = [];

        // Insert header text in reverse order to maintain indices
        for (
          let i = Math.min(headerRow.length, cells.length) - 1;
          i >= 0;
          i--
        ) {
          const cell = cells[i];
          const cellContent = cell.content?.[0];
          const insertIndex =
            cellContent?.startIndex || (cell as { startIndex?: number }).startIndex! + 1;

          requests.push({
            insertText: {
              location: { index: insertIndex },
              text: headerRow[i],
            },
          });
        }

        if (requests.length > 0) {
          await this.docs.documents.batchUpdate({
            documentId,
            requestBody: { requests },
          });
        }
      }
    }

    return textResponse(
      `Table inserted successfully (${rows} rows x ${columns} columns)\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async updateParagraphStyle(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const findText = requireString(args, "findText");
    const alignment = optionalString(args, "alignment");
    const lineSpacing = optionalNumber(args, "lineSpacing");
    const bulletPreset = optionalString(args, "bulletPreset");

    const doc = await this.docs.documents.get({ documentId });
    const content = doc.data.body?.content || [];

    let paragraphRange: { startIndex: number; endIndex: number } | null = null;

    for (const element of content) {
      if (!element.paragraph) continue;
      let paragraphText = "";
      for (const textElement of element.paragraph.elements || []) {
        if (textElement.textRun?.content) {
          paragraphText += textElement.textRun.content;
        }
      }
      if (paragraphText.includes(findText)) {
        paragraphRange = {
          startIndex: element.startIndex || 0,
          endIndex: element.endIndex || 0,
        };
        break;
      }
    }

    if (!paragraphRange) {
      return textResponse(
        `Text "${findText}" not found in any paragraph.`,
      );
    }

    const requests: docs_v1.Schema$Request[] = [];

    if (bulletPreset) {
      requests.push({
        createParagraphBullets: {
          range: {
            startIndex: paragraphRange.startIndex,
            endIndex: paragraphRange.endIndex,
          },
          bulletPreset,
        },
      });
    }

    if (alignment || lineSpacing) {
      const paragraphStyle: docs_v1.Schema$ParagraphStyle = {};
      const fields: string[] = [];

      if (alignment) {
        paragraphStyle.alignment = alignment;
        fields.push("alignment");
      }
      if (lineSpacing) {
        paragraphStyle.lineSpacing = lineSpacing * 100;
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
      return textResponse(
        "No style changes specified. Please provide alignment, lineSpacing, or bulletPreset.",
      );
    }

    await this.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests },
    });

    return textResponse(
      `Paragraph style updated successfully!\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }

  private async batchUpdate(args: Record<string, unknown>) {
    const documentId = requireString(args, "documentId");
    const requests = args.requests;

    if (!Array.isArray(requests) || requests.length === 0) {
      throw new Error("'requests' must be a non-empty array");
    }

    const response = await this.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests },
    });

    const repliesCount = response.data.replies?.length || 0;

    return textResponse(
      `Batch update completed successfully!\nOperations executed: ${requests.length}\nReplies received: ${repliesCount}\nDocument: https://docs.google.com/document/d/${documentId}/edit`,
    );
  }
}

function requireNumber(
  args: Record<string, unknown>,
  field: string,
): number {
  const value = args[field];
  if (typeof value !== "number") {
    throw new Error(`'${field}' is required and must be a number`);
  }
  return value;
}
