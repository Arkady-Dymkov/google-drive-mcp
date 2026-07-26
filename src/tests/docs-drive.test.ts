import test from "node:test";
import assert from "node:assert/strict";
import type { ToolResponse } from "../types.js";
import { DocsService } from "../services/docs.js";
import { DriveService } from "../services/drive.js";

function setPrivate(target: object, property: string, value: unknown): void {
  Object.defineProperty(target, property, {
    configurable: true,
    writable: true,
    value,
  });
}

function handler(
  service: DocsService | DriveService,
  name: string,
): (args: Record<string, unknown>) => Promise<ToolResponse> {
  const definition = service
    .getToolDefinitions()
    .find((candidate) => candidate.tool.name === name);
  assert.ok(definition, `Missing tool ${name}`);
  return definition.handler;
}

function responseText(response: ToolResponse): string {
  const content = response.content[0];
  assert.equal(content?.type, "text");
  return content.text;
}

const tabbedDocument = {
  documentId: "doc1",
  title: "Tabbed document",
  revisionId: "revision-1",
  tabs: [
    {
      tabProperties: {
        tabId: "tab-root",
        title: "Overview",
        index: 0,
        nestingLevel: 0,
      },
      documentTab: {
        body: {
          content: [
            {
              startIndex: 1,
              endIndex: 13,
              paragraph: {
                elements: [
                  { startIndex: 1, endIndex: 6, textRun: { content: "hello" } },
                  {
                    startIndex: 6,
                    endIndex: 13,
                    textRun: { content: " world\n" },
                  },
                ],
              },
            },
            {
              startIndex: 20,
              endIndex: 31,
              table: {
                rows: 1,
                columns: 1,
                tableRows: [
                  {
                    tableCells: [
                      {
                        startIndex: 21,
                        endIndex: 30,
                        tableCellStyle: { columnSpan: 1 },
                        content: [
                          {
                            startIndex: 22,
                            endIndex: 28,
                            paragraph: {
                              elements: [
                                {
                                  startIndex: 22,
                                  endIndex: 28,
                                  textRun: { content: "value\n" },
                                },
                              ],
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
      childTabs: [
        {
          tabProperties: {
            tabId: "tab-child",
            title: "Details",
            parentTabId: "tab-root",
            index: 0,
            nestingLevel: 1,
          },
          documentTab: { body: { content: [] } },
        },
      ],
    },
  ],
};

test("Docs lists nested tabs and creates tabs with official request objects", async () => {
  const service = new DocsService();
  const updates: Record<string, unknown>[] = [];
  setPrivate(service, "docs", {
    documents: {
      get: async () => ({ data: tabbedDocument }),
      batchUpdate: async (params: Record<string, unknown>) => {
        updates.push(params);
        return {
          data: {
            replies: [
              {
                addDocumentTab: {
                  tabProperties: { tabId: "new-tab", title: "New tab" },
                },
              },
            ],
            writeControl: { requiredRevisionId: "revision-2" },
          },
        };
      },
    },
  });

  const listed = await handler(service, "list_document_tabs")({ documentId: "doc1" });
  assert.match(responseText(listed), /Overview \(ID: tab-root/);
  assert.match(responseText(listed), /Details \(ID: tab-child/);

  await handler(service, "create_document_tab")({
    documentId: "doc1",
    title: "New tab",
    parentTabId: "tab-root",
    index: 1,
    revisionId: "revision-1",
  });
  const requestBody = updates[0].requestBody as {
    requests: Array<{ addDocumentTab?: { tabProperties?: Record<string, unknown> } }>;
    writeControl?: { requiredRevisionId?: string };
  };
  assert.deepEqual(requestBody.requests[0].addDocumentTab?.tabProperties, {
    title: "New tab",
    parentTabId: "tab-root",
    index: 1,
  });
  assert.equal(requestBody.writeControl?.requiredRevisionId, "revision-1");
});

test("Docs formats matches spanning text runs in the selected tab", async () => {
  const service = new DocsService();
  let update: Record<string, unknown> | undefined;
  setPrivate(service, "docs", {
    documents: {
      get: async () => ({ data: tabbedDocument }),
      batchUpdate: async (params: Record<string, unknown>) => {
        update = params;
        return { data: {} };
      },
    },
  });

  await handler(service, "format_text_in_document")({
    documentId: "doc1",
    tabId: "tab-root",
    findText: "lo wo",
    bold: true,
  });
  const body = update?.requestBody as {
    requests: Array<{
      updateTextStyle?: { range?: Record<string, unknown>; fields?: string };
    }>;
    writeControl?: { requiredRevisionId?: string };
  };
  assert.deepEqual(body.requests[0].updateTextStyle?.range, {
    startIndex: 4,
    endIndex: 9,
    tabId: "tab-root",
  });
  assert.equal(body.requests[0].updateTextStyle?.fields, "bold");
  assert.equal(body.writeControl?.requiredRevisionId, "revision-1");
});

test("Docs code-block formatting is tab-aware, atomic, revision-guarded, and documented in its schema", async () => {
  const service = new DocsService();
  const definition = service
    .getToolDefinitions()
    .find(({ tool }) => tool.name === "format_code_block_in_document");
  assert.ok(definition);
  assert.match(definition.tool.description || "", /visual code-block approximation/i);
  assert.match(definition.tool.description || "", /does not create/i);
  const schema = definition.tool.inputSchema as {
    additionalProperties?: boolean;
    properties?: Record<string, Record<string, unknown>>;
  };
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties?.fontFamily?.default, "Roboto Mono");
  assert.equal(schema.properties?.fontWeight?.multipleOf, 100);
  assert.equal(schema.properties?.foregroundColor?.pattern, "^#?[0-9A-Fa-f]{6}$");

  const updates: Record<string, unknown>[] = [];
  setPrivate(service, "docs", {
    documents: {
      get: async () => ({ data: tabbedDocument }),
      batchUpdate: async (params: Record<string, unknown>) => {
        updates.push(params);
        return { data: {} };
      },
    },
  });

  await definition.handler({
    documentId: "doc1",
    tabId: "tab-root",
    findText: "hello",
    revisionId: "caller-revision",
  });

  assert.equal(updates.length, 1);
  const body = updates[0].requestBody as {
    requests: Array<Record<string, unknown>>;
    writeControl?: { requiredRevisionId?: string };
  };
  assert.equal(body.writeControl?.requiredRevisionId, "caller-revision");
  assert.equal(body.requests.length, 2);
  assert.deepEqual(body.requests[0], {
    updateTextStyle: {
      range: { startIndex: 1, endIndex: 13, tabId: "tab-root" },
      textStyle: {
        weightedFontFamily: { fontFamily: "Roboto Mono", weight: 400 },
        fontSize: { magnitude: 10, unit: "PT" },
        foregroundColor: {
          color: {
            rgbColor: { red: 32 / 255, green: 33 / 255, blue: 36 / 255 },
          },
        },
      },
      fields: "weightedFontFamily,fontSize,foregroundColor",
    },
  });
  assert.deepEqual(body.requests[1], {
    updateParagraphStyle: {
      range: { startIndex: 1, endIndex: 13, tabId: "tab-root" },
      paragraphStyle: {
        shading: {
          backgroundColor: {
            color: {
              rgbColor: { red: 241 / 255, green: 243 / 255, blue: 244 / 255 },
            },
          },
        },
        indentStart: { magnitude: 12, unit: "PT" },
        indentEnd: { magnitude: 12, unit: "PT" },
        spaceAbove: { magnitude: 6, unit: "PT" },
        spaceBelow: { magnitude: 6, unit: "PT" },
      },
      fields: "shading,indentStart,indentEnd,spaceAbove,spaceBelow",
    },
  });
});

test("Docs read exposes the requested suggestions preview and revision", async () => {
  const service = new DocsService();
  let getRequest: Record<string, unknown> | undefined;
  setPrivate(service, "docs", {
    documents: {
      get: async (params: Record<string, unknown>) => {
        getRequest = params;
        return {
          data: {
            ...tabbedDocument,
            suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS",
          },
        };
      },
    },
  });
  const response = await handler(service, "read_document")({
    documentId: "doc1",
    suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS",
  });
  assert.equal(getRequest?.includeTabsContent, true);
  assert.equal(
    getRequest?.suggestionsViewMode,
    "PREVIEW_WITHOUT_SUGGESTIONS",
  );
  assert.match(responseText(response), /Revision: revision-1/);
  assert.match(
    responseText(response),
    /Suggestions view: PREVIEW_WITHOUT_SUGGESTIONS/,
  );
});

test("Docs replaces table cell content with a revision-guarded atomic batch", async () => {
  const service = new DocsService();
  let update: Record<string, unknown> | undefined;
  setPrivate(service, "docs", {
    documents: {
      get: async () => ({ data: tabbedDocument }),
      batchUpdate: async (params: Record<string, unknown>) => {
        update = params;
        return { data: {} };
      },
    },
  });

  await handler(service, "set_table_cell_text")({
    documentId: "doc1",
    tabId: "tab-root",
    tableStartIndex: 20,
    rowIndex: 0,
    columnIndex: 0,
    text: "updated",
  });
  const body = update?.requestBody as {
    requests: Array<Record<string, unknown>>;
    writeControl?: { requiredRevisionId?: string };
  };
  assert.deepEqual(body.requests, [
    {
      deleteContentRange: {
        range: { startIndex: 22, endIndex: 27, tabId: "tab-root" },
      },
    },
    {
      insertText: {
        location: { index: 22, tabId: "tab-root" },
        text: "updated",
      },
    },
  ]);
  assert.equal(body.writeControl?.requiredRevisionId, "revision-1");
});

test("Drive read_file returns binary bytes losslessly as base64", async () => {
  const service = new DriveService();
  const binary = Buffer.from([0, 255, 1, 128, 42]);
  setPrivate(service, "drive", {
    files: {
      get: async (params: Record<string, unknown>) =>
        params.alt === "media"
          ? { data: binary }
          : {
              data: {
                id: "file1",
                name: "sample.bin",
                mimeType: "application/octet-stream",
                size: String(binary.length),
              },
            },
    },
  });

  const response = await handler(service, "read_file")({ fileId: "file1" });
  assert.match(responseText(response), /Encoding: base64/);
  assert.match(responseText(response), new RegExp(binary.toString("base64")));
});

test("Drive accepts base64 uploads and uses a streaming media body", async () => {
  const service = new DriveService();
  let uploaded = Buffer.alloc(0);
  setPrivate(service, "drive", {
    files: {
      create: async (params: Record<string, unknown>) => {
        const media = params.media as { body: AsyncIterable<Buffer> };
        const chunks: Buffer[] = [];
        for await (const chunk of media.body) chunks.push(Buffer.from(chunk));
        uploaded = Buffer.concat(chunks);
        return { data: { id: "file1", name: "sample.bin", webViewLink: "https://x" } };
      },
    },
  });

  await handler(service, "upload_file")({
    name: "sample.bin",
    contentBase64: Buffer.from([0, 255, 7]).toString("base64"),
    mimeType: "application/octet-stream",
  });
  assert.deepEqual(uploaded, Buffer.from([0, 255, 7]));
});

test("Drive domain sharing and comment resolution use supported API fields", async () => {
  const service = new DriveService();
  let permissionRequest: Record<string, unknown> | undefined;
  let replyRequest: Record<string, unknown> | undefined;
  setPrivate(service, "drive", {
    permissions: {
      create: async (params: Record<string, unknown>) => {
        permissionRequest = params;
        return { data: { id: "permission1" } };
      },
    },
    replies: {
      create: async (params: Record<string, unknown>) => {
        replyRequest = params;
        return { data: { id: "reply1" } };
      },
    },
  });

  await handler(service, "share_file")({
    fileId: "file1",
    type: "domain",
    domain: "example.com",
    role: "reader",
    allowFileDiscovery: false,
  });
  assert.deepEqual(permissionRequest?.requestBody, {
    type: "domain",
    role: "reader",
    domain: "example.com",
    allowFileDiscovery: false,
  });
  assert.equal(permissionRequest?.supportsAllDrives, true);

  await handler(service, "resolve_comment")({
    fileId: "file1",
    commentId: "comment1",
    resolved: false,
  });
  assert.deepEqual(replyRequest?.requestBody, { action: "reopen" });
});

test("Drive exposes shared drives, access proposals, approvals, and download operations", async () => {
  const service = new DriveService();
  let accessResolution: Record<string, unknown> | undefined;
  let approvalStart: Record<string, unknown> | undefined;
  setPrivate(service, "drive", {
    drives: {
      list: async () => ({ data: { drives: [{ id: "drive1", name: "Team" }] } }),
    },
    accessproposals: {
      resolve: async (params: Record<string, unknown>) => {
        accessResolution = params;
        return { data: undefined };
      },
    },
    approvals: {
      start: async (params: Record<string, unknown>) => {
        approvalStart = params;
        return { data: { approvalId: "approval1", status: "IN_PROGRESS" } };
      },
    },
    files: {
      download: async () => ({ data: { name: "operations/download1", done: false } }),
    },
  });

  assert.match(
    responseText(await handler(service, "list_shared_drives")({})),
    /drive1/,
  );
  await handler(service, "resolve_access_proposal")({
    fileId: "file1",
    proposalId: "proposal1",
    action: "ACCEPT",
    roles: ["reader"],
  });
  assert.deepEqual(accessResolution?.requestBody, {
    action: "ACCEPT",
    role: ["reader"],
    sendNotification: true,
    view: undefined,
  });

  await handler(service, "start_approval")({
    fileId: "file1",
    reviewerEmails: ["reviewer@example.com"],
  });
  assert.deepEqual(
    (approvalStart?.requestBody as { reviewerEmails?: string[] }).reviewerEmails,
    ["reviewer@example.com"],
  );
  assert.match(
    responseText(
      await handler(service, "request_file_download")({ fileId: "file1" }),
    ),
    /operations\/download1/,
  );
});
