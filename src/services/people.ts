import { google, type people_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Service, ToolDefinition } from "../types.js";
import {
  jsonResponse,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
} from "../utils.js";

const DEFAULT_FIELDS =
  "names,emailAddresses,phoneNumbers,organizations,photos,metadata";
const MAX_PEOPLE_PAGE_SIZE = 200;

function pageSize(
  args: Record<string, unknown>,
  fallback: number,
  maximum: number,
): number {
  const value = optionalNumber(args, "pageSize") ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`'pageSize' must be an integer between 1 and ${maximum}`);
  }
  return value;
}

export class PeopleService implements Service {
  private people!: people_v1.People;

  initialize(auth: OAuth2Client): void {
    this.people = google.people({ version: "v1", auth });
  }

  getToolDefinitions(): ToolDefinition[] {
    const commonFields = {
      readMask: {
        type: "string",
        description: `Comma-separated People fields (default: ${DEFAULT_FIELDS})`,
      },
      pageSize: { type: "number", minimum: 1, maximum: MAX_PEOPLE_PAGE_SIZE },
      pageToken: { type: "string" },
    } as const;

    return [
      {
        tool: {
          name: "get_user_profile",
          description: "Get the authenticated user's Google profile.",
          inputSchema: {
            type: "object",
            properties: { readMask: commonFields.readMask },
          },
        },
        handler: (args) => this.getPerson({ ...args, resourceName: "people/me" }),
      },
      {
        tool: {
          name: "get_person",
          description: "Get a contact or directory person by People API resource name.",
          inputSchema: {
            type: "object",
            properties: {
              resourceName: {
                type: "string",
                description: "For example people/me or people/c123",
              },
              readMask: commonFields.readMask,
            },
            required: ["resourceName"],
          },
        },
        handler: (args) => this.getPerson(args),
      },
      {
        tool: {
          name: "list_contacts",
          description:
            "List the authenticated user's contacts with cursor and optional incremental sync support.",
          inputSchema: {
            type: "object",
            properties: {
              ...commonFields,
              syncToken: { type: "string" },
              requestSyncToken: { type: "boolean" },
              sortOrder: {
                type: "string",
                enum: [
                  "LAST_MODIFIED_ASCENDING",
                  "LAST_MODIFIED_DESCENDING",
                  "FIRST_NAME_ASCENDING",
                  "LAST_NAME_ASCENDING",
                ],
              },
            },
          },
        },
        handler: (args) => this.listContacts(args),
      },
      {
        tool: {
          name: "search_contacts",
          description:
            "Prefix-search the authenticated user's Google contacts by name, email, phone, organization, or address.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              readMask: commonFields.readMask,
              pageSize: { type: "number", minimum: 1, maximum: 30 },
              refreshCache: {
                type: "boolean",
                description: "Issue the documented empty-query cache warm-up first",
              },
            },
            required: ["query"],
          },
        },
        handler: (args) => this.searchContacts(args),
      },
      {
        tool: {
          name: "search_directory_people",
          description:
            "Search the Google Workspace domain directory. Availability depends on Workspace administrator policy.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              ...commonFields,
            },
            required: ["query"],
          },
        },
        handler: (args) => this.searchDirectory(args),
      },
    ];
  }

  private async getPerson(args: Record<string, unknown>) {
    const response = await this.people.people.get({
      resourceName: requireString(args, "resourceName"),
      personFields: optionalString(args, "readMask") ?? DEFAULT_FIELDS,
    });
    return jsonResponse(
      { person: response.data },
      `Person returned: ${response.data.resourceName ?? "resource name not returned"}`,
    );
  }

  private async listContacts(args: Record<string, unknown>) {
    const response = await this.people.people.connections.list({
      resourceName: "people/me",
      personFields: optionalString(args, "readMask") ?? DEFAULT_FIELDS,
      pageSize: pageSize(args, 100, MAX_PEOPLE_PAGE_SIZE),
      pageToken: optionalString(args, "pageToken"),
      syncToken: optionalString(args, "syncToken"),
      requestSyncToken: optionalBoolean(args, "requestSyncToken"),
      sortOrder: optionalString(args, "sortOrder"),
    });
    const contacts = response.data.connections ?? [];
    return jsonResponse({
      contacts,
      totalPeople: response.data.totalPeople,
      nextPageToken: response.data.nextPageToken,
      nextSyncToken: response.data.nextSyncToken,
    }, `Returned ${contacts.length} contact(s) in structuredContent.`);
  }

  private async searchContacts(args: Record<string, unknown>) {
    const readMask = optionalString(args, "readMask") ?? DEFAULT_FIELDS;
    if (optionalBoolean(args, "refreshCache")) {
      await this.people.people.searchContacts({ query: "", readMask, pageSize: 1 });
    }
    const response = await this.people.people.searchContacts({
      query: requireString(args, "query"),
      readMask,
      pageSize: pageSize(args, 10, 30),
    });
    const contacts = response.data.results ?? [];
    return jsonResponse(
      { contacts },
      `Returned ${contacts.length} contact search result(s) in structuredContent.`,
    );
  }

  private async searchDirectory(args: Record<string, unknown>) {
    const response = await this.people.people.searchDirectoryPeople({
      query: requireString(args, "query"),
      readMask: optionalString(args, "readMask") ?? DEFAULT_FIELDS,
      pageSize: pageSize(args, 100, MAX_PEOPLE_PAGE_SIZE),
      pageToken: optionalString(args, "pageToken"),
      sources: ["DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE"],
    });
    const people = response.data.people ?? [];
    return jsonResponse({
      people,
      nextPageToken: response.data.nextPageToken,
      totalSize: response.data.totalSize,
    }, `Returned ${people.length} directory result(s) in structuredContent.`);
  }
}
