import { google, type slides_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Service, ToolDefinition } from "../types.js";
import {
  jsonResponse,
  MAX_BATCH_REQUESTS,
  optionalNumber,
  optionalString,
  requireString,
} from "../utils.js";

function requireRequests(args: Record<string, unknown>): slides_v1.Schema$Request[] {
  const value = args.requests;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_BATCH_REQUESTS ||
    value.some((item) => typeof item !== "object" || item === null || Array.isArray(item))
  ) {
    throw new Error(
      `'requests' must contain 1-${MAX_BATCH_REQUESTS} Slides batchUpdate request objects`,
    );
  }
  return value as slides_v1.Schema$Request[];
}

function extractElementText(element: slides_v1.Schema$PageElement): string[] {
  const lines: string[] = [];
  const shapeText = element.shape?.text?.textElements;
  for (const textElement of shapeText ?? []) {
    const text = textElement.textRun?.content?.trim();
    if (text) lines.push(text);
  }
  for (const row of element.table?.tableRows ?? []) {
    const cells = (row.tableCells ?? []).map((cell) =>
      (cell.text?.textElements ?? [])
        .map((part) => part.textRun?.content ?? "")
        .join("")
        .trim(),
    );
    if (cells.some(Boolean)) lines.push(cells.join(" | "));
  }
  return lines;
}

export class SlidesService implements Service {
  private slides!: slides_v1.Slides;

  initialize(auth: OAuth2Client): void {
    this.slides = google.slides({ version: "v1", auth });
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        tool: {
          name: "read_presentation",
          description:
            "Read a Google Slides presentation, including slide IDs, speaker notes, shapes, tables, and extracted text.",
          inputSchema: {
            type: "object",
            properties: {
              presentationId: { type: "string", description: "Presentation ID" },
              fields: {
                type: "string",
                description: "Optional Google API partial-response field mask",
              },
            },
            required: ["presentationId"],
          },
        },
        handler: (args) => this.readPresentation(args),
      },
      {
        tool: {
          name: "get_slide",
          description: "Get one slide or page from a presentation by object ID.",
          inputSchema: {
            type: "object",
            properties: {
              presentationId: { type: "string" },
              pageObjectId: { type: "string" },
            },
            required: ["presentationId", "pageObjectId"],
          },
        },
        handler: (args) => this.getSlide(args),
      },
      {
        tool: {
          name: "get_slide_thumbnail",
          description: "Generate a temporary thumbnail URL for a slide.",
          inputSchema: {
            type: "object",
            properties: {
              presentationId: { type: "string" },
              pageObjectId: { type: "string" },
              mimeType: { type: "string", enum: ["PNG"] },
              thumbnailSize: {
                type: "string",
                enum: ["SMALL", "MEDIUM", "LARGE"],
              },
            },
            required: ["presentationId", "pageObjectId"],
          },
        },
        handler: (args) => this.getThumbnail(args),
      },
      {
        tool: {
          name: "create_presentation",
          description: "Create a blank Google Slides presentation.",
          inputSchema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
        handler: (args) => this.createPresentation(args),
      },
      {
        tool: {
          name: "update_presentation",
          description:
            "Atomically apply one or more official Google Slides batchUpdate requests. Returns every API reply and write control.",
          inputSchema: {
            type: "object",
            properties: {
              presentationId: { type: "string" },
              requests: {
                type: "array",
                minItems: 1,
                maxItems: MAX_BATCH_REQUESTS,
                items: { type: "object" },
              },
              requiredRevisionId: {
                type: "string",
                description: "Reject the update if the presentation revision changed",
              },
            },
            required: ["presentationId", "requests"],
          },
        },
        handler: (args) => this.updatePresentation(args),
      },
      {
        tool: {
          name: "duplicate_slide",
          description: "Duplicate an existing slide and optionally assign a deterministic object ID.",
          inputSchema: {
            type: "object",
            properties: {
              presentationId: { type: "string" },
              slideObjectId: { type: "string" },
              newSlideObjectId: { type: "string" },
            },
            required: ["presentationId", "slideObjectId"],
          },
        },
        handler: (args) => this.duplicateSlide(args),
      },
      {
        tool: {
          name: "create_slide",
          description: "Create a slide at an optional insertion index using a predefined layout.",
          inputSchema: {
            type: "object",
            properties: {
              presentationId: { type: "string" },
              objectId: { type: "string" },
              insertionIndex: { type: "number", minimum: 0 },
              predefinedLayout: {
                type: "string",
                description: "For example TITLE_AND_BODY, TITLE_ONLY, BLANK, or SECTION_HEADER",
              },
            },
            required: ["presentationId"],
          },
        },
        handler: (args) => this.createSlide(args),
      },
    ];
  }

  private async readPresentation(args: Record<string, unknown>) {
    const presentationId = requireString(args, "presentationId");
    const fields = optionalString(args, "fields");
    const response = await this.slides.presentations.get({ presentationId, fields });
    const presentation = response.data;
    const slideText = (presentation.slides ?? []).map((slide, index) => ({
      index,
      objectId: slide.objectId,
      text: (slide.pageElements ?? []).flatMap(extractElementText),
      notesPageObjectId: slide.slideProperties?.notesPage?.objectId,
    }));
    return jsonResponse(
      { presentation, slideText },
      `Presentation "${presentation.title ?? "Untitled"}" returned with ${presentation.slides?.length ?? 0} slide(s) in structuredContent.`,
    );
  }

  private async getSlide(args: Record<string, unknown>) {
    const response = await this.slides.presentations.pages.get({
      presentationId: requireString(args, "presentationId"),
      pageObjectId: requireString(args, "pageObjectId"),
    });
    return jsonResponse(
      { page: response.data },
      `Slide returned: ${response.data.objectId ?? "object ID not returned"}`,
    );
  }

  private async getThumbnail(args: Record<string, unknown>) {
    const response = await this.slides.presentations.pages.getThumbnail({
      presentationId: requireString(args, "presentationId"),
      pageObjectId: requireString(args, "pageObjectId"),
      "thumbnailProperties.mimeType": optionalString(args, "mimeType") ?? "PNG",
      "thumbnailProperties.thumbnailSize":
        optionalString(args, "thumbnailSize") ?? "MEDIUM",
    });
    return jsonResponse(
      { thumbnail: response.data },
      "Slide thumbnail metadata returned in structuredContent.",
    );
  }

  private async createPresentation(args: Record<string, unknown>) {
    const response = await this.slides.presentations.create({
      requestBody: { title: requireString(args, "title") },
    });
    return jsonResponse(
      { presentation: response.data },
      `Presentation created: ${response.data.presentationId ?? "ID not returned"}`,
    );
  }

  private async updatePresentation(args: Record<string, unknown>) {
    const requiredRevisionId = optionalString(args, "requiredRevisionId");
    const response = await this.slides.presentations.batchUpdate({
      presentationId: requireString(args, "presentationId"),
      requestBody: {
        requests: requireRequests(args),
        writeControl: requiredRevisionId ? { requiredRevisionId } : undefined,
      },
    });
    return jsonResponse(
      { result: response.data },
      `Presentation updated with ${response.data.replies?.length ?? 0} API reply/replies.`,
    );
  }

  private async duplicateSlide(args: Record<string, unknown>) {
    const newSlideObjectId = optionalString(args, "newSlideObjectId");
    const response = await this.slides.presentations.batchUpdate({
      presentationId: requireString(args, "presentationId"),
      requestBody: {
        requests: [
          {
            duplicateObject: {
              objectId: requireString(args, "slideObjectId"),
              objectIds: newSlideObjectId
                ? { [requireString(args, "slideObjectId")]: newSlideObjectId }
                : undefined,
            },
          },
        ],
      },
    });
    return jsonResponse(
      { result: response.data },
      "Slide duplicated; result is in structuredContent.",
    );
  }

  private async createSlide(args: Record<string, unknown>) {
    const insertionIndex = optionalNumber(args, "insertionIndex");
    if (insertionIndex !== undefined && (!Number.isInteger(insertionIndex) || insertionIndex < 0)) {
      throw new Error("'insertionIndex' must be a non-negative integer");
    }
    const response = await this.slides.presentations.batchUpdate({
      presentationId: requireString(args, "presentationId"),
      requestBody: {
        requests: [
          {
            createSlide: {
              objectId: optionalString(args, "objectId"),
              insertionIndex,
              slideLayoutReference: {
                predefinedLayout:
                  optionalString(args, "predefinedLayout") ?? "BLANK",
              },
            },
          },
        ],
      },
    });
    return jsonResponse(
      { result: response.data },
      "Slide created; result is in structuredContent.",
    );
  }
}
