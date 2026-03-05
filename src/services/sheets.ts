import { google, type sheets_v4 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Service, ToolDefinition } from "../types.js";
import {
  requireString,
  optionalString,
  textResponse,
  MAX_SPREADSHEET_ROWS,
} from "../utils.js";

export class SheetsService implements Service {
  private sheets!: sheets_v4.Sheets;

  initialize(auth: OAuth2Client): void {
    this.sheets = google.sheets({ version: "v4", auth });
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        tool: {
          name: "read_spreadsheet",
          description:
            "Read data from a Google Sheet with sheet names and cell values.",
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: {
                type: "string",
                description: "The ID of the Google Sheet to read",
              },
              range: {
                type: "string",
                description:
                  "Optional range in A1 notation (e.g., 'Sheet1!A1:D10'). If not provided, reads all sheets.",
              },
            },
            required: ["spreadsheetId"],
          },
        },
        handler: (args) => this.readSpreadsheet(args),
      },
    ];
  }

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
      const sheets = spreadsheet.data.sheets || [];

      for (const sheet of sheets) {
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
}
