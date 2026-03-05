import type { ToolResponse } from "./types.js";

export const MAX_SPREADSHEET_ROWS = 100;
export const MIN_MARKDOWN_LENGTH = 50;
export const MIN_CONTENT_HTML_LENGTH = 100;

export function requireString(
  args: Record<string, unknown>,
  field: string,
): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`'${field}' is required and must be a non-empty string`);
  }
  return value;
}

export function optionalString(
  args: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`'${field}' must be a string`);
  }
  return value;
}

export function optionalNumber(
  args: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number") {
    throw new Error(`'${field}' must be a number`);
  }
  return value;
}

export function optionalBoolean(
  args: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`'${field}' must be a boolean`);
  }
  return value;
}

export function formatApiError(error: unknown): string {
  if (error instanceof Error) {
    // Google API errors have structured details
    const apiError = error as Error & {
      response?: { data?: { error?: { message?: string; code?: number } } };
    };
    const details = apiError.response?.data?.error;
    if (details) {
      return `${details.message || error.message} (code ${details.code || "unknown"})`;
    }
    return error.message;
  }
  return String(error);
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function textResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }] };
}

export function errorResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }], isError: true };
}
