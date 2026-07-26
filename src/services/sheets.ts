import { google, type sheets_v4, type drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Service, ToolDefinition } from "../types.js";
import {
  requireString,
  requireNumber,
  optionalString,
  optionalNumber,
  optionalBoolean,
  textResponse,
  MAX_SPREADSHEET_ROWS,
  MAX_BATCH_REQUESTS,
} from "../utils.js";

// ── Helpers ──────────────────────────────────────────────────

type CellValue = string | number | boolean | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireInteger(
  args: Record<string, unknown>,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = requireNumber(args, field);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      "'" + field + "' must be an integer between " + minimum + " and " + maximum,
    );
  }
  return value;
}

function optionalInteger(
  args: Record<string, unknown>,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const value = optionalNumber(args, field);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      "'" + field + "' must be an integer between " + minimum + " and " + maximum,
    );
  }
  return value;
}

function requireStringArray(
  args: Record<string, unknown>,
  field: string,
  allowEmpty = false,
): string[] {
  const value = args[field];
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new Error(
      "'" + field + "' must be " + (allowEmpty ? "an" : "a non-empty") +
        " array of non-empty strings",
    );
  }
  return value as string[];
}

function requireObjectArray(
  args: Record<string, unknown>,
  field: string,
): Record<string, unknown>[] {
  const value = args[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => !isRecord(item))
  ) {
    throw new Error("'" + field + "' must be a non-empty array of objects");
  }
  return value as Record<string, unknown>[];
}

function requireValues(
  args: Record<string, unknown>,
  field = "values",
): CellValue[][] {
  const value = args[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("'" + field + "' must be a non-empty 2D array");
  }
  for (const row of value) {
    if (!Array.isArray(row)) {
      throw new Error("'" + field + "' must be a 2D array");
    }
    for (const cell of row) {
      if (
        cell !== null &&
        typeof cell !== "string" &&
        typeof cell !== "boolean" &&
        (typeof cell !== "number" || !Number.isFinite(cell))
      ) {
        throw new Error(
          "'" + field + "' cells must be strings, finite numbers, booleans, or null",
        );
      }
    }
  }
  return value as CellValue[][];
}

function requireEnum<T extends string>(
  args: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const value = optionalString(args, field);
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === undefined || !allowed.includes(value as T)) {
    throw new Error("'" + field + "' must be one of: " + allowed.join(", "));
  }
  return value as T;
}

function quoteSheetName(name: string): string {
  return "'" + name.replace(/'/g, "''") + "'";
}

function colToIndex(col: string): number {
  let idx = 0;
  for (const c of col.toUpperCase()) idx = idx * 26 + (c.charCodeAt(0) - 64);
  return idx - 1;
}

function parseGridRange(cellRange: string): {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
} {
  const m = cellRange.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!m) throw new Error(`Invalid cell range: ${cellRange}`);
  const startRow = parseInt(m[2], 10) - 1;
  const startCol = colToIndex(m[1]);
  const endRow = m[4] ? parseInt(m[4], 10) : startRow + 1;
  const endCol = m[3] ? colToIndex(m[3]) + 1 : startCol + 1;
  if (startRow < 0 || startCol < 0 || endRow <= startRow || endCol <= startCol) {
    throw new Error("Invalid or reversed cell range: " + cellRange);
  }
  return { startRow, startCol, endRow, endCol };
}

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  if (!/^#?[0-9a-f]{6}$/i.test(hex)) {
    throw new Error("Color must be a 6-digit hex value, for example #4285F4");
  }
  const h = hex.replace("#", "");
  return {
    red: parseInt(h.substring(0, 2), 16) / 255,
    green: parseInt(h.substring(2, 4), 16) / 255,
    blue: parseInt(h.substring(4, 6), 16) / 255,
  };
}


// ── Service ──────────────────────────────────────────────────

export class SheetsService implements Service {
  private sheets!: sheets_v4.Sheets;
  private drive!: drive_v3.Drive;

  initialize(auth: OAuth2Client): void {
    this.sheets = google.sheets({ version: "v4", auth });
    this.drive = google.drive({ version: "v3", auth });
  }

  private async getSheetId(
    spreadsheetId: string,
    sheetName: string,
  ): Promise<number> {
    const ss = await this.sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties(sheetId,title,sheetType,gridProperties)",
    });
    const sheet = (ss.data.sheets || []).find(
      (s) => s.properties?.title === sheetName,
    );
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
    return sheet.properties!.sheetId!;
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      // ── Read ────────────────────────────────────────────
      {
        tool: {
          name: "read_spreadsheet",
          description:
            "Read data from a Google Sheet with sheet names and cell values.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              range: {
                type: "string",
                description:
                  "Optional range in A1 notation (e.g., 'Sheet1!A1:D10'). If not provided, reads all sheets.",
              },
              maxRows: {
                type: "number",
                minimum: 1,
                maximum: 10000,
                description: "Maximum rows per returned range (default: 100)",
              },
              startRow: {
                type: "number",
                minimum: 1,
                description: "First row to read when range is omitted (default: 1)",
              },
              valueRenderOption: {
                type: "string",
                enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"],
              },
              dateTimeRenderOption: {
                type: "string",
                enum: ["SERIAL_NUMBER", "FORMATTED_STRING"],
              },
              majorDimension: {
                type: "string",
                enum: ["ROWS", "COLUMNS"],
              },
              outputFormat: {
                type: "string",
                enum: ["TSV", "JSON"],
                description: "Return tab-separated text (default) or lossless JSON",
              },
            },
            required: ["spreadsheetId"],
          },
        },
        handler: (a) => this.readSpreadsheet(a),
      },
      {
        tool: {
          name: "get_spreadsheet_info",
          description:
            "Get spreadsheet metadata: title, sheets list with IDs, row/column counts, and named ranges.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
            },
            required: ["spreadsheetId"],
          },
        },
        handler: (a) => this.getSpreadsheetInfo(a),
      },
      // ── Write ───────────────────────────────────────────
      {
        tool: {
          name: "write_cells",
          description:
            "Write values to a range in a Google Sheet. Supports formulas (e.g., '=SUM(A1:A10)').",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              range: {
                type: "string",
                description: "Range in A1 notation (e.g., 'Sheet1!A1:C3')",
              },
              values: {
                type: "array",
                minItems: 1,
                maxItems: MAX_BATCH_REQUESTS,
                items: {
                  type: "array",
                  items: { type: ["string", "number", "boolean", "null"] },
                },
                description:
                  "2D array of values. Each inner array is a row. Example: [[\"Name\",\"Age\"],[\"Alice\",30]]",
              },
              valueInputOption: {
                type: "string",
                enum: ["RAW", "USER_ENTERED"],
                description: "How values are interpreted (default: USER_ENTERED)",
              },
              majorDimension: { type: "string", enum: ["ROWS", "COLUMNS"] },
              includeValuesInResponse: { type: "boolean" },
            },
            required: ["spreadsheetId", "range", "values"],
          },
        },
        handler: (a) => this.writeCells(a),
      },
      {
        tool: {
          name: "append_rows",
          description:
            "Append rows after the logical table detected by the supplied range.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              range: {
                type: "string",
                description:
                  "Sheet and column range to detect table, e.g., 'Sheet1!A:D' or 'Sheet1'",
              },
              values: {
                type: "array",
                minItems: 1,
                items: {
                  type: "array",
                  items: { type: ["string", "number", "boolean", "null"] },
                },
                description: "2D array of rows to append",
              },
              valueInputOption: {
                type: "string",
                enum: ["RAW", "USER_ENTERED"],
              },
              insertDataOption: {
                type: "string",
                enum: ["OVERWRITE", "INSERT_ROWS"],
              },
              includeValuesInResponse: { type: "boolean" },
            },
            required: ["spreadsheetId", "range", "values"],
          },
        },
        handler: (a) => this.appendRows(a),
      },
      {
        tool: {
          name: "clear_cells",
          description: "Clear all values in a range (keeps formatting).",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              range: {
                type: "string",
                description: "Range in A1 notation to clear (e.g., 'Sheet1!A1:D10')",
              },
            },
            required: ["spreadsheetId", "range"],
          },
        },
        handler: (a) => this.clearCells(a),
      },
      // ── Spreadsheet / Sheet management ──────────────────
      {
        tool: {
          name: "create_spreadsheet",
          description: "Create a new Google Sheets spreadsheet.",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Title of the new spreadsheet" },
              sheetNames: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional list of sheet/tab names to create (default: one sheet called 'Sheet1')",
              },
              folderId: {
                type: "string",
                description: "Optional Google Drive folder ID to create the spreadsheet in",
              },
            },
            required: ["title"],
          },
        },
        handler: (a) => this.createSpreadsheet(a),
      },
      {
        tool: {
          name: "add_sheet",
          description: "Add a new sheet (tab) to an existing spreadsheet.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              title: { type: "string", description: "Name of the new sheet" },
            },
            required: ["spreadsheetId", "title"],
          },
        },
        handler: (a) => this.addSheet(a),
      },
      {
        tool: {
          name: "delete_sheet",
          description: "Delete a sheet (tab) from a spreadsheet by its numeric sheet ID.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              sheetId: {
                type: "number",
                description:
                  "Numeric ID of the sheet to delete (use get_spreadsheet_info to find it)",
              },
            },
            required: ["spreadsheetId", "sheetId"],
          },
        },
        handler: (a) => this.deleteSheet(a),
      },
      // ── Structural edits ────────────────────────────────
      {
        tool: {
          name: "insert_rows_columns",
          description: "Insert empty rows or columns into a sheet.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              sheetId: { type: "number", description: "Numeric sheet ID" },
              dimension: {
                type: "string",
                enum: ["ROWS", "COLUMNS"],
                description: "Whether to insert rows or columns",
              },
              startIndex: {
                type: "number",
                description: "0-based index where to start inserting",
              },
              endIndex: {
                type: "number",
                description: "0-based index where to stop (exclusive). Inserts (endIndex - startIndex) rows/columns.",
              },
            },
            required: ["spreadsheetId", "sheetId", "dimension", "startIndex", "endIndex"],
          },
        },
        handler: (a) => this.insertRowsColumns(a),
      },
      {
        tool: {
          name: "delete_rows_columns",
          description: "Delete rows or columns from a sheet.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              sheetId: { type: "number", description: "Numeric sheet ID" },
              dimension: {
                type: "string",
                enum: ["ROWS", "COLUMNS"],
                description: "Whether to delete rows or columns",
              },
              startIndex: { type: "number", description: "0-based start index (inclusive)" },
              endIndex: { type: "number", description: "0-based end index (exclusive)" },
            },
            required: ["spreadsheetId", "sheetId", "dimension", "startIndex", "endIndex"],
          },
        },
        handler: (a) => this.deleteRowsColumns(a),
      },
      // ── Formatting ──────────────────────────────────────
      {
        tool: {
          name: "format_cells",
          description:
            "Apply formatting to a cell range: bold, italic, font size, colors, alignment, number format, borders.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              sheetName: { type: "string", description: "Name of the sheet (e.g., 'Sheet1')" },
              cellRange: {
                type: "string",
                description: "Cell range without sheet name (e.g., 'A1:D1')",
              },
              bold: { type: "boolean", description: "Bold text" },
              italic: { type: "boolean", description: "Italic text" },
              fontSize: { type: "number", description: "Font size in points" },
              fontColor: { type: "string", description: "Text color as hex (e.g., '#FF0000')" },
              backgroundColor: {
                type: "string",
                description: "Background color as hex (e.g., '#4285F4')",
              },
              horizontalAlignment: {
                type: "string",
                enum: ["LEFT", "CENTER", "RIGHT"],
                description: "Horizontal alignment",
              },
              numberFormat: {
                type: "string",
                description:
                  "Number format pattern (e.g., '#,##0.00', '0%', 'yyyy-mm-dd', '$#,##0')",
              },
              numberFormatType: {
                type: "string",
                enum: [
                  "TEXT", "NUMBER", "PERCENT", "CURRENCY", "DATE", "TIME",
                  "DATE_TIME", "SCIENTIFIC",
                ],
                description: "Semantic type for numberFormat (default: NUMBER)",
              },
              verticalAlignment: {
                type: "string",
                enum: ["TOP", "MIDDLE", "BOTTOM"],
              },
              wrapStrategy: {
                type: "string",
                enum: ["OVERFLOW_CELL", "CLIP", "WRAP"],
                description: "Text wrapping strategy",
              },
              borders: {
                type: "object",
                description:
                  "Borders keyed by top, bottom, left, right, innerHorizontal, or innerVertical",
                additionalProperties: {
                  type: "object",
                  properties: {
                    style: {
                      type: "string",
                      enum: [
                        "DOTTED", "DASHED", "SOLID", "SOLID_MEDIUM",
                        "SOLID_THICK", "DOUBLE", "NONE",
                      ],
                    },
                    color: { type: "string" },
                  },
                  required: ["style"],
                },
              },
            },
            required: ["spreadsheetId", "sheetName", "cellRange"],
          },
        },
        handler: (a) => this.formatCells(a),
      },
      {
        tool: {
          name: "merge_cells",
          description: "Merge a range of cells.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              sheetName: { type: "string", description: "Name of the sheet" },
              cellRange: { type: "string", description: "Range to merge (e.g., 'A1:C1')" },
              mergeType: {
                type: "string",
                enum: ["MERGE_ALL", "MERGE_COLUMNS", "MERGE_ROWS"],
                description: "Merge type (default: MERGE_ALL)",
              },
            },
            required: ["spreadsheetId", "sheetName", "cellRange"],
          },
        },
        handler: (a) => this.mergeCells(a),
      },
      {
        tool: {
          name: "set_column_width",
          description: "Set the width of one or more columns in pixels.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              sheetId: { type: "number", description: "Numeric sheet ID" },
              startColumn: {
                type: "number",
                description: "0-based start column index (A=0, B=1, ...)",
              },
              endColumn: {
                type: "number",
                description: "0-based end column index (exclusive)",
              },
              width: { type: "number", description: "Width in pixels" },
            },
            required: ["spreadsheetId", "sheetId", "startColumn", "endColumn", "width"],
          },
        },
        handler: (a) => this.setColumnWidth(a),
      },
      {
        tool: {
          name: "freeze_rows_columns",
          description: "Freeze (pin) header rows and/or columns so they stay visible when scrolling.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              sheetId: { type: "number", description: "Numeric sheet ID" },
              frozenRowCount: { type: "number", description: "Number of rows to freeze (0 to unfreeze)" },
              frozenColumnCount: {
                type: "number",
                description: "Number of columns to freeze (0 to unfreeze)",
              },
            },
            required: ["spreadsheetId", "sheetId"],
          },
        },
        handler: (a) => this.freezeRowsColumns(a),
      },
      // ── Data operations ─────────────────────────────────
      {
        tool: {
          name: "sort_range",
          description: "Sort data in a range by one or more columns.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              sheetName: { type: "string", description: "Name of the sheet" },
              cellRange: { type: "string", description: "Range to sort (e.g., 'A2:D100')" },
              sortColumn: {
                type: "number",
                description: "Legacy absolute 0-based sheet column index to sort by",
              },
              ascending: {
                type: "boolean",
                description: "Sort ascending (true) or descending (false). Default: true",
              },
              sortSpecs: {
                type: "array",
                minItems: 1,
                description:
                  "Sort keys in priority order; columnIndex is an absolute 0-based sheet column index",
                items: {
                  type: "object",
                  properties: {
                    columnIndex: { type: "number", minimum: 0 },
                    ascending: { type: "boolean" },
                  },
                  required: ["columnIndex"],
                },
              },
            },
            required: ["spreadsheetId", "sheetName", "cellRange"],
          },
        },
        handler: (a) => this.sortRange(a),
      },
      {
        tool: {
          name: "find_replace_in_sheet",
          description: "Find and replace text across a sheet or specific range.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              find: { type: "string", description: "Text to find" },
              replacement: { type: "string", description: "Text to replace with" },
              sheetId: {
                type: "number",
                description: "Optional numeric sheet ID to limit search to one sheet",
              },
              sheetName: {
                type: "string",
                description: "Optional sheet name used with cellRange",
              },
              cellRange: {
                type: "string",
                description: "Optional range without a sheet name, e.g. A1:D100",
              },
              matchCase: { type: "boolean", description: "Case-sensitive search (default: false)" },
              matchEntireCell: {
                type: "boolean",
                description: "Only match if entire cell matches (default: false)",
              },
              searchByRegex: { type: "boolean", description: "Interpret find as RE2 regex" },
              includeFormulas: { type: "boolean", description: "Search formula text too" },
            },
            required: ["spreadsheetId", "find", "replacement"],
          },
        },
        handler: (a) => this.findReplace(a),
      },
      // ── Charts ──────────────────────────────────────────
      {
        tool: {
          name: "create_chart",
          description:
            "Create an embedded chart from spreadsheet data. The first column of the data range is used as the X axis, remaining columns become data series. The first row is used as headers/series labels.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              sheetName: { type: "string", description: "Name of the sheet containing the data" },
              dataRange: {
                type: "string",
                description:
                  "Data range in A1 notation (e.g., 'A1:C10'). First column = X axis, other columns = series.",
              },
              chartType: {
                type: "string",
                enum: ["BAR", "LINE", "AREA", "COLUMN", "SCATTER", "PIE"],
                description: "Type of chart",
              },
              title: { type: "string", description: "Chart title" },
            },
            required: ["spreadsheetId", "sheetName", "dataRange", "chartType"],
          },
        },
        handler: (a) => this.createChart(a),
      },
      // ── Raw batch update ────────────────────────────────
      {
        tool: {
          name: "batch_update_spreadsheet",
          description:
            "Execute multiple raw batchUpdate operations atomically on a Google Sheet. For advanced users who need full Sheets API access (conditional formatting, data validation, protected ranges, banding, etc.).",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              requests: {
                type: "array",
                minItems: 1,
                items: { type: "object" },
                description:
                  "Array of Google Sheets API request objects (repeatCell, addConditionalFormatRule, setDataValidation, updateBorders, addChart, etc.)",
              },
              includeSpreadsheetInResponse: { type: "boolean" },
              responseRanges: {
                type: "array",
                items: { type: "string" },
              },
              responseIncludeGridData: { type: "boolean" },
            },
            required: ["spreadsheetId", "requests"],
          },
        },
        handler: (a) => this.batchUpdateSpreadsheet(a),
      },
      {
        tool: {
          name: "rename_sheet",
          description: "Rename a sheet (tab) in a spreadsheet.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              sheetId: { type: "number", description: "Numeric sheet ID" },
              newName: { type: "string", description: "New name for the sheet" },
            },
            required: ["spreadsheetId", "sheetId", "newName"],
          },
        },
        handler: (a) => this.renameSheet(a),
      },
      {
        tool: {
          name: "duplicate_sheet",
          description: "Duplicate a sheet (tab) within the same spreadsheet or to another spreadsheet.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              sheetId: { type: "number", description: "Numeric sheet ID to duplicate" },
              newName: { type: "string", description: "Name for the duplicated sheet" },
              destinationSpreadsheetId: {
                type: "string",
                description: "Optional: ID of another spreadsheet to copy to",
              },
              insertSheetIndex: {
                type: "number",
                minimum: 0,
                description: "Optional insertion index for same-spreadsheet duplication",
              },
            },
            required: ["spreadsheetId", "sheetId"],
          },
        },
        handler: (a) => this.duplicateSheet(a),
      },
      {
        tool: {
          name: "batch_get_values",
          description: "Read multiple A1 ranges in one Sheets API request.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string" },
              ranges: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
              },
              majorDimension: { type: "string", enum: ["ROWS", "COLUMNS"] },
              valueRenderOption: {
                type: "string",
                enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"],
              },
              dateTimeRenderOption: {
                type: "string",
                enum: ["SERIAL_NUMBER", "FORMATTED_STRING"],
              },
            },
            required: ["spreadsheetId", "ranges"],
          },
        },
        handler: (a) => this.batchGetValues(a),
      },
      {
        tool: {
          name: "batch_update_values",
          description: "Write values to multiple A1 ranges in one request.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string" },
              data: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  properties: {
                    range: { type: "string" },
                    majorDimension: {
                      type: "string",
                      enum: ["ROWS", "COLUMNS"],
                    },
                    values: {
                      type: "array",
                      minItems: 1,
                      items: {
                        type: "array",
                        items: { type: ["string", "number", "boolean", "null"] },
                      },
                    },
                  },
                  required: ["range", "values"],
                },
              },
              valueInputOption: {
                type: "string",
                enum: ["RAW", "USER_ENTERED"],
              },
              includeValuesInResponse: { type: "boolean" },
            },
            required: ["spreadsheetId", "data"],
          },
        },
        handler: (a) => this.batchUpdateValues(a),
      },
      {
        tool: {
          name: "batch_clear_values",
          description: "Clear values (while preserving formatting) in multiple ranges.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string" },
              ranges: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
              },
            },
            required: ["spreadsheetId", "ranges"],
          },
        },
        handler: (a) => this.batchClearValues(a),
      },
      {
        tool: {
          name: "add_table",
          description: "Create a native Google Sheets table over a grid range.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string" },
              sheetName: { type: "string" },
              cellRange: { type: "string", description: "Range without sheet name" },
              name: { type: "string" },
              columnProperties: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    columnIndex: { type: "number", minimum: 0 },
                    columnName: { type: "string" },
                    columnType: {
                      type: "string",
                      enum: [
                        "DOUBLE", "CURRENCY", "PERCENT", "DATE", "TIME",
                        "DATE_TIME", "TEXT", "BOOLEAN", "DROPDOWN",
                        "FILES_CHIP", "PEOPLE_CHIP", "FINANCE_CHIP",
                        "PLACE_CHIP", "RATINGS_CHIP",
                      ],
                    },
                  },
                },
              },
            },
            required: ["spreadsheetId", "sheetName", "cellRange"],
          },
        },
        handler: (a) => this.addTable(a),
      },
      {
        tool: {
          name: "update_table",
          description: "Update a native Sheets table using a field mask.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string" },
              table: {
                type: "object",
                description: "Sheets Table object including tableId",
              },
              fields: {
                type: "string",
                description: "Field mask, for example name or columnProperties",
              },
            },
            required: ["spreadsheetId", "table", "fields"],
          },
        },
        handler: (a) => this.updateTable(a),
      },
      {
        tool: {
          name: "delete_table",
          description: "Delete a native Sheets table without deleting its cell values.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string" },
              tableId: { type: "string" },
            },
            required: ["spreadsheetId", "tableId"],
          },
        },
        handler: (a) => this.deleteTable(a),
      },
      {
        tool: {
          name: "append_table_rows",
          description: "Append rows to a native Sheets table by table ID.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string" },
              tableId: { type: "string" },
              values: {
                type: "array",
                minItems: 1,
                items: {
                  type: "array",
                  items: { type: ["string", "number", "boolean", "null"] },
                },
              },
              parseFormulas: {
                type: "boolean",
                description: "Treat strings beginning with = as formulas",
              },
            },
            required: ["spreadsheetId", "tableId", "values"],
          },
        },
        handler: (a) => this.appendTableRows(a),
      },
      {
        tool: {
          name: "write_smart_chips",
          description:
            "Write person or Drive-file smart chips. Each chip replaces an @ character at its UTF-16 startIndex.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string" },
              sheetName: { type: "string" },
              cells: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  properties: {
                    cell: { type: "string", description: "Single A1 cell, e.g. B2" },
                    text: { type: "string", description: "Text containing @ placeholders" },
                    chips: {
                      type: "array",
                      minItems: 1,
                      items: {
                        type: "object",
                        properties: {
                          startIndex: { type: "number", minimum: 0 },
                          type: { type: "string", enum: ["PERSON", "DRIVE_FILE"] },
                          email: { type: "string" },
                          uri: { type: "string" },
                          displayFormat: {
                            type: "string",
                            enum: ["DEFAULT", "LAST_NAME_COMMA_FIRST_NAME", "EMAIL"],
                          },
                        },
                        required: ["startIndex", "type"],
                      },
                    },
                  },
                  required: ["cell", "text", "chips"],
                },
              },
            },
            required: ["spreadsheetId", "sheetName", "cells"],
          },
        },
        handler: (a) => this.writeSmartChips(a),
      },
      {
        tool: {
          name: "add_protected_range",
          description: "Protect a grid range, optionally as warning-only or with named editors.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string" },
              sheetName: { type: "string" },
              cellRange: { type: "string" },
              description: { type: "string" },
              warningOnly: { type: "boolean" },
              editors: {
                type: "object",
                properties: {
                  users: { type: "array", items: { type: "string" } },
                  groups: { type: "array", items: { type: "string" } },
                  domainUsersCanEdit: { type: "boolean" },
                },
              },
            },
            required: ["spreadsheetId", "sheetName", "cellRange"],
          },
        },
        handler: (a) => this.addProtectedRange(a),
      },
      {
        tool: {
          name: "delete_protected_range",
          description: "Remove a protected range by protectedRangeId.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string" },
              protectedRangeId: { type: "number", minimum: 0 },
            },
            required: ["spreadsheetId", "protectedRangeId"],
          },
        },
        handler: (a) => this.deleteProtectedRange(a),
      },
      {
        tool: {
          name: "add_conditional_format_rule",
          description: "Add a Google Sheets conditional-format rule.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string" },
              rule: {
                type: "object",
                description: "Sheets ConditionalFormatRule object",
              },
              index: { type: "number", minimum: 0 },
            },
            required: ["spreadsheetId", "rule"],
          },
        },
        handler: (a) => this.addConditionalFormatRule(a),
      },
      {
        tool: {
          name: "delete_conditional_format_rule",
          description: "Delete a conditional-format rule by sheet ID and rule index.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string" },
              sheetId: { type: "number", minimum: 0 },
              index: { type: "number", minimum: 0 },
            },
            required: ["spreadsheetId", "sheetId", "index"],
          },
        },
        handler: (a) => this.deleteConditionalFormatRule(a),
      },
      {
        tool: {
          name: "set_data_validation",
          description: "Set or clear data validation for a grid range.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string" },
              sheetName: { type: "string" },
              cellRange: { type: "string" },
              clear: { type: "boolean" },
              conditionType: {
                type: "string",
                description: "BooleanCondition type, e.g. ONE_OF_LIST or NUMBER_GREATER",
              },
              conditionValues: {
                type: "array",
                items: { type: "string" },
              },
              strict: { type: "boolean" },
              showCustomUi: { type: "boolean" },
              inputMessage: { type: "string" },
            },
            required: ["spreadsheetId", "sheetName", "cellRange"],
          },
        },
        handler: (a) => this.setDataValidation(a),
      },
      {
        tool: {
          name: "auto_resize_dimensions",
          description: "Automatically resize a span of rows or columns to fit its contents.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string" },
              sheetId: { type: "number", minimum: 0 },
              dimension: { type: "string", enum: ["ROWS", "COLUMNS"] },
              startIndex: { type: "number", minimum: 0 },
              endIndex: { type: "number", minimum: 1 },
            },
            required: [
              "spreadsheetId", "sheetId", "dimension", "startIndex", "endIndex",
            ],
          },
        },
        handler: (a) => this.autoResizeDimensions(a),
      },
      {
        tool: {
          name: "unmerge_cells",
          description: "Unmerge previously merged cells in a range.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string", description: "The ID of the Google Sheet" },
              sheetName: { type: "string", description: "Name of the sheet" },
              cellRange: { type: "string", description: "Range to unmerge (e.g., 'A1:C1')" },
            },
            required: ["spreadsheetId", "sheetName", "cellRange"],
          },
        },
        handler: (a) => this.unmergeCells(a),
      },
    ];
  }

  // ── Read handlers ───────────────────────────────────────

  private async readSpreadsheet(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const range = optionalString(args, "range");
    const maxRows = optionalInteger(args, "maxRows", 1, 10000) ?? MAX_SPREADSHEET_ROWS;
    const startRow = optionalInteger(args, "startRow", 1) ?? 1;
    const valueRenderOption = requireEnum(
      args,
      "valueRenderOption",
      ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"] as const,
      "FORMATTED_VALUE",
    );
    const dateTimeRenderOption = requireEnum(
      args,
      "dateTimeRenderOption",
      ["SERIAL_NUMBER", "FORMATTED_STRING"] as const,
      "SERIAL_NUMBER",
    );
    const majorDimension = requireEnum(
      args,
      "majorDimension",
      ["ROWS", "COLUMNS"] as const,
      "ROWS",
    );
    const outputFormat = requireEnum(
      args,
      "outputFormat",
      ["TSV", "JSON"] as const,
      "TSV",
    );

    const spreadsheet = await this.sheets.spreadsheets.get({
      spreadsheetId,
      fields:
        "properties(title,locale,timeZone),spreadsheetUrl,sheets.properties(sheetId,title,sheetType,gridProperties)",
    });
    const title = spreadsheet.data.properties?.title;
    const render = (values: unknown[][]): string =>
      values.map((row) => row.map((cell) => String(cell ?? "")).join("\t")).join("\n");

    if (range) {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
        majorDimension,
        valueRenderOption,
        dateTimeRenderOption,
      });
      const allValues = response.data.values || [];
      const values =
        majorDimension === "ROWS" ? allValues.slice(0, maxRows) : allValues;
      const result = {
        spreadsheetId,
        title,
        range: response.data.range || range,
        majorDimension,
        values,
        truncated: majorDimension === "ROWS" && allValues.length > maxRows,
      };
      if (outputFormat === "JSON") {
        return textResponse(JSON.stringify(result, null, 2));
      }
      return textResponse(
        "Spreadsheet: " + title + "\nRange: " + result.range + "\n\n" +
          (values.length ? render(values) : "(empty)") +
          (result.truncated ? "\n... output truncated at " + maxRows + " rows" : ""),
      );
    }

    const sheetTitles = (spreadsheet.data.sheets || [])
      .map((sheet) => sheet.properties?.title)
      .filter((sheetTitle): sheetTitle is string => Boolean(sheetTitle));
    const endRow = startRow + maxRows - 1;
    const ranges = sheetTitles.map(
      (sheetTitle) => quoteSheetName(sheetTitle) + "!" + startRow + ":" + endRow,
    );
    const response = ranges.length
      ? await this.sheets.spreadsheets.values.batchGet({
          spreadsheetId,
          ranges,
          majorDimension,
          valueRenderOption,
          dateTimeRenderOption,
        })
      : undefined;
    const results = sheetTitles.map((sheetTitle, index) => {
      const valueRange = response?.data.valueRanges?.[index];
      const values = valueRange?.values || [];
      return {
        sheet: sheetTitle,
        range: valueRange?.range || ranges[index],
        values,
        nextStartRow: values.length === maxRows ? endRow + 1 : undefined,
      };
    });
    if (outputFormat === "JSON") {
      return textResponse(
        JSON.stringify({ spreadsheetId, title, startRow, maxRows, results }, null, 2),
      );
    }
    let output = "Spreadsheet: " + title + "\n";
    for (const result of results) {
      output += "\nSheet: " + result.sheet + "\n";
      output += result.values.length ? render(result.values) : "(empty)";
      if (result.nextStartRow) {
        output += "\n... use startRow=" + result.nextStartRow + " for the next page";
      }
      output += "\n";
    }
    return textResponse(output);
  }

  private async getSpreadsheetInfo(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");

    const ss = await this.sheets.spreadsheets.get({
      spreadsheetId,
      fields:
        "properties(title,locale,timeZone),spreadsheetUrl," +
        "sheets.properties(sheetId,title,index,sheetType,gridProperties)," +
        "namedRanges(namedRangeId,name,range)",
    });
    const title = ss.data.properties?.title;
    const sheets = (ss.data.sheets || []).map((s) => ({
      sheetId: s.properties?.sheetId,
      title: s.properties?.title,
      sheetType: s.properties?.sheetType,
      rowCount: s.properties?.gridProperties?.rowCount,
      columnCount: s.properties?.gridProperties?.columnCount,
      frozenRowCount: s.properties?.gridProperties?.frozenRowCount || 0,
      frozenColumnCount: s.properties?.gridProperties?.frozenColumnCount || 0,
    }));
    const namedRanges = (ss.data.namedRanges || []).map((nr) => ({
      namedRangeId: nr.namedRangeId,
      name: nr.name,
      range: nr.range,
    }));

    let output =
      `Spreadsheet: ${title}\nID: ${spreadsheetId}\nURL: ${ss.data.spreadsheetUrl}\n` +
      `Locale: ${ss.data.properties?.locale || "unknown"}\n` +
      `Time zone: ${ss.data.properties?.timeZone || "unknown"}\n\nSheets:\n`;
    for (const s of sheets) {
      output += `  - "${s.title}" (sheetId: ${s.sheetId}, type: ${s.sheetType}, ${s.rowCount} rows x ${s.columnCount} cols, frozen: ${s.frozenRowCount} rows / ${s.frozenColumnCount} cols)\n`;
    }
    if (namedRanges.length > 0) {
      output += `\nNamed Ranges:\n`;
      for (const nr of namedRanges) {
        output += `  - ${nr.name} (ID: ${nr.namedRangeId}): ${JSON.stringify(nr.range)}\n`;
      }
    }

    return textResponse(output);
  }

  // ── Write handlers ──────────────────────────────────────

  private async writeCells(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const range = requireString(args, "range");
    const values = requireValues(args);
    const valueInputOption = requireEnum(
      args,
      "valueInputOption",
      ["RAW", "USER_ENTERED"] as const,
      "USER_ENTERED",
    );
    const majorDimension = requireEnum(
      args,
      "majorDimension",
      ["ROWS", "COLUMNS"] as const,
      "ROWS",
    );
    const includeValuesInResponse = optionalBoolean(args, "includeValuesInResponse") ?? false;

    const response = await this.sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption,
      includeValuesInResponse,
      requestBody: { values, majorDimension },
    });

    return textResponse(
      JSON.stringify(
        {
          updatedRange: response.data.updatedRange,
          updatedRows: response.data.updatedRows,
          updatedColumns: response.data.updatedColumns,
          updatedCells: response.data.updatedCells,
          updatedData: response.data.updatedData,
        },
        null,
        2,
      ),
    );
  }

  private async appendRows(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const range = requireString(args, "range");
    const values = requireValues(args);
    const valueInputOption = requireEnum(
      args,
      "valueInputOption",
      ["RAW", "USER_ENTERED"] as const,
      "USER_ENTERED",
    );
    const insertDataOption = requireEnum(
      args,
      "insertDataOption",
      ["OVERWRITE", "INSERT_ROWS"] as const,
      "INSERT_ROWS",
    );
    const includeValuesInResponse = optionalBoolean(args, "includeValuesInResponse") ?? false;

    const response = await this.sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption,
      insertDataOption,
      includeValuesInResponse,
      requestBody: { values },
    });

    const updates = response.data.updates;
    return textResponse(
      JSON.stringify(
        {
          tableRange: response.data.tableRange,
          updatedRange: updates?.updatedRange,
          updatedRows: updates?.updatedRows,
          updatedColumns: updates?.updatedColumns,
          updatedCells: updates?.updatedCells,
          updatedData: updates?.updatedData,
        },
        null,
        2,
      ),
    );
  }

  private async clearCells(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const range = requireString(args, "range");

    const response = await this.sheets.spreadsheets.values.clear({
      spreadsheetId,
      range,
    });

    return textResponse(`Cleared range ${response.data.clearedRange || range}`);
  }

  // ── Spreadsheet / sheet management ──────────────────────

  private async createSpreadsheet(args: Record<string, unknown>) {
    const title = requireString(args, "title");
    const sheetNames =
      args.sheetNames === undefined
        ? undefined
        : requireStringArray(args, "sheetNames");
    const folderId = optionalString(args, "folderId");

    const sheets = sheetNames?.map((name, i) => ({
      properties: { title: name, index: i },
    }));

    const response = await this.sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: sheets || undefined,
      },
    });

    const ssId = response.data.spreadsheetId!;

    if (folderId) {
      try {
        await this.drive.files.update({
          fileId: ssId,
          addParents: folderId,
          removeParents: "root",
          supportsAllDrives: true,
          fields: "id, parents",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Spreadsheet ${ssId} was created, but moving it to folder ${folderId} failed: ${message}. ` +
            `Recover it at ${response.data.spreadsheetUrl}`,
        );
      }
    }

    return textResponse(
      `Spreadsheet created!\nTitle: ${title}\nID: ${ssId}\nURL: ${response.data.spreadsheetUrl}`,
    );
  }

  private async addSheet(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const title = requireString(args, "title");

    const response = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }],
      },
    });

    const newSheet = response.data.replies?.[0]?.addSheet?.properties;
    return textResponse(
      `Sheet added: "${newSheet?.title}" (sheetId: ${newSheet?.sheetId})`,
    );
  }

  private async deleteSheet(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetId = requireInteger(args, "sheetId");

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ deleteSheet: { sheetId } }],
      },
    });

    return textResponse(`Sheet ${sheetId} deleted.`);
  }

  // ── Structural edits ───────────────────────────────────

  private async insertRowsColumns(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetId = requireInteger(args, "sheetId");
    const dimension = requireEnum(args, "dimension", ["ROWS", "COLUMNS"] as const);
    const startIndex = requireInteger(args, "startIndex");
    const endIndex = requireInteger(args, "endIndex", 1);
    if (endIndex <= startIndex) throw new Error("'endIndex' must be greater than 'startIndex'");

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: { sheetId, dimension, startIndex, endIndex },
              inheritFromBefore: startIndex > 0,
            },
          },
        ],
      },
    });

    const count = endIndex - startIndex;
    return textResponse(
      `Inserted ${count} ${dimension.toLowerCase()} at index ${startIndex}.`,
    );
  }

  private async deleteRowsColumns(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetId = requireInteger(args, "sheetId");
    const dimension = requireEnum(args, "dimension", ["ROWS", "COLUMNS"] as const);
    const startIndex = requireInteger(args, "startIndex");
    const endIndex = requireInteger(args, "endIndex", 1);
    if (endIndex <= startIndex) throw new Error("'endIndex' must be greater than 'startIndex'");

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: { sheetId, dimension, startIndex, endIndex },
            },
          },
        ],
      },
    });

    const count = endIndex - startIndex;
    return textResponse(
      `Deleted ${count} ${dimension.toLowerCase()} from index ${startIndex}.`,
    );
  }

  // ── Formatting ─────────────────────────────────────────

  private async formatCells(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetName = requireString(args, "sheetName");
    const cellRange = requireString(args, "cellRange");
    const bold = optionalBoolean(args, "bold");
    const italic = optionalBoolean(args, "italic");
    const fontSize = optionalNumber(args, "fontSize");
    const fontColor = optionalString(args, "fontColor");
    const backgroundColor = optionalString(args, "backgroundColor");
    const horizontalAlignment = args.horizontalAlignment === undefined
      ? undefined
      : requireEnum(args, "horizontalAlignment", ["LEFT", "CENTER", "RIGHT"] as const);
    const verticalAlignment = args.verticalAlignment === undefined
      ? undefined
      : requireEnum(args, "verticalAlignment", ["TOP", "MIDDLE", "BOTTOM"] as const);
    const numberFormat = optionalString(args, "numberFormat");
    const numberFormatType = requireEnum(
      args,
      "numberFormatType",
      [
        "TEXT", "NUMBER", "PERCENT", "CURRENCY", "DATE", "TIME",
        "DATE_TIME", "SCIENTIFIC",
      ] as const,
      "NUMBER",
    );
    const wrapStrategy = args.wrapStrategy === undefined
      ? undefined
      : requireEnum(args, "wrapStrategy", ["OVERFLOW_CELL", "CLIP", "WRAP"] as const);
    if (fontSize !== undefined && (!Number.isFinite(fontSize) || fontSize <= 0)) {
      throw new Error("'fontSize' must be a positive number");
    }

    const sheetId = await this.getSheetId(spreadsheetId, sheetName);
    const grid = parseGridRange(cellRange);

    const format: sheets_v4.Schema$CellFormat = {};
    const fields: string[] = [];

    // Text format
    const textFormat: sheets_v4.Schema$TextFormat = {};
    let hasTextFormat = false;
    if (bold !== undefined) { textFormat.bold = bold; fields.push("userEnteredFormat.textFormat.bold"); hasTextFormat = true; }
    if (italic !== undefined) { textFormat.italic = italic; fields.push("userEnteredFormat.textFormat.italic"); hasTextFormat = true; }
    if (fontSize !== undefined) { textFormat.fontSize = fontSize; fields.push("userEnteredFormat.textFormat.fontSize"); hasTextFormat = true; }
    if (fontColor) {
      textFormat.foregroundColorStyle = { rgbColor: hexToRgb(fontColor) };
      fields.push("userEnteredFormat.textFormat.foregroundColorStyle");
      hasTextFormat = true;
    }
    if (hasTextFormat) format.textFormat = textFormat;

    if (backgroundColor) {
      format.backgroundColorStyle = { rgbColor: hexToRgb(backgroundColor) };
      fields.push("userEnteredFormat.backgroundColorStyle");
    }
    if (horizontalAlignment) {
      format.horizontalAlignment = horizontalAlignment;
      fields.push("userEnteredFormat.horizontalAlignment");
    }
    if (verticalAlignment) {
      format.verticalAlignment = verticalAlignment;
      fields.push("userEnteredFormat.verticalAlignment");
    }
    if (numberFormat) {
      format.numberFormat = { type: numberFormatType, pattern: numberFormat };
      fields.push("userEnteredFormat.numberFormat");
    }
    if (wrapStrategy) {
      format.wrapStrategy = wrapStrategy;
      fields.push("userEnteredFormat.wrapStrategy");
    }

    const bordersInput = args.borders;
    const borderKeys = [
      "top", "bottom", "left", "right", "innerHorizontal", "innerVertical",
    ] as const;
    const borders: Partial<Record<(typeof borderKeys)[number], sheets_v4.Schema$Border>> = {};
    if (bordersInput !== undefined) {
      if (!isRecord(bordersInput)) throw new Error("'borders' must be an object");
      for (const [key, rawBorder] of Object.entries(bordersInput)) {
        if (!borderKeys.includes(key as (typeof borderKeys)[number])) {
          throw new Error("Unknown border edge: " + key);
        }
        if (!isRecord(rawBorder)) throw new Error("Border '" + key + "' must be an object");
        const borderArgs = rawBorder as Record<string, unknown>;
        const style = requireEnum(
          borderArgs,
          "style",
          [
            "DOTTED", "DASHED", "SOLID", "SOLID_MEDIUM", "SOLID_THICK",
            "DOUBLE", "NONE",
          ] as const,
        );
        const color = optionalString(borderArgs, "color");
        borders[key as (typeof borderKeys)[number]] = {
          style,
          colorStyle: color ? { rgbColor: hexToRgb(color) } : undefined,
        };
      }
    }

    if (fields.length === 0 && Object.keys(borders).length === 0) {
      return textResponse("No formatting options specified.");
    }

    const range = {
      sheetId,
      startRowIndex: grid.startRow,
      endRowIndex: grid.endRow,
      startColumnIndex: grid.startCol,
      endColumnIndex: grid.endCol,
    };
    const requests: sheets_v4.Schema$Request[] = [];
    if (fields.length > 0) {
      requests.push({
        repeatCell: {
          range,
          cell: { userEnteredFormat: format },
          fields: fields.join(","),
        },
      });
    }
    if (Object.keys(borders).length > 0) {
      requests.push({ updateBorders: { range, ...borders } });
    }
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });

    return textResponse(
      `Formatted ${sheetName}!${cellRange} (${fields.length} format properties, ${Object.keys(borders).length} borders).`,
    );
  }

  private async mergeCells(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetName = requireString(args, "sheetName");
    const cellRange = requireString(args, "cellRange");
    const mergeType = requireEnum(
      args,
      "mergeType",
      ["MERGE_ALL", "MERGE_COLUMNS", "MERGE_ROWS"] as const,
      "MERGE_ALL",
    );

    const sheetId = await this.getSheetId(spreadsheetId, sheetName);
    const grid = parseGridRange(cellRange);

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            mergeCells: {
              range: {
                sheetId,
                startRowIndex: grid.startRow,
                endRowIndex: grid.endRow,
                startColumnIndex: grid.startCol,
                endColumnIndex: grid.endCol,
              },
              mergeType,
            },
          },
        ],
      },
    });

    return textResponse(`Merged ${sheetName}!${cellRange} (${mergeType}).`);
  }

  private async setColumnWidth(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetId = requireInteger(args, "sheetId");
    const startColumn = requireInteger(args, "startColumn");
    const endColumn = requireInteger(args, "endColumn", 1);
    const width = requireInteger(args, "width", 1, 2000);
    if (endColumn <= startColumn) throw new Error("'endColumn' must be greater than 'startColumn'");

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateDimensionProperties: {
              range: {
                sheetId,
                dimension: "COLUMNS",
                startIndex: startColumn,
                endIndex: endColumn,
              },
              properties: { pixelSize: width },
              fields: "pixelSize",
            },
          },
        ],
      },
    });

    return textResponse(
      `Set columns ${startColumn}-${endColumn - 1} width to ${width}px.`,
    );
  }

  private async freezeRowsColumns(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetId = requireInteger(args, "sheetId");
    const frozenRowCount = optionalInteger(args, "frozenRowCount");
    const frozenColumnCount = optionalInteger(args, "frozenColumnCount");

    const gridProperties: sheets_v4.Schema$GridProperties = {};
    const fields: string[] = [];

    if (frozenRowCount !== undefined) {
      gridProperties.frozenRowCount = frozenRowCount;
      fields.push("gridProperties.frozenRowCount");
    }
    if (frozenColumnCount !== undefined) {
      gridProperties.frozenColumnCount = frozenColumnCount;
      fields.push("gridProperties.frozenColumnCount");
    }

    if (fields.length === 0) {
      return textResponse(
        "Specify frozenRowCount and/or frozenColumnCount.",
      );
    }

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties },
              fields: fields.join(","),
            },
          },
        ],
      },
    });

    return textResponse(
      `Frozen: ${frozenRowCount ?? "unchanged"} rows, ${frozenColumnCount ?? "unchanged"} columns.`,
    );
  }

  // ── Data operations ────────────────────────────────────

  private async sortRange(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetName = requireString(args, "sheetName");
    const cellRange = requireString(args, "cellRange");

    const sheetId = await this.getSheetId(spreadsheetId, sheetName);
    const grid = parseGridRange(cellRange);
    let specs: Array<{ columnIndex: number; ascending: boolean }>;
    if (args.sortSpecs !== undefined) {
      specs = requireObjectArray(args, "sortSpecs").map((raw, index) => {
        const columnIndex = requireInteger(raw, "columnIndex");
        if (columnIndex < grid.startCol || columnIndex >= grid.endCol) {
          throw new Error(
            "sortSpecs[" + index + "].columnIndex must be inside the sorted range",
          );
        }
        return {
          columnIndex,
          ascending: optionalBoolean(raw, "ascending") ?? true,
        };
      });
    } else {
      const columnIndex = optionalInteger(args, "sortColumn");
      if (columnIndex === undefined) {
        throw new Error("Specify 'sortColumn' or non-empty 'sortSpecs'");
      }
      if (columnIndex < grid.startCol || columnIndex >= grid.endCol) {
        throw new Error("'sortColumn' must be inside the sorted range");
      }
      specs = [{ columnIndex, ascending: optionalBoolean(args, "ascending") ?? true }];
    }

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            sortRange: {
              range: {
                sheetId,
                startRowIndex: grid.startRow,
                endRowIndex: grid.endRow,
                startColumnIndex: grid.startCol,
                endColumnIndex: grid.endCol,
              },
              sortSpecs: specs.map((spec) => ({
                dimensionIndex: spec.columnIndex,
                sortOrder: spec.ascending ? "ASCENDING" : "DESCENDING",
              })),
            },
          },
        ],
      },
    });

    return textResponse(
      `Sorted ${sheetName}!${cellRange} by ${specs.length} key${specs.length === 1 ? "" : "s"}.`,
    );
  }

  private async findReplace(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const find = requireString(args, "find");
    const replacement = optionalString(args, "replacement");
    if (replacement === undefined) throw new Error("'replacement' is required and must be a string");
    let sheetId = optionalInteger(args, "sheetId");
    const sheetName = optionalString(args, "sheetName");
    const cellRange = optionalString(args, "cellRange");
    const matchCase = optionalBoolean(args, "matchCase") ?? false;
    const matchEntireCell = optionalBoolean(args, "matchEntireCell") ?? false;
    const searchByRegex = optionalBoolean(args, "searchByRegex") ?? false;
    const includeFormulas = optionalBoolean(args, "includeFormulas") ?? false;
    if (sheetId !== undefined && sheetName !== undefined) {
      throw new Error("Specify only one of 'sheetId' or 'sheetName'");
    }
    if (sheetName !== undefined) sheetId = await this.getSheetId(spreadsheetId, sheetName);

    const request: sheets_v4.Schema$FindReplaceRequest = {
      find,
      replacement,
      matchCase,
      matchEntireCell,
      searchByRegex,
      includeFormulas,
    };
    if (cellRange) {
      if (sheetId === undefined) {
        throw new Error("'cellRange' requires 'sheetId' or 'sheetName'");
      }
      const grid = parseGridRange(cellRange);
      request.range = {
        sheetId,
        startRowIndex: grid.startRow,
        endRowIndex: grid.endRow,
        startColumnIndex: grid.startCol,
        endColumnIndex: grid.endCol,
      };
    } else if (sheetId !== undefined) {
      request.sheetId = sheetId;
    } else {
      request.allSheets = true;
    }

    const response = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ findReplace: request }] },
    });

    const result = response.data.replies?.[0]?.findReplace;
    return textResponse(
      `Replaced ${result?.occurrencesChanged || 0} occurrences of "${find}" with "${replacement}" (${result?.sheetsChanged || 0} sheets affected).`,
    );
  }

  // ── Charts ─────────────────────────────────────────────

  private async createChart(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetName = requireString(args, "sheetName");
    const dataRange = requireString(args, "dataRange");
    const chartType = requireEnum(
      args,
      "chartType",
      ["BAR", "LINE", "AREA", "COLUMN", "SCATTER", "PIE"] as const,
    );
    const title = optionalString(args, "title");

    const sheetId = await this.getSheetId(spreadsheetId, sheetName);
    const grid = parseGridRange(dataRange);
    if (grid.endCol - grid.startCol < 2) {
      throw new Error("'dataRange' must include a domain column and at least one series column");
    }
    if (grid.endRow - grid.startRow < 2) {
      throw new Error("'dataRange' must include a header row and at least one data row");
    }
    if (chartType === "PIE" && grid.endCol - grid.startCol !== 2) {
      throw new Error("PIE charts require exactly two columns (labels and values)");
    }

    // First column = domain (x-axis), remaining columns = series
    const domainSource = {
      sheetId,
      startRowIndex: grid.startRow,
      endRowIndex: grid.endRow,
      startColumnIndex: grid.startCol,
      endColumnIndex: grid.startCol + 1,
    };

    const series: sheets_v4.Schema$BasicChartSeries[] = [];
    for (let col = grid.startCol + 1; col < grid.endCol; col++) {
      series.push({
        series: {
          sourceRange: {
            sources: [
              {
                sheetId,
                startRowIndex: grid.startRow,
                endRowIndex: grid.endRow,
                startColumnIndex: col,
                endColumnIndex: col + 1,
              },
            ],
          },
        },
        targetAxis: chartType === "BAR" ? "BOTTOM_AXIS" : "LEFT_AXIS",
      });
    }

    const isPie = chartType === "PIE";

    const chartSpec: sheets_v4.Schema$ChartSpec = {
      title: title || undefined,
      ...(isPie
        ? {
            pieChart: {
              legendPosition: "RIGHT_LEGEND",
              domain: {
                sourceRange: { sources: [domainSource] },
              },
              series: {
                sourceRange: {
                  sources: [
                    {
                      sheetId,
                      startRowIndex: grid.startRow,
                      endRowIndex: grid.endRow,
                      startColumnIndex: grid.startCol + 1,
                      endColumnIndex: grid.startCol + 2,
                    },
                  ],
                },
              },
            },
          }
        : {
            basicChart: {
              chartType,
              legendPosition: "BOTTOM_LEGEND",
              headerCount: 1,
              domains: [
                {
                  domain: {
                    sourceRange: { sources: [domainSource] },
                  },
                },
              ],
              series,
            },
          }),
    };

    const response = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addChart: {
              chart: {
                spec: chartSpec,
                position: {
                  overlayPosition: {
                    anchorCell: {
                      sheetId,
                      rowIndex: grid.endRow + 1,
                      columnIndex: grid.startCol,
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });

    const chartId =
      response.data.replies?.[0]?.addChart?.chart?.chartId;
    return textResponse(
      `Chart created! Type: ${chartType}, Chart ID: ${chartId}\nData: ${sheetName}!${dataRange}`,
    );
  }

  // ── Raw batch update ───────────────────────────────────

  private async batchUpdateSpreadsheet(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const requests = requireObjectArray(args, "requests") as sheets_v4.Schema$Request[];
    if (requests.length > MAX_BATCH_REQUESTS) {
      throw new Error(`'requests' cannot contain more than ${MAX_BATCH_REQUESTS} items`);
    }
    const includeSpreadsheetInResponse =
      optionalBoolean(args, "includeSpreadsheetInResponse") ?? false;
    const responseIncludeGridData =
      optionalBoolean(args, "responseIncludeGridData") ?? false;
    const responseRanges =
      args.responseRanges === undefined
        ? undefined
        : requireStringArray(args, "responseRanges", true);

    const response = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests,
        includeSpreadsheetInResponse,
        responseIncludeGridData,
        responseRanges,
      },
    });

    return textResponse(JSON.stringify({
      spreadsheetId: response.data.spreadsheetId,
      replies: response.data.replies || [],
      updatedSpreadsheet: response.data.updatedSpreadsheet,
    }, null, 2));
  }

  private async renameSheet(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetId = requireInteger(args, "sheetId");
    const newName = requireString(args, "newName");

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId, title: newName },
              fields: "title",
            },
          },
        ],
      },
    });

    return textResponse(`Sheet ${sheetId} renamed to "${newName}".`);
  }

  private async duplicateSheet(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetId = requireInteger(args, "sheetId");
    const newName = optionalString(args, "newName");
    const destinationSpreadsheetId = optionalString(args, "destinationSpreadsheetId");
    const insertSheetIndex = optionalInteger(args, "insertSheetIndex");

    if (destinationSpreadsheetId) {
      const copied = await this.sheets.spreadsheets.sheets.copyTo({
        spreadsheetId,
        sheetId,
        requestBody: { destinationSpreadsheetId },
      });
      let copiedTitle = copied.data.title;
      if (newName && copied.data.sheetId !== undefined && copied.data.sheetId !== null) {
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: destinationSpreadsheetId,
          requestBody: {
            requests: [{
              updateSheetProperties: {
                properties: { sheetId: copied.data.sheetId, title: newName },
                fields: "title",
              },
            }],
          },
        });
        copiedTitle = newName;
      }
      return textResponse(
        `Sheet copied to spreadsheet ${destinationSpreadsheetId} as "${copiedTitle}" (sheetId: ${copied.data.sheetId}).`,
      );
    }

    const response = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            duplicateSheet: {
              sourceSheetId: sheetId,
              newSheetName: newName || undefined,
              insertSheetIndex,
            },
          },
        ],
      },
    });

    const props = response.data.replies?.[0]?.duplicateSheet?.properties;

    return textResponse(
      `Sheet duplicated! New sheet: "${props?.title}" (sheetId: ${props?.sheetId})`,
    );
  }

  private async batchGetValues(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const ranges = requireStringArray(args, "ranges");
    const majorDimension = requireEnum(
      args,
      "majorDimension",
      ["ROWS", "COLUMNS"] as const,
      "ROWS",
    );
    const valueRenderOption = requireEnum(
      args,
      "valueRenderOption",
      ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"] as const,
      "FORMATTED_VALUE",
    );
    const dateTimeRenderOption = requireEnum(
      args,
      "dateTimeRenderOption",
      ["SERIAL_NUMBER", "FORMATTED_STRING"] as const,
      "SERIAL_NUMBER",
    );
    const response = await this.sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges,
      majorDimension,
      valueRenderOption,
      dateTimeRenderOption,
    });
    return textResponse(JSON.stringify({
      spreadsheetId: response.data.spreadsheetId,
      valueRanges: response.data.valueRanges || [],
    }, null, 2));
  }

  private async batchUpdateValues(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const data = requireObjectArray(args, "data").map((item, index) => {
      const range = requireString(item, "range");
      const values = requireValues(item);
      const majorDimension = requireEnum(
        item,
        "majorDimension",
        ["ROWS", "COLUMNS"] as const,
        "ROWS",
      );
      if (values.length === 0) throw new Error("data[" + index + "].values cannot be empty");
      return { range, values, majorDimension };
    });
    const valueInputOption = requireEnum(
      args,
      "valueInputOption",
      ["RAW", "USER_ENTERED"] as const,
      "USER_ENTERED",
    );
    const includeValuesInResponse = optionalBoolean(args, "includeValuesInResponse") ?? false;
    const response = await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { data, valueInputOption, includeValuesInResponse },
    });
    return textResponse(JSON.stringify({
      spreadsheetId: response.data.spreadsheetId,
      totalUpdatedRows: response.data.totalUpdatedRows,
      totalUpdatedColumns: response.data.totalUpdatedColumns,
      totalUpdatedCells: response.data.totalUpdatedCells,
      totalUpdatedSheets: response.data.totalUpdatedSheets,
      responses: response.data.responses || [],
    }, null, 2));
  }

  private async batchClearValues(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const ranges = requireStringArray(args, "ranges");
    const response = await this.sheets.spreadsheets.values.batchClear({
      spreadsheetId,
      requestBody: { ranges },
    });
    return textResponse(JSON.stringify({
      spreadsheetId: response.data.spreadsheetId,
      clearedRanges: response.data.clearedRanges || [],
    }, null, 2));
  }

  private async addTable(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetName = requireString(args, "sheetName");
    const cellRange = requireString(args, "cellRange");
    const name = optionalString(args, "name");
    const sheetId = await this.getSheetId(spreadsheetId, sheetName);
    const grid = parseGridRange(cellRange);
    let columnProperties: sheets_v4.Schema$TableColumnProperties[] | undefined;
    if (args.columnProperties !== undefined) {
      const allowedTypes = [
        "DOUBLE", "CURRENCY", "PERCENT", "DATE", "TIME", "DATE_TIME", "TEXT",
        "BOOLEAN", "DROPDOWN", "FILES_CHIP", "PEOPLE_CHIP", "FINANCE_CHIP",
        "PLACE_CHIP", "RATINGS_CHIP",
      ] as const;
      columnProperties = requireObjectArray(args, "columnProperties").map((item) => ({
        columnIndex: optionalInteger(item, "columnIndex"),
        columnName: optionalString(item, "columnName"),
        columnType:
          item.columnType === undefined
            ? undefined
            : requireEnum(item, "columnType", allowedTypes),
      }));
    }
    const response = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addTable: {
            table: {
              name,
              range: {
                sheetId,
                startRowIndex: grid.startRow,
                endRowIndex: grid.endRow,
                startColumnIndex: grid.startCol,
                endColumnIndex: grid.endCol,
              },
              columnProperties,
            },
          },
        }],
      },
    });
    return textResponse(JSON.stringify(response.data.replies?.[0]?.addTable?.table || {}, null, 2));
  }

  private async updateTable(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    if (!isRecord(args.table)) throw new Error("'table' is required and must be an object");
    if (typeof args.table.tableId !== "string" || args.table.tableId.trim() === "") {
      throw new Error("'table.tableId' is required and must be a non-empty string");
    }
    const fields = requireString(args, "fields");
    const response = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateTable: {
            table: args.table as sheets_v4.Schema$Table,
            fields,
          },
        }],
      },
    });
    return textResponse(JSON.stringify({
      spreadsheetId: response.data.spreadsheetId,
      replies: response.data.replies || [],
    }, null, 2));
  }

  private async deleteTable(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const tableId = requireString(args, "tableId");
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ deleteTable: { tableId } }] },
    });
    return textResponse(`Deleted table ${tableId}; its cell values were preserved.`);
  }

  private async appendTableRows(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const tableId = requireString(args, "tableId");
    const values = requireValues(args);
    const parseFormulas = optionalBoolean(args, "parseFormulas") ?? true;
    const toCellData = (value: CellValue): sheets_v4.Schema$CellData => {
      if (value === null) return {};
      if (typeof value === "boolean") return { userEnteredValue: { boolValue: value } };
      if (typeof value === "number") return { userEnteredValue: { numberValue: value } };
      if (parseFormulas && value.startsWith("=")) {
        return { userEnteredValue: { formulaValue: value } };
      }
      return { userEnteredValue: { stringValue: value } };
    };
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          appendCells: {
            tableId,
            rows: values.map((row) => ({ values: row.map(toCellData) })),
            fields: "userEnteredValue",
          },
        }],
      },
    });
    return textResponse(`Appended ${values.length} row${values.length === 1 ? "" : "s"} to table ${tableId}.`);
  }

  private async writeSmartChips(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetName = requireString(args, "sheetName");
    const sheetId = await this.getSheetId(spreadsheetId, sheetName);
    const cells = requireObjectArray(args, "cells");
    const requests: sheets_v4.Schema$Request[] = cells.map((item, cellIndex) => {
      const cell = requireString(item, "cell");
      const text = requireString(item, "text");
      const grid = parseGridRange(cell);
      if (grid.endRow - grid.startRow !== 1 || grid.endCol - grid.startCol !== 1) {
        throw new Error("cells[" + cellIndex + "].cell must identify exactly one cell");
      }
      const chips = requireObjectArray(item, "chips").map((chip, chipIndex) => {
        const startIndex = requireInteger(chip, "startIndex");
        if (text[startIndex] !== "@") {
          throw new Error(
            "cells[" + cellIndex + "].chips[" + chipIndex +
              "].startIndex must point to an @ placeholder",
          );
        }
        const type = requireEnum(chip, "type", ["PERSON", "DRIVE_FILE"] as const);
        if (type === "PERSON") {
          const email = requireString(chip, "email");
          const displayFormat = chip.displayFormat === undefined
            ? undefined
            : requireEnum(
                chip,
                "displayFormat",
                ["DEFAULT", "LAST_NAME_COMMA_FIRST_NAME", "EMAIL"] as const,
              );
          return { startIndex, chip: { personProperties: { email, displayFormat } } };
        }
        const uri = requireString(chip, "uri");
        if (!/^https:\/\/(drive|docs)\.google\.com\//i.test(uri)) {
          throw new Error("Drive-file smart chips require a drive.google.com or docs.google.com URI");
        }
        return { startIndex, chip: { richLinkProperties: { uri } } };
      });
      return {
        updateCells: {
          range: {
            sheetId,
            startRowIndex: grid.startRow,
            endRowIndex: grid.endRow,
            startColumnIndex: grid.startCol,
            endColumnIndex: grid.endCol,
          },
          rows: [{
            values: [{
              userEnteredValue: { stringValue: text },
              chipRuns: chips,
            }],
          }],
          fields: "userEnteredValue,chipRuns",
        },
      };
    });
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
    return textResponse(`Wrote smart chips to ${cells.length} cell${cells.length === 1 ? "" : "s"}.`);
  }

  private async addProtectedRange(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetName = requireString(args, "sheetName");
    const cellRange = requireString(args, "cellRange");
    const description = optionalString(args, "description");
    const warningOnly = optionalBoolean(args, "warningOnly") ?? false;
    const sheetId = await this.getSheetId(spreadsheetId, sheetName);
    const grid = parseGridRange(cellRange);
    let editors: sheets_v4.Schema$Editors | undefined;
    if (args.editors !== undefined) {
      if (!isRecord(args.editors)) throw new Error("'editors' must be an object");
      if (warningOnly) throw new Error("'editors' cannot be set when warningOnly is true");
      editors = {
        users: args.editors.users === undefined
          ? undefined
          : requireStringArray(args.editors, "users", true),
        groups: args.editors.groups === undefined
          ? undefined
          : requireStringArray(args.editors, "groups", true),
        domainUsersCanEdit: optionalBoolean(args.editors, "domainUsersCanEdit"),
      };
    }
    const response = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addProtectedRange: {
            protectedRange: {
              range: {
                sheetId,
                startRowIndex: grid.startRow,
                endRowIndex: grid.endRow,
                startColumnIndex: grid.startCol,
                endColumnIndex: grid.endCol,
              },
              description,
              warningOnly,
              editors,
            },
          },
        }],
      },
    });
    const protectedRange = response.data.replies?.[0]?.addProtectedRange?.protectedRange;
    return textResponse(JSON.stringify(protectedRange || {}, null, 2));
  }

  private async deleteProtectedRange(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const protectedRangeId = requireInteger(args, "protectedRangeId");
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ deleteProtectedRange: { protectedRangeId } }] },
    });
    return textResponse(`Deleted protected range ${protectedRangeId}.`);
  }

  private async addConditionalFormatRule(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    if (!isRecord(args.rule)) throw new Error("'rule' is required and must be an object");
    const index = optionalInteger(args, "index") ?? 0;
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addConditionalFormatRule: {
            rule: args.rule as sheets_v4.Schema$ConditionalFormatRule,
            index,
          },
        }],
      },
    });
    return textResponse(`Added conditional-format rule at index ${index}.`);
  }

  private async deleteConditionalFormatRule(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetId = requireInteger(args, "sheetId");
    const index = requireInteger(args, "index");
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ deleteConditionalFormatRule: { sheetId, index } }],
      },
    });
    return textResponse(`Deleted conditional-format rule ${index} from sheet ${sheetId}.`);
  }

  private async setDataValidation(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetName = requireString(args, "sheetName");
    const cellRange = requireString(args, "cellRange");
    const clear = optionalBoolean(args, "clear") ?? false;
    const sheetId = await this.getSheetId(spreadsheetId, sheetName);
    const grid = parseGridRange(cellRange);
    let rule: sheets_v4.Schema$DataValidationRule | undefined;
    if (!clear) {
      const conditionType = requireString(args, "conditionType");
      const conditionValues = args.conditionValues === undefined
        ? []
        : requireStringArray(args, "conditionValues", true);
      rule = {
        condition: {
          type: conditionType,
          values: conditionValues.map((value) => ({ userEnteredValue: value })),
        },
        strict: optionalBoolean(args, "strict") ?? true,
        showCustomUi: optionalBoolean(args, "showCustomUi") ?? true,
        inputMessage: optionalString(args, "inputMessage"),
      };
    }
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          setDataValidation: {
            range: {
              sheetId,
              startRowIndex: grid.startRow,
              endRowIndex: grid.endRow,
              startColumnIndex: grid.startCol,
              endColumnIndex: grid.endCol,
            },
            rule,
          },
        }],
      },
    });
    return textResponse(`${clear ? "Cleared" : "Set"} validation on ${sheetName}!${cellRange}.`);
  }

  private async autoResizeDimensions(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetId = requireInteger(args, "sheetId");
    const dimension = requireEnum(args, "dimension", ["ROWS", "COLUMNS"] as const);
    const startIndex = requireInteger(args, "startIndex");
    const endIndex = requireInteger(args, "endIndex", 1);
    if (endIndex <= startIndex) throw new Error("'endIndex' must be greater than 'startIndex'");
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          autoResizeDimensions: {
            dimensions: { sheetId, dimension, startIndex, endIndex },
          },
        }],
      },
    });
    return textResponse(`Auto-resized ${dimension.toLowerCase()} ${startIndex}-${endIndex - 1}.`);
  }

  private async unmergeCells(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetName = requireString(args, "sheetName");
    const cellRange = requireString(args, "cellRange");

    const sheetId = await this.getSheetId(spreadsheetId, sheetName);
    const grid = parseGridRange(cellRange);

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            unmergeCells: {
              range: {
                sheetId,
                startRowIndex: grid.startRow,
                endRowIndex: grid.endRow,
                startColumnIndex: grid.startCol,
                endColumnIndex: grid.endCol,
              },
            },
          },
        ],
      },
    });

    return textResponse(`Unmerged ${sheetName}!${cellRange}.`);
  }
}
