import assert from "node:assert/strict";
import test from "node:test";
import { Ajv } from "ajv";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { CalendarService } from "../services/calendar.js";
import { SheetsService } from "../services/sheets.js";

function handlerFor(
  service: SheetsService | CalendarService,
  name: string,
) {
  const definition = service.getToolDefinitions().find(({ tool }) => tool.name === name);
  assert.ok(definition, "missing tool " + name);
  return definition.handler;
}

test("Sheets and Calendar tool contracts are valid MCP tools and JSON Schemas", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const definitions = [
    ...new SheetsService().getToolDefinitions(),
    ...new CalendarService().getToolDefinitions(),
  ];
  for (const { tool } of definitions) {
    assert.equal(ToolSchema.safeParse(tool).success, true, tool.name + " is not a valid MCP tool");
    assert.doesNotThrow(() => ajv.compile(tool.inputSchema), tool.name + " has invalid JSON Schema");
  }
});

test("Sheets exposes dedicated modern value, table, chip, and governance tools", () => {
  const names = new Set(
    new SheetsService().getToolDefinitions().map(({ tool }) => tool.name),
  );
  for (const name of [
    "batch_get_values",
    "batch_update_values",
    "batch_clear_values",
    "add_table",
    "update_table",
    "delete_table",
    "append_table_rows",
    "write_smart_chips",
    "add_protected_range",
    "delete_protected_range",
    "add_conditional_format_rule",
    "delete_conditional_format_rule",
    "set_data_validation",
    "auto_resize_dimensions",
  ]) {
    assert.ok(names.has(name), "missing Sheets tool " + name);
  }
});

test("whole-workbook Sheets reads quote tab names and use a bounded batch request", async () => {
  const service = new SheetsService();
  let requestedRanges: string[] | undefined;
  (service as unknown as { sheets: unknown }).sheets = {
    spreadsheets: {
      get: async () => ({
        data: {
          properties: { title: "Book" },
          sheets: [{ properties: { title: "O'Brien" } }],
        },
      }),
      values: {
        batchGet: async (params: { ranges: string[] }) => {
          requestedRanges = params.ranges;
          return { data: { valueRanges: [{ range: params.ranges[0], values: [[1]] }] } };
        },
      },
    },
  };

  await handlerFor(service, "read_spreadsheet")({
    spreadsheetId: "spreadsheet",
    maxRows: 2,
  });
  assert.deepEqual(requestedRanges, ["'O''Brien'!1:2"]);
});

test("cross-spreadsheet duplication does not create a local duplicate and renames the copy", async () => {
  const service = new SheetsService();
  const batchTargets: string[] = [];
  let copies = 0;
  (service as unknown as { sheets: unknown }).sheets = {
    spreadsheets: {
      sheets: {
        copyTo: async () => {
          copies++;
          return { data: { sheetId: 77, title: "Copy of Source" } };
        },
      },
      batchUpdate: async (params: { spreadsheetId: string }) => {
        batchTargets.push(params.spreadsheetId);
        return { data: {} };
      },
    },
  };

  await handlerFor(service, "duplicate_sheet")({
    spreadsheetId: "source",
    sheetId: 4,
    destinationSpreadsheetId: "destination",
    newName: "Renamed",
  });
  assert.equal(copies, 1);
  assert.deepEqual(batchTargets, ["destination"]);
});

test("Calendar lists are paginated without a hidden upper time bound", async () => {
  const service = new CalendarService();
  let params: Record<string, unknown> | undefined;
  (service as unknown as { cal: unknown }).cal = {
    events: {
      list: async (input: Record<string, unknown>) => {
        params = input;
        return { data: { items: [], nextPageToken: "next" } };
      },
    },
  };

  await handlerFor(service, "list_events")({
    calendarId: "primary",
    pageToken: "page",
  });
  assert.equal(params?.pageToken, "page");
  assert.equal(typeof params?.timeMin, "string");
  assert.equal(params?.timeMax, undefined);
});

test("Calendar RSVP uses an ETag precondition to avoid overwriting concurrent attendee changes", async () => {
  const service = new CalendarService();
  let requestOptions: { headers?: Record<string, string> } | undefined;
  (service as unknown as { cal: unknown }).cal = {
    events: {
      get: async () => ({
        data: {
          etag: '"etag-1"',
          summary: "Review",
          attendees: [{ email: "me@example.com", self: true, responseStatus: "needsAction" }],
        },
      }),
      patch: async (_params: unknown, options: { headers?: Record<string, string> }) => {
        requestOptions = options;
        return { data: {} };
      },
    },
  };

  await handlerFor(service, "respond_to_event")({
    eventId: "event",
    response: "accepted",
  });
  assert.equal(requestOptions?.headers?.["If-Match"], '"etag-1"');
});

test("Calendar exposes live colors, calendar metadata, and free-slot suggestions", () => {
  const names = new Set(
    new CalendarService().getToolDefinitions().map(({ tool }) => tool.name),
  );
  assert.ok(names.has("get_calendar"));
  assert.ok(names.has("update_calendar_labels"));
  assert.ok(names.has("list_calendar_colors"));
  assert.ok(names.has("suggest_time"));
});

test("Calendar forwards the Workspace-organization filter despite generated-type lag", async () => {
  const service = new CalendarService();
  let params: Record<string, unknown> | undefined;
  (service as unknown as { cal: unknown }).cal = {
    calendarList: {
      list: async (input: Record<string, unknown>) => {
        params = input;
        return { data: { items: [] } };
      },
    },
  };
  await handlerFor(service, "list_calendars")({ showOwnOrganizationOnly: true });
  assert.equal(params?.showOwnOrganizationOnly, true);
});

test("Calendar event labels opt into eventLabelVersion 1", async () => {
  const service = new CalendarService();
  let params: Record<string, unknown> | undefined;
  (service as unknown as { cal: unknown }).cal = {
    events: {
      insert: async (input: Record<string, unknown>) => {
        params = input;
        return { data: { id: "event", summary: "Labeled" } };
      },
    },
  };
  const eventLabelId = "22222222-3333-4444-5555-666666666666";
  await handlerFor(service, "create_event")({
    summary: "Labeled",
    startDateTime: "2026-07-27T10:00:00Z",
    endDateTime: "2026-07-27T11:00:00Z",
    eventLabelId,
  });
  assert.equal(params?.eventLabelVersion, 1);
  assert.equal(
    (params?.requestBody as { eventLabelId?: string }).eventLabelId,
    eventLabelId,
  );
});

test("Calendar label updates replace the documented labelProperties list", async () => {
  const service = new CalendarService();
  let body: Record<string, unknown> | undefined;
  (service as unknown as { cal: unknown }).cal = {
    calendars: {
      patch: async (params: { requestBody: Record<string, unknown> }) => {
        body = params.requestBody;
        return { data: params.requestBody };
      },
    },
  };
  await handlerFor(service, "update_calendar_labels")({
    labels: [{
      id: "22222222-3333-4444-5555-666666666666",
      backgroundColor: "#8e24aa",
      name: "Design Work",
    }],
  });
  assert.deepEqual(body, {
    labelProperties: {
      eventLabels: [{
        id: "22222222-3333-4444-5555-666666666666",
        backgroundColor: "#8e24aa",
        name: "Design Work",
      }],
    },
  });
});
