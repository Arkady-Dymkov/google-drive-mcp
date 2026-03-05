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
} from "../utils.js";

// ── Helpers ──────────────────────────────────────────────────

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
  return {
    startRow: parseInt(m[2]) - 1,
    startCol: colToIndex(m[1]),
    endRow: m[4] ? parseInt(m[4]) : parseInt(m[2]),
    endCol: m[3] ? colToIndex(m[3]) + 1 : colToIndex(m[1]) + 1,
  };
}

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
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
    const ss = await this.sheets.spreadsheets.get({ spreadsheetId });
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
                items: { type: "array" },
                description:
                  "2D array of values. Each inner array is a row. Example: [[\"Name\",\"Age\"],[\"Alice\",30]]",
              },
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
            "Append rows of data after the last row with content in a sheet. Auto-detects where data ends.",
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
                items: { type: "array" },
                description: "2D array of rows to append",
              },
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
              wrapStrategy: {
                type: "string",
                enum: ["OVERFLOW_CELL", "CLIP", "WRAP"],
                description: "Text wrapping strategy",
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
                description: "0-based column index to sort by",
              },
              ascending: {
                type: "boolean",
                description: "Sort ascending (true) or descending (false). Default: true",
              },
            },
            required: ["spreadsheetId", "sheetName", "cellRange", "sortColumn"],
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
              matchCase: { type: "boolean", description: "Case-sensitive search (default: false)" },
              matchEntireCell: {
                type: "boolean",
                description: "Only match if entire cell matches (default: false)",
              },
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
                description:
                  "Array of Google Sheets API request objects (repeatCell, addConditionalFormatRule, setDataValidation, updateBorders, addChart, etc.)",
              },
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
            },
            required: ["spreadsheetId", "sheetId"],
          },
        },
        handler: (a) => this.duplicateSheet(a),
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

    const spreadsheet = await this.sheets.spreadsheets.get({ spreadsheetId });
    const title = spreadsheet.data.properties?.title;
    let output = `Spreadsheet: ${title}\n\n`;

    if (range) {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
      });
      const values = response.data.values || [];
      output += `Range: ${range}\n\n`;
      output += values.map((row: string[]) => row.join("\t")).join("\n");
    } else {
      for (const sheet of spreadsheet.data.sheets || []) {
        const sheetTitle = sheet.properties?.title;
        output += `\nSheet: ${sheetTitle}\n`;
        try {
          const response = await this.sheets.spreadsheets.values.get({
            spreadsheetId,
            range: sheetTitle!,
          });
          const values = response.data.values || [];
          if (values.length > 0) {
            output += values
              .slice(0, MAX_SPREADSHEET_ROWS)
              .map((row: string[]) => row.join("\t"))
              .join("\n");
            if (values.length > MAX_SPREADSHEET_ROWS) {
              output += `\n... (${values.length - MAX_SPREADSHEET_ROWS} more rows)`;
            }
          } else {
            output += "(empty)\n";
          }
        } catch {
          output += "(unable to read)\n";
        }
      }
    }

    return textResponse(output);
  }

  private async getSpreadsheetInfo(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");

    const ss = await this.sheets.spreadsheets.get({ spreadsheetId });
    const title = ss.data.properties?.title;
    const sheets = (ss.data.sheets || []).map((s) => ({
      sheetId: s.properties?.sheetId,
      title: s.properties?.title,
      rowCount: s.properties?.gridProperties?.rowCount,
      columnCount: s.properties?.gridProperties?.columnCount,
      frozenRowCount: s.properties?.gridProperties?.frozenRowCount || 0,
      frozenColumnCount: s.properties?.gridProperties?.frozenColumnCount || 0,
    }));
    const namedRanges = (ss.data.namedRanges || []).map((nr) => ({
      name: nr.name,
      range: nr.range,
    }));

    let output = `Spreadsheet: ${title}\nID: ${spreadsheetId}\nURL: ${ss.data.spreadsheetUrl}\n\nSheets:\n`;
    for (const s of sheets) {
      output += `  - "${s.title}" (sheetId: ${s.sheetId}, ${s.rowCount} rows x ${s.columnCount} cols, frozen: ${s.frozenRowCount} rows / ${s.frozenColumnCount} cols)\n`;
    }
    if (namedRanges.length > 0) {
      output += `\nNamed Ranges:\n`;
      for (const nr of namedRanges) {
        output += `  - ${nr.name}: ${JSON.stringify(nr.range)}\n`;
      }
    }

    return textResponse(output);
  }

  // ── Write handlers ──────────────────────────────────────

  private async writeCells(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const range = requireString(args, "range");
    const values = args.values;
    if (!Array.isArray(values)) throw new Error("'values' must be a 2D array");

    const response = await this.sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });

    return textResponse(
      `Updated ${response.data.updatedCells} cells in ${response.data.updatedRange}`,
    );
  }

  private async appendRows(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const range = requireString(args, "range");
    const values = args.values;
    if (!Array.isArray(values)) throw new Error("'values' must be a 2D array");

    const response = await this.sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });

    const updates = response.data.updates;
    return textResponse(
      `Appended ${updates?.updatedRows} rows to ${updates?.updatedRange}`,
    );
  }

  private async clearCells(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const range = requireString(args, "range");

    await this.sheets.spreadsheets.values.clear({
      spreadsheetId,
      range,
    });

    return textResponse(`Cleared range ${range}`);
  }

  // ── Spreadsheet / sheet management ──────────────────────

  private async createSpreadsheet(args: Record<string, unknown>) {
    const title = requireString(args, "title");
    const sheetNames = args.sheetNames as string[] | undefined;
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
      await this.drive.files.update({
        fileId: ssId,
        addParents: folderId,
        removeParents: "root",
        fields: "id, parents",
      });
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
    const sheetId = requireNumber(args, "sheetId");

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
    const sheetId = requireNumber(args, "sheetId");
    const dimension = requireString(args, "dimension") as "ROWS" | "COLUMNS";
    const startIndex = requireNumber(args, "startIndex");
    const endIndex = requireNumber(args, "endIndex");

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
    const sheetId = requireNumber(args, "sheetId");
    const dimension = requireString(args, "dimension") as "ROWS" | "COLUMNS";
    const startIndex = requireNumber(args, "startIndex");
    const endIndex = requireNumber(args, "endIndex");

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
    const horizontalAlignment = optionalString(args, "horizontalAlignment");
    const numberFormat = optionalString(args, "numberFormat");
    const wrapStrategy = optionalString(args, "wrapStrategy");

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
    if (numberFormat) {
      format.numberFormat = { type: "NUMBER", pattern: numberFormat };
      fields.push("userEnteredFormat.numberFormat");
    }
    if (wrapStrategy) {
      format.wrapStrategy = wrapStrategy;
      fields.push("userEnteredFormat.wrapStrategy");
    }

    if (fields.length === 0) {
      return textResponse("No formatting options specified.");
    }

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: grid.startRow,
                endRowIndex: grid.endRow,
                startColumnIndex: grid.startCol,
                endColumnIndex: grid.endCol,
              },
              cell: { userEnteredFormat: format },
              fields: fields.join(","),
            },
          },
        ],
      },
    });

    return textResponse(
      `Formatted ${sheetName}!${cellRange} (${fields.length} properties applied).`,
    );
  }

  private async mergeCells(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetName = requireString(args, "sheetName");
    const cellRange = requireString(args, "cellRange");
    const mergeType = optionalString(args, "mergeType") || "MERGE_ALL";

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
    const sheetId = requireNumber(args, "sheetId");
    const startColumn = requireNumber(args, "startColumn");
    const endColumn = requireNumber(args, "endColumn");
    const width = requireNumber(args, "width");

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
    const sheetId = requireNumber(args, "sheetId");
    const frozenRowCount = optionalNumber(args, "frozenRowCount");
    const frozenColumnCount = optionalNumber(args, "frozenColumnCount");

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
    const sortColumn = requireNumber(args, "sortColumn");
    const ascending = optionalBoolean(args, "ascending") ?? true;

    const sheetId = await this.getSheetId(spreadsheetId, sheetName);
    const grid = parseGridRange(cellRange);

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
              sortSpecs: [
                {
                  dimensionIndex: sortColumn,
                  sortOrder: ascending ? "ASCENDING" : "DESCENDING",
                },
              ],
            },
          },
        ],
      },
    });

    return textResponse(
      `Sorted ${sheetName}!${cellRange} by column ${sortColumn} ${ascending ? "ascending" : "descending"}.`,
    );
  }

  private async findReplace(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const find = requireString(args, "find");
    const replacement = requireString(args, "replacement");
    const sheetId = optionalNumber(args, "sheetId");
    const matchCase = optionalBoolean(args, "matchCase") ?? false;
    const matchEntireCell = optionalBoolean(args, "matchEntireCell") ?? false;

    const request: sheets_v4.Schema$FindReplaceRequest = {
      find,
      replacement,
      matchCase,
      matchEntireCell,
      allSheets: sheetId === undefined,
    };
    if (sheetId !== undefined) request.sheetId = sheetId;

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
    const chartType = requireString(args, "chartType");
    const title = optionalString(args, "title");

    const sheetId = await this.getSheetId(spreadsheetId, sheetName);
    const grid = parseGridRange(dataRange);

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
    const requests = args.requests;
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new Error("'requests' must be a non-empty array");
    }

    const response = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });

    const repliesCount = response.data.replies?.length || 0;
    return textResponse(
      `Batch update completed! Operations: ${requests.length}, Replies: ${repliesCount}`,
    );
  }

  private async renameSheet(args: Record<string, unknown>) {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheetId = requireNumber(args, "sheetId");
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
    const sheetId = requireNumber(args, "sheetId");
    const newName = optionalString(args, "newName");
    const destinationSpreadsheetId = optionalString(args, "destinationSpreadsheetId");

    const response = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            duplicateSheet: {
              sourceSheetId: sheetId,
              newSheetName: newName || undefined,
              insertSheetIndex: 0,
              newSheetId: undefined,
            },
          },
        ],
      },
    });

    const props = response.data.replies?.[0]?.duplicateSheet?.properties;

    if (destinationSpreadsheetId) {
      await this.sheets.spreadsheets.sheets.copyTo({
        spreadsheetId,
        sheetId,
        requestBody: { destinationSpreadsheetId },
      });
      return textResponse(
        `Sheet copied to spreadsheet ${destinationSpreadsheetId}.`,
      );
    }

    return textResponse(
      `Sheet duplicated! New sheet: "${props?.title}" (sheetId: ${props?.sheetId})`,
    );
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
