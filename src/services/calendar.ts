import { randomUUID } from "node:crypto";
import { google, type calendar_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Service, ToolDefinition } from "../types.js";
import {
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  textResponse,
} from "../utils.js";

// googleapis 173's Calendar discovery snapshot declares empty EventLabel and
// LabelProperties marker interfaces, but omits the public July 2026 fields and
// query parameters. Keep the compatibility surface limited to the documented
// fields until the generated client catches up.
type CalendarEventLabel = {
  id?: string;
  backgroundColor: string;
  name?: string;
};

type CalendarWithLabels = calendar_v3.Schema$Calendar & {
  labelProperties?: { eventLabels?: CalendarEventLabel[] };
};

type EventWithLabel = calendar_v3.Schema$Event & {
  eventLabelId?: string | null;
};

type EventInsertParamsWithLabels = calendar_v3.Params$Resource$Events$Insert & {
  eventLabelVersion?: 0 | 1;
};

type EventPatchParamsWithLabels = calendar_v3.Params$Resource$Events$Patch & {
  eventLabelVersion?: 0 | 1;
};

type CalendarListParamsWithOrganization =
  calendar_v3.Params$Resource$Calendarlist$List & {
    showOwnOrganizationOnly?: boolean;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(args: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(args, field);
}

function requireInteger(
  args: Record<string, unknown>,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = args[field];
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`'${field}' must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function optionalInteger(
  args: Record<string, unknown>,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (args[field] === undefined || args[field] === null) return undefined;
  return requireInteger(args, field, minimum, maximum);
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
    throw new Error(`'${field}' must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
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
    throw new Error(`'${field}' must be ${allowEmpty ? "an" : "a non-empty"} array of non-empty strings`);
  }
  return value as string[];
}

function validateDateOrDateTime(value: string, field: string): "date" | "dateTime" {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(value + "T00:00:00Z");
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new Error(`'${field}' must be a valid calendar date`);
    }
    return "date";
  }
  if (!value.includes("T") || Number.isNaN(Date.parse(value))) {
    throw new Error(`'${field}' must be an ISO 8601 date or date-time`);
  }
  return "dateTime";
}

function validateTimeRange(start: string, end: string, startField: string, endField: string): void {
  const startKind = validateDateOrDateTime(start, startField);
  const endKind = validateDateOrDateTime(end, endField);
  if (startKind !== endKind) {
    throw new Error(`'${startField}' and '${endField}' must both be dates or both be date-times`);
  }
  if (Date.parse(endKind === "date" ? end + "T00:00:00Z" : end) <= Date.parse(startKind === "date" ? start + "T00:00:00Z" : start)) {
    throw new Error(`'${endField}' must be later than '${startField}'`);
  }
}

function validateOptionalTimeRange(timeMin?: string, timeMax?: string): void {
  const validateRfc3339 = (value: string, field: string): void => {
    if (
      validateDateOrDateTime(value, field) !== "dateTime" ||
      !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    ) {
      throw new Error(`'${field}' must be an RFC 3339 date-time with a UTC offset`);
    }
  };
  if (timeMin) validateRfc3339(timeMin, "timeMin");
  if (timeMax) validateRfc3339(timeMax, "timeMax");
  if (timeMin && timeMax && Date.parse(timeMax) <= Date.parse(timeMin)) {
    throw new Error("'timeMax' must be later than 'timeMin'");
  }
}

function validateTimeZone(timeZone?: string): void {
  if (!timeZone) return;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new Error(`Invalid IANA time zone: ${timeZone}`);
  }
}

function requireEmailArray(args: Record<string, unknown>, field: string, allowEmpty = false): string[] {
  const emails = requireStringArray(args, field, allowEmpty);
  for (const email of emails) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`Invalid email address in '${field}': ${email}`);
    }
  }
  return emails;
}

function parseExtendedProperties(
  args: Record<string, unknown>,
  field: string,
): Record<string, string> | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`'${field}' must be an object`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || typeof item !== "string") {
      throw new Error(`'${field}' keys must be non-empty and values must be strings`);
    }
    result[key] = item;
  }
  return result;
}

function requireUuid(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`'${field}' must be a UUID`);
  }
  return value;
}

export class CalendarService implements Service {
  private cal!: calendar_v3.Calendar;

  initialize(auth: OAuth2Client): void {
    this.cal = google.calendar({ version: "v3", auth });
  }

  // ── Helpers ─────────────────────────────────────────────

  private fmtTime(e: calendar_v3.Schema$EventDateTime | undefined): string {
    if (!e) return "N/A";
    return e.dateTime || e.date || "N/A";
  }

  private fmtEvent(ev: calendar_v3.Schema$Event): string {
    const parts = [
      `- ${ev.summary || "(no title)"} (ID: ${ev.id})`,
      `  When: ${this.fmtTime(ev.start)} -> ${this.fmtTime(ev.end)}`,
    ];
    if (ev.location) parts.push(`  Location: ${ev.location}`);
    if (ev.attendees?.length) {
      const att = ev.attendees
        .map((a) => `${a.email} (${a.responseStatus})`)
        .join(", ");
      parts.push(`  Attendees: ${att}`);
    }
    if (ev.hangoutLink) parts.push(`  Meet: ${ev.hangoutLink}`);
    const eventLabelId = (ev as EventWithLabel).eventLabelId;
    if (eventLabelId) parts.push(`  Event label ID: ${eventLabelId}`);
    if (ev.htmlLink) parts.push(`  Link: ${ev.htmlLink}`);
    return parts.join("\n");
  }

  private fmtEventFull(ev: calendar_v3.Schema$Event): string {
    const lines = [
      `Event: ${ev.summary || "(no title)"}`,
      `ID: ${ev.id}`,
      `Status: ${ev.status}`,
      `When: ${this.fmtTime(ev.start)} -> ${this.fmtTime(ev.end)}`,
    ];
    if (ev.location) lines.push(`Location: ${ev.location}`);
    if (ev.description) lines.push(`Description: ${ev.description}`);
    if (ev.creator) lines.push(`Creator: ${ev.creator.email}`);
    if (ev.organizer) lines.push(`Organizer: ${ev.organizer.email}`);
    if (ev.attendees?.length) {
      lines.push("Attendees:");
      for (const a of ev.attendees) {
        lines.push(
          `  - ${a.email} (${a.responseStatus}${a.optional ? ", optional" : ""})`,
        );
      }
    }
    if (ev.recurrence?.length) {
      lines.push(`Recurrence: ${ev.recurrence.join("; ")}`);
    }
    if (ev.hangoutLink) lines.push(`Google Meet: ${ev.hangoutLink}`);
    if (ev.htmlLink) lines.push(`Link: ${ev.htmlLink}`);
    if (ev.colorId) lines.push(`Color ID: ${ev.colorId}`);
    const eventLabelId = (ev as EventWithLabel).eventLabelId;
    if (eventLabelId) lines.push(`Event label ID: ${eventLabelId}`);
    if (ev.extendedProperties?.private && Object.keys(ev.extendedProperties.private).length) {
      lines.push(`Private metadata: ${JSON.stringify(ev.extendedProperties.private)}`);
    }
    if (ev.extendedProperties?.shared && Object.keys(ev.extendedProperties.shared).length) {
      lines.push(`Shared metadata: ${JSON.stringify(ev.extendedProperties.shared)}`);
    }
    if (ev.reminders) {
      if (ev.reminders.useDefault) {
        lines.push("Reminders: default");
      } else if (ev.reminders.overrides?.length) {
        const r = ev.reminders.overrides
          .map((o) => `${o.method} ${o.minutes}min before`)
          .join(", ");
        lines.push(`Reminders: ${r}`);
      }
    }
    return lines.join("\n");
  }

  // ── Tool definitions ────────────────────────────────────

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        tool: {
          name: "list_calendars",
          description:
            "List all calendars the user has access to, with IDs, names, and access roles.",
          inputSchema: {
            type: "object",
            properties: {
              maxResults: { type: "number", minimum: 1, maximum: 250 },
              pageToken: { type: "string" },
              showDeleted: { type: "boolean" },
              showHidden: { type: "boolean" },
              showOwnOrganizationOnly: {
                type: "boolean",
                description:
                  "Return only calendars belonging to the user's Workspace organization",
              },
            },
          },
        },
        handler: (a) => this.listCalendars(a),
      },
      {
        tool: {
          name: "list_events",
          description:
            "List events from a calendar within a time range. Returns upcoming events by default.",
          inputSchema: {
            type: "object",
            properties: {
              calendarId: {
                type: "string",
                description:
                  "Calendar ID (default: 'primary'). Use list_calendars to find IDs.",
              },
              timeMin: {
                type: "string",
                description:
                  "Start of time range (ISO 8601, e.g., '2025-03-01T00:00:00Z'). Defaults to now.",
              },
              timeMax: {
                type: "string",
                description:
                  "Optional end of time range (ISO 8601); no hidden upper bound is applied.",
              },
              maxResults: {
                type: "number",
                description: "Max events to return (default: 50, max: 2500)",
              },
              showDeleted: {
                type: "boolean",
                description: "Include deleted/cancelled events (default: false)",
              },
              pageToken: { type: "string", description: "Token from the previous page" },
              timeZone: { type: "string", description: "Time zone for returned event times" },
            },
          },
        },
        handler: (a) => this.listEvents(a),
      },
      {
        tool: {
          name: "get_event",
          description:
            "Get full details of a specific calendar event by its ID.",
          inputSchema: {
            type: "object",
            properties: {
              calendarId: {
                type: "string",
                description: "Calendar ID (default: 'primary')",
              },
              eventId: {
                type: "string",
                description: "The event ID",
              },
            },
            required: ["eventId"],
          },
        },
        handler: (a) => this.getEvent(a),
      },
      {
        tool: {
          name: "search_events",
          description:
            "Search for events by text query across summary, description, location, and attendees.",
          inputSchema: {
            type: "object",
            properties: {
              calendarId: {
                type: "string",
                description: "Calendar ID (default: 'primary')",
              },
              query: {
                type: "string",
                description: "Free text search query",
              },
              timeMin: {
                type: "string",
                description: "Optional start of time range (ISO 8601)",
              },
              timeMax: {
                type: "string",
                description: "Optional end of time range (ISO 8601)",
              },
              maxResults: {
                type: "number",
                description: "Max events to return (default: 25)",
              },
              pageToken: { type: "string" },
              privateExtendedProperty: { type: "array", items: { type: "string" } },
              sharedExtendedProperty: { type: "array", items: { type: "string" } },
            },
            required: ["query"],
          },
        },
        handler: (a) => this.searchEvents(a),
      },
      {
        tool: {
          name: "create_event",
          description:
            "Create a new calendar event with title, time, location, description, attendees, Google Meet link, recurrence, reminders, and color.",
          inputSchema: {
            type: "object",
            properties: {
              calendarId: {
                type: "string",
                description: "Calendar ID (default: 'primary')",
              },
              summary: { type: "string", description: "Event title" },
              description: { type: "string", description: "Event description" },
              location: { type: "string", description: "Event location" },
              startDateTime: {
                type: "string",
                description:
                  "Start time (ISO 8601, e.g., '2025-03-15T10:00:00-07:00'). For all-day events use date format: '2025-03-15'.",
              },
              endDateTime: {
                type: "string",
                description:
                  "End time (ISO 8601). For all-day events use date format: '2025-03-16'.",
              },
              timeZone: {
                type: "string",
                description: "Timezone (e.g., 'America/New_York'). Uses calendar default if omitted.",
              },
              attendees: {
                type: "array",
                items: { type: "string" },
                description: "List of attendee email addresses",
              },
              addGoogleMeet: {
                type: "boolean",
                description: "Automatically create a Google Meet link (default: false)",
              },
              recurrence: {
                type: "array",
                items: { type: "string" },
                description:
                  "Recurrence rules (RRULE format). Example: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'] or ['RRULE:FREQ=DAILY;COUNT=5']",
              },
              reminders: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    method: {
                      type: "string",
                      enum: ["email", "popup"],
                      description: "Reminder method",
                    },
                    minutes: {
                      type: "number",
                      minimum: 0,
                      maximum: 40320,
                      description: "Minutes before the event",
                    },
                  },
                  required: ["method", "minutes"],
                },
                description:
                  "Custom reminders. Example: [{\"method\":\"popup\",\"minutes\":10}]",
              },
              colorId: {
                type: "string",
                description:
                  "Event color ID (normally 1-11; use list_calendar_colors for the current palette)",
              },
              eventLabelId: {
                type: "string",
                description:
                  "UUID of a custom label from get_calendar; supersedes colorId",
              },
              visibility: {
                type: "string",
                enum: ["default", "public", "private", "confidential"],
                description: "Event visibility",
              },
              transparency: {
                type: "string",
                enum: ["opaque", "transparent"],
                description: "Whether event blocks time (opaque=busy, transparent=available)",
              },
              sendUpdates: {
                type: "string",
                enum: ["all", "externalOnly", "none"],
                description: "Who receives invitations (default: none)",
              },
              privateExtendedProperties: {
                type: "object",
                additionalProperties: { type: "string" },
                description: "Private custom event metadata",
              },
              sharedExtendedProperties: {
                type: "object",
                additionalProperties: { type: "string" },
                description: "Shared custom event metadata",
              },
            },
            required: ["summary", "startDateTime", "endDateTime"],
          },
        },
        handler: (a) => this.createEvent(a),
      },
      {
        tool: {
          name: "update_event",
          description:
            "Update an existing calendar event. Only provide the fields you want to change.",
          inputSchema: {
            type: "object",
            properties: {
              calendarId: {
                type: "string",
                description: "Calendar ID (default: 'primary')",
              },
              eventId: { type: "string", description: "The event ID to update" },
              summary: { type: "string", description: "New event title" },
              description: { type: "string", description: "New description" },
              location: { type: "string", description: "New location" },
              startDateTime: { type: "string", description: "New start time (ISO 8601)" },
              endDateTime: { type: "string", description: "New end time (ISO 8601)" },
              timeZone: { type: "string", description: "Timezone" },
              attendees: {
                type: "array",
                items: { type: "string" },
                description: "Updated list of attendee emails (replaces existing)",
              },
              colorId: { type: "string", description: "Event color ID (1-11)" },
              eventLabelId: {
                type: "string",
                description:
                  "UUID of a custom label from get_calendar; supersedes colorId",
              },
              visibility: {
                type: "string",
                enum: ["default", "public", "private", "confidential"],
              },
              transparency: {
                type: "string",
                enum: ["opaque", "transparent"],
              },
              recurrence: { type: "array", items: { type: "string" } },
              reminders: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    method: { type: "string", enum: ["email", "popup"] },
                    minutes: { type: "number", minimum: 0, maximum: 40320 },
                  },
                  required: ["method", "minutes"],
                },
              },
              sendUpdates: {
                type: "string",
                enum: ["all", "externalOnly", "none"],
                description: "Who receives update notifications (default: none)",
              },
              privateExtendedProperties: {
                type: "object",
                additionalProperties: { type: "string" },
              },
              sharedExtendedProperties: {
                type: "object",
                additionalProperties: { type: "string" },
              },
              clearDescription: { type: "boolean" },
              clearLocation: { type: "boolean" },
              clearColor: { type: "boolean" },
              clearEventLabel: { type: "boolean" },
              clearAttendees: { type: "boolean" },
              clearRecurrence: { type: "boolean" },
              clearReminders: { type: "boolean" },
              clearConferenceData: { type: "boolean" },
              clearPrivateExtendedProperties: { type: "boolean" },
              clearSharedExtendedProperties: { type: "boolean" },
            },
            required: ["eventId"],
          },
        },
        handler: (a) => this.updateEvent(a),
      },
      {
        tool: {
          name: "delete_event",
          description: "Delete a calendar event.",
          inputSchema: {
            type: "object",
            properties: {
              calendarId: {
                type: "string",
                description: "Calendar ID (default: 'primary')",
              },
              eventId: { type: "string", description: "The event ID to delete" },
              sendUpdates: {
                type: "string",
                enum: ["all", "externalOnly", "none"],
                description: "Who to notify about deletion (default: 'all')",
              },
            },
            required: ["eventId"],
          },
        },
        handler: (a) => this.deleteEvent(a),
      },
      {
        tool: {
          name: "quick_add_event",
          description:
            "Create an event from a natural language string. Google parses it automatically. Examples: 'Lunch with Bob tomorrow at noon', 'Team standup every weekday at 9am'.",
          inputSchema: {
            type: "object",
            properties: {
              calendarId: {
                type: "string",
                description: "Calendar ID (default: 'primary')",
              },
              text: {
                type: "string",
                description:
                  "Natural language event description (e.g., 'Meeting with Alice on Friday 3pm-4pm at Coffee Shop')",
              },
              sendUpdates: {
                type: "string",
                enum: ["all", "externalOnly", "none"],
                description: "Who receives notifications (default: none)",
              },
            },
            required: ["text"],
          },
        },
        handler: (a) => this.quickAddEvent(a),
      },
      {
        tool: {
          name: "get_freebusy",
          description:
            "Check free/busy availability for one or more calendars within a time range. Useful for scheduling.",
          inputSchema: {
            type: "object",
            properties: {
              calendarIds: {
                type: "array",
                items: { type: "string" },
                description:
                  "List of calendar IDs to check (default: ['primary'])",
              },
              timeMin: {
                type: "string",
                description: "Start of time range (ISO 8601)",
              },
              timeMax: {
                type: "string",
                description: "End of time range (ISO 8601)",
              },
            },
            required: ["timeMin", "timeMax"],
          },
        },
        handler: (a) => this.getFreeBusy(a),
      },
      {
        tool: {
          name: "respond_to_event",
          description:
            "Respond to a calendar event invitation: accept, decline, or tentative.",
          inputSchema: {
            type: "object",
            properties: {
              calendarId: {
                type: "string",
                description: "Calendar ID (default: 'primary')",
              },
              eventId: { type: "string", description: "The event ID" },
              response: {
                type: "string",
                enum: ["accepted", "declined", "tentative"],
                description: "Your response to the invitation",
              },
              sendUpdates: {
                type: "string",
                enum: ["all", "externalOnly", "none"],
                description: "Who receives RSVP notifications (default: all)",
              },
            },
            required: ["eventId", "response"],
          },
        },
        handler: (a) => this.respondToEvent(a),
      },
      {
        tool: {
          name: "list_recurring_instances",
          description:
            "List all occurrences of a recurring event within an optional time range.",
          inputSchema: {
            type: "object",
            properties: {
              calendarId: {
                type: "string",
                description: "Calendar ID (default: 'primary')",
              },
              eventId: {
                type: "string",
                description: "The recurring event ID",
              },
              timeMin: {
                type: "string",
                description: "Optional start of range (ISO 8601)",
              },
              timeMax: {
                type: "string",
                description: "Optional end of range (ISO 8601)",
              },
              maxResults: {
                type: "number",
                description: "Max instances to return (default: 50)",
              },
              pageToken: { type: "string" },
            },
            required: ["eventId"],
          },
        },
        handler: (a) => this.listRecurringInstances(a),
      },
      {
        tool: {
          name: "move_event",
          description:
            "Move an event to a different calendar (changes the event's organizer).",
          inputSchema: {
            type: "object",
            properties: {
              calendarId: {
                type: "string",
                description: "Source calendar ID (default: 'primary')",
              },
              eventId: { type: "string", description: "The event ID to move" },
              destinationCalendarId: {
                type: "string",
                description: "Target calendar ID",
              },
              sendUpdates: {
                type: "string",
                enum: ["all", "externalOnly", "none"],
                description: "Who receives move notifications (default: none)",
              },
            },
            required: ["eventId", "destinationCalendarId"],
          },
        },
        handler: (a) => this.moveEvent(a),
      },
      {
        tool: {
          name: "create_calendar",
          description: "Create a new Google Calendar.",
          inputSchema: {
            type: "object",
            properties: {
              summary: { type: "string", description: "Name of the new calendar" },
              description: { type: "string", description: "Optional description" },
              timeZone: {
                type: "string",
                description: "Timezone (e.g., 'America/New_York'). Defaults to user's timezone.",
              },
            },
            required: ["summary"],
          },
        },
        handler: (a) => this.createCalendar(a),
      },
      {
        tool: {
          name: "delete_calendar",
          description:
            "Delete a secondary calendar. Cannot delete the primary calendar.",
          inputSchema: {
            type: "object",
            properties: {
              calendarId: {
                type: "string",
                description: "The ID of the calendar to delete (not 'primary')",
              },
            },
            required: ["calendarId"],
          },
        },
        handler: (a) => this.deleteCalendar(a),
      },
      {
        tool: {
          name: "get_calendar",
          description:
            "Get current metadata, settings, and custom event labels for a calendar.",
          inputSchema: {
            type: "object",
            properties: {
              calendarId: { type: "string", description: "Calendar ID (default: primary)" },
            },
          },
        },
        handler: (a) => this.getCalendar(a),
      },
      {
        tool: {
          name: "update_calendar_labels",
          description:
            "Replace a calendar's complete custom event-label list (maximum 200). Read current labels first with get_calendar to avoid dropping labels.",
          inputSchema: {
            type: "object",
            properties: {
              calendarId: { type: "string", description: "Calendar ID (default: primary)" },
              labels: {
                type: "array",
                maxItems: 200,
                items: {
                  type: "object",
                  properties: {
                    id: {
                      type: "string",
                      description: "UUID; omit for a new server-assigned label ID",
                    },
                    backgroundColor: {
                      type: "string",
                      pattern: "^#[0-9A-Fa-f]{6}$",
                    },
                    name: { type: "string", maxLength: 50 },
                  },
                  required: ["backgroundColor"],
                },
                description: "Complete replacement list; an empty array removes all labels",
              },
            },
            required: ["labels"],
          },
        },
        handler: (a) => this.updateCalendarLabels(a),
      },
      {
        tool: {
          name: "list_calendar_colors",
          description:
            "List the account's current event and calendar color palette instead of relying on hard-coded color names.",
          inputSchema: { type: "object", properties: {} },
        },
        handler: (a) => this.listCalendarColors(a),
      },
      {
        tool: {
          name: "suggest_time",
          description:
            "Find shared free slots across calendars inside an explicit time window.",
          inputSchema: {
            type: "object",
            properties: {
              calendarIds: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
                description: "Calendars that must all be free (default: primary)",
              },
              timeMin: { type: "string" },
              timeMax: { type: "string" },
              durationMinutes: { type: "number", minimum: 1, maximum: 10080 },
              bufferMinutes: {
                type: "number",
                minimum: 0,
                maximum: 1440,
                description: "Free time required before and after each busy period",
              },
              maxSuggestions: { type: "number", minimum: 1, maximum: 50 },
              slotStepMinutes: {
                type: "number",
                minimum: 1,
                maximum: 1440,
                description: "Distance between proposed starts (default: durationMinutes)",
              },
              timeZone: { type: "string", description: "Label the returned suggestions" },
            },
            required: ["timeMin", "timeMax", "durationMinutes"],
          },
        },
        handler: (a) => this.suggestTime(a),
      },
    ];
  }

  // ── Handlers ────────────────────────────────────────────

  private async listCalendars(args: Record<string, unknown>) {
    const maxResults = optionalInteger(args, "maxResults", 1, 250) ?? 100;
    const pageToken = optionalString(args, "pageToken");
    const showDeleted = optionalBoolean(args, "showDeleted") ?? false;
    const showHidden = optionalBoolean(args, "showHidden") ?? false;
    const showOwnOrganizationOnly =
      optionalBoolean(args, "showOwnOrganizationOnly") ?? false;
    const listParams: CalendarListParamsWithOrganization = {
      minAccessRole: "reader",
      maxResults,
      pageToken,
      showDeleted,
      showHidden,
      showOwnOrganizationOnly,
    };
    const response = await this.cal.calendarList.list(listParams);

    const calendars = response.data.items || [];
    const lines = calendars.map(
      (c) =>
        `- ${c.summary} (ID: ${c.id})\n  Access: ${c.accessRole}${c.primary ? " [PRIMARY]" : ""}${c.description ? `\n  Description: ${c.description}` : ""}`,
    );

    const next = response.data.nextPageToken
      ? `\n\nNext page token: ${response.data.nextPageToken}`
      : "";
    return textResponse(`Found ${calendars.length} calendars:\n\n${lines.join("\n\n")}${next}`);
  }

  private async listEvents(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    const maxResults = optionalInteger(args, "maxResults", 1, 2500) ?? 50;
    const showDeleted = optionalBoolean(args, "showDeleted") ?? false;
    const pageToken = optionalString(args, "pageToken");
    const timeZone = optionalString(args, "timeZone");
    validateTimeZone(timeZone);

    const now = new Date().toISOString();
    const timeMin = optionalString(args, "timeMin") || now;
    const timeMax = optionalString(args, "timeMax");
    validateOptionalTimeRange(timeMin, timeMax);

    const response = await this.cal.events.list({
      calendarId,
      timeMin,
      timeMax,
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
      showDeleted,
      pageToken,
      timeZone,
    });

    const events = response.data.items || [];
    if (events.length === 0) {
      return textResponse(
        "No events found in the specified time range." +
          (response.data.nextPageToken ? ` Next page token: ${response.data.nextPageToken}` : ""),
      );
    }

    const formatted = events.map((e) => this.fmtEvent(e)).join("\n\n");
    return textResponse(
      `Found ${events.length} events (${timeMin} to ${timeMax || "no upper bound"}):\n\n${formatted}` +
        (response.data.nextPageToken ? `\n\nNext page token: ${response.data.nextPageToken}` : ""),
    );
  }

  private async getEvent(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    const eventId = requireString(args, "eventId");

    const response = await this.cal.events.get({ calendarId, eventId });
    return textResponse(this.fmtEventFull(response.data));
  }

  private async searchEvents(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    const query = requireString(args, "query");
    const maxResults = optionalInteger(args, "maxResults", 1, 2500) ?? 25;
    const timeMin = optionalString(args, "timeMin");
    const timeMax = optionalString(args, "timeMax");
    const pageToken = optionalString(args, "pageToken");
    const privateExtendedProperty = args.privateExtendedProperty === undefined
      ? undefined
      : requireStringArray(args, "privateExtendedProperty", true);
    const sharedExtendedProperty = args.sharedExtendedProperty === undefined
      ? undefined
      : requireStringArray(args, "sharedExtendedProperty", true);
    validateOptionalTimeRange(timeMin, timeMax);

    const response = await this.cal.events.list({
      calendarId,
      q: query,
      timeMin,
      timeMax,
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
      pageToken,
      privateExtendedProperty,
      sharedExtendedProperty,
    });

    const events = response.data.items || [];
    if (events.length === 0) {
      return textResponse(
        `No events matching "${query}" found.` +
          (response.data.nextPageToken ? ` Next page token: ${response.data.nextPageToken}` : ""),
      );
    }

    const formatted = events.map((e) => this.fmtEvent(e)).join("\n\n");
    return textResponse(
      `Found ${events.length} events matching "${query}":\n\n${formatted}` +
        (response.data.nextPageToken ? `\n\nNext page token: ${response.data.nextPageToken}` : ""),
    );
  }

  private async createEvent(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    const summary = requireString(args, "summary");
    const description = optionalString(args, "description");
    const location = optionalString(args, "location");
    const startDateTime = requireString(args, "startDateTime");
    const endDateTime = requireString(args, "endDateTime");
    const timeZone = optionalString(args, "timeZone");
    validateTimeRange(startDateTime, endDateTime, "startDateTime", "endDateTime");
    validateTimeZone(timeZone);
    const attendees = args.attendees === undefined
      ? undefined
      : requireEmailArray(args, "attendees", true);
    const addGoogleMeet = optionalBoolean(args, "addGoogleMeet") ?? false;
    const recurrence = args.recurrence === undefined
      ? undefined
      : requireStringArray(args, "recurrence", true);
    let reminders: calendar_v3.Schema$EventReminder[] | undefined;
    if (args.reminders !== undefined) {
      if (!Array.isArray(args.reminders)) throw new Error("'reminders' must be an array");
      reminders = args.reminders.map((item, index) => {
        if (!isRecord(item)) throw new Error(`reminders[${index}] must be an object`);
        return {
          method: requireEnum(item, "method", ["email", "popup"] as const),
          minutes: requireInteger(item, "minutes", 0, 40320),
        };
      });
    }
    const colorId = optionalString(args, "colorId");
    const eventLabelId = optionalString(args, "eventLabelId");
    if (colorId && !/^(?:[1-9]|1[01])$/.test(colorId)) {
      throw new Error("'colorId' must be a current event color ID (normally 1-11; use list_calendar_colors)");
    }
    if (eventLabelId) requireUuid(eventLabelId, "eventLabelId");
    if (colorId && eventLabelId) {
      throw new Error("Specify 'colorId' or 'eventLabelId', not both; event labels supersede legacy colors");
    }
    const visibility = args.visibility === undefined
      ? undefined
      : requireEnum(args, "visibility", ["default", "public", "private", "confidential"] as const);
    const transparency = args.transparency === undefined
      ? undefined
      : requireEnum(args, "transparency", ["opaque", "transparent"] as const);
    const sendUpdates = requireEnum(
      args,
      "sendUpdates",
      ["all", "externalOnly", "none"] as const,
      "none",
    );
    const privateProperties = parseExtendedProperties(args, "privateExtendedProperties");
    const sharedProperties = parseExtendedProperties(args, "sharedExtendedProperties");

    const isAllDay = !startDateTime.includes("T");

    const event: EventWithLabel = {
      summary,
      description: description || undefined,
      location: location || undefined,
      start: isAllDay
        ? { date: startDateTime }
        : { dateTime: startDateTime, timeZone: timeZone || undefined },
      end: isAllDay
        ? { date: endDateTime }
        : { dateTime: endDateTime, timeZone: timeZone || undefined },
      attendees: attendees?.map((email) => ({ email })),
      recurrence: recurrence || undefined,
      colorId: colorId || undefined,
      eventLabelId: eventLabelId || undefined,
      visibility: visibility || undefined,
      transparency: transparency || undefined,
      extendedProperties:
        privateProperties || sharedProperties
          ? { private: privateProperties, shared: sharedProperties }
          : undefined,
    };

    if (reminders?.length) {
      event.reminders = { useDefault: false, overrides: reminders };
    }

    if (addGoogleMeet) {
      event.conferenceData = {
        createRequest: {
          requestId: `meet-${randomUUID()}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }

    const insertParams: EventInsertParamsWithLabels = {
      calendarId,
      requestBody: event,
      conferenceDataVersion: addGoogleMeet ? 1 : undefined,
      sendUpdates,
      eventLabelVersion: eventLabelId ? 1 : undefined,
    };
    const response = await this.cal.events.insert(insertParams);

    const created = response.data;
    let result = `Event created!\n${this.fmtEventFull(created)}`;
    if (created.hangoutLink) {
      result += `\nGoogle Meet: ${created.hangoutLink}`;
    }
    return textResponse(result);
  }

  private async updateEvent(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    const eventId = requireString(args, "eventId");
    const summary = optionalString(args, "summary");
    const description = optionalString(args, "description");
    const location = optionalString(args, "location");
    const startDateTime = optionalString(args, "startDateTime");
    const endDateTime = optionalString(args, "endDateTime");
    const timeZone = optionalString(args, "timeZone");
    validateTimeZone(timeZone);
    if (startDateTime && endDateTime) {
      validateTimeRange(startDateTime, endDateTime, "startDateTime", "endDateTime");
    } else {
      if (startDateTime) validateDateOrDateTime(startDateTime, "startDateTime");
      if (endDateTime) validateDateOrDateTime(endDateTime, "endDateTime");
    }
    const attendees = args.attendees === undefined
      ? undefined
      : requireEmailArray(args, "attendees", true);
    const colorId = optionalString(args, "colorId");
    const eventLabelId = optionalString(args, "eventLabelId");
    if (colorId && !/^(?:[1-9]|1[01])$/.test(colorId)) {
      throw new Error("'colorId' must be a current event color ID; use list_calendar_colors");
    }
    if (eventLabelId) requireUuid(eventLabelId, "eventLabelId");
    const clearEventLabel = optionalBoolean(args, "clearEventLabel") ?? false;
    if (clearEventLabel && eventLabelId) {
      throw new Error("Specify 'eventLabelId' or 'clearEventLabel', not both");
    }
    if (hasOwn(args, "colorId") && (hasOwn(args, "eventLabelId") || clearEventLabel)) {
      throw new Error("'colorId' cannot be changed in the same request as an event label");
    }
    const visibility = args.visibility === undefined
      ? undefined
      : requireEnum(args, "visibility", ["default", "public", "private", "confidential"] as const);
    const transparency = args.transparency === undefined
      ? undefined
      : requireEnum(args, "transparency", ["opaque", "transparent"] as const);
    const recurrence = args.recurrence === undefined
      ? undefined
      : requireStringArray(args, "recurrence", true);
    let reminders: calendar_v3.Schema$EventReminder[] | undefined;
    if (args.reminders !== undefined) {
      if (!Array.isArray(args.reminders)) throw new Error("'reminders' must be an array");
      reminders = args.reminders.map((item, index) => {
        if (!isRecord(item)) throw new Error(`reminders[${index}] must be an object`);
        return {
          method: requireEnum(item, "method", ["email", "popup"] as const),
          minutes: requireInteger(item, "minutes", 0, 40320),
        };
      });
    }
    const sendUpdates = requireEnum(
      args,
      "sendUpdates",
      ["all", "externalOnly", "none"] as const,
      "none",
    );
    const privateProperties = parseExtendedProperties(args, "privateExtendedProperties");
    const sharedProperties = parseExtendedProperties(args, "sharedExtendedProperties");

    const patch: EventWithLabel = {};

    if (hasOwn(args, "summary")) patch.summary = summary;
    if (hasOwn(args, "description")) patch.description = description;
    if (hasOwn(args, "location")) patch.location = location;
    if (hasOwn(args, "colorId")) patch.colorId = colorId;
    if (hasOwn(args, "eventLabelId")) patch.eventLabelId = eventLabelId || "";
    if (clearEventLabel) patch.eventLabelId = "";
    if (visibility) patch.visibility = visibility;
    if (transparency) patch.transparency = transparency;
    if (attendees !== undefined) patch.attendees = attendees.map((email) => ({ email }));
    if (recurrence !== undefined) patch.recurrence = recurrence;
    if (reminders !== undefined) {
      patch.reminders = reminders.length
        ? { useDefault: false, overrides: reminders }
        : { useDefault: true };
    }

    if (optionalBoolean(args, "clearDescription")) patch.description = null;
    if (optionalBoolean(args, "clearLocation")) patch.location = null;
    if (optionalBoolean(args, "clearColor")) patch.colorId = null;
    if (optionalBoolean(args, "clearAttendees")) patch.attendees = [];
    if (optionalBoolean(args, "clearRecurrence")) patch.recurrence = [];
    if (optionalBoolean(args, "clearReminders")) patch.reminders = { useDefault: true };
    if (optionalBoolean(args, "clearConferenceData")) {
      patch.conferenceData = null as unknown as calendar_v3.Schema$ConferenceData;
    }
    if (
      privateProperties !== undefined || sharedProperties !== undefined ||
      optionalBoolean(args, "clearPrivateExtendedProperties") ||
      optionalBoolean(args, "clearSharedExtendedProperties")
    ) {
      patch.extendedProperties = {
        private: optionalBoolean(args, "clearPrivateExtendedProperties") ? {} : privateProperties,
        shared: optionalBoolean(args, "clearSharedExtendedProperties") ? {} : sharedProperties,
      };
    }

    if (startDateTime) {
      const isAllDay = !startDateTime.includes("T");
      patch.start = isAllDay
        ? { date: startDateTime }
        : { dateTime: startDateTime, timeZone: timeZone || undefined };
    }
    if (endDateTime) {
      const isAllDay = !endDateTime.includes("T");
      patch.end = isAllDay
        ? { date: endDateTime }
        : { dateTime: endDateTime, timeZone: timeZone || undefined };
    }

    if (Object.keys(patch).length === 0) {
      throw new Error("No event fields or clear operations were provided");
    }

    const patchParams: EventPatchParamsWithLabels = {
      calendarId,
      eventId,
      requestBody: patch,
      sendUpdates,
      conferenceDataVersion: optionalBoolean(args, "clearConferenceData") ? 1 : undefined,
      eventLabelVersion: hasOwn(args, "eventLabelId") || clearEventLabel ? 1 : undefined,
    };
    const response = await this.cal.events.patch(patchParams);

    return textResponse(`Event updated!\n${this.fmtEventFull(response.data)}`);
  }

  private async deleteEvent(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    const eventId = requireString(args, "eventId");
    const sendUpdates = requireEnum(
      args,
      "sendUpdates",
      ["all", "externalOnly", "none"] as const,
      "all",
    );

    await this.cal.events.delete({
      calendarId,
      eventId,
      sendUpdates,
    });

    return textResponse(`Event ${eventId} deleted.`);
  }

  private async quickAddEvent(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    const text = requireString(args, "text");
    const sendUpdates = requireEnum(
      args,
      "sendUpdates",
      ["all", "externalOnly", "none"] as const,
      "none",
    );

    const response = await this.cal.events.quickAdd({
      calendarId,
      text,
      sendUpdates,
    });

    return textResponse(
      `Event created from text!\n${this.fmtEventFull(response.data)}`,
    );
  }

  private async getFreeBusy(args: Record<string, unknown>) {
    const calendarIds = args.calendarIds === undefined
      ? ["primary"]
      : requireStringArray(args, "calendarIds");
    if (calendarIds.length > 50) throw new Error("At most 50 calendarIds are supported");
    const timeMin = requireString(args, "timeMin");
    const timeMax = requireString(args, "timeMax");
    validateOptionalTimeRange(timeMin, timeMax);

    const response = await this.cal.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        items: calendarIds.map((id) => ({ id })),
      },
    });

    const calendars = response.data.calendars || {};
    const lines: string[] = [];

    for (const [calId, info] of Object.entries(calendars)) {
      const busy = (info as { busy?: Array<{ start?: string; end?: string }> })
        .busy || [];
      if (busy.length === 0) {
        lines.push(`${calId}: Free for entire range`);
      } else {
        lines.push(`${calId}: ${busy.length} busy period(s)`);
        for (const b of busy) {
          lines.push(`  - ${b.start} to ${b.end}`);
        }
      }
    }

    return textResponse(
      `Free/Busy (${timeMin} to ${timeMax}):\n\n${lines.join("\n")}`,
    );
  }

  private async respondToEvent(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    const eventId = requireString(args, "eventId");
    const attendeeResponse = requireEnum(
      args,
      "response",
      ["accepted", "declined", "tentative"] as const,
    );
    const sendUpdates = requireEnum(
      args,
      "sendUpdates",
      ["all", "externalOnly", "none"] as const,
      "all",
    );

    for (let attempt = 0; attempt < 2; attempt++) {
      const event = await this.cal.events.get({
        calendarId,
        eventId,
        fields: "id,summary,attendees,etag",
      });
      const attendees = (event.data.attendees || []).map((attendee) => ({ ...attendee }));
      const self = attendees.find((attendee) => attendee.self);
      if (!self) {
        return textResponse(
          "Could not find your attendee entry in this event. You may not be invited to it.",
        );
      }
      self.responseStatus = attendeeResponse;
      try {
        await this.cal.events.patch(
          {
            calendarId,
            eventId,
            requestBody: { attendees },
            sendUpdates,
          },
          { headers: event.data.etag ? { "If-Match": event.data.etag } : undefined },
        );
        return textResponse(
          `Responded "${attendeeResponse}" to event "${event.data.summary}".`,
        );
      } catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status;
        if (status !== 412 || attempt === 1) throw error;
      }
    }
    throw new Error("Event changed concurrently; retry the response");
  }

  private async listRecurringInstances(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    const eventId = requireString(args, "eventId");
    const maxResults = optionalInteger(args, "maxResults", 1, 2500) ?? 50;
    const timeMin = optionalString(args, "timeMin");
    const timeMax = optionalString(args, "timeMax");
    const pageToken = optionalString(args, "pageToken");
    validateOptionalTimeRange(timeMin, timeMax);

    const resp = await this.cal.events.instances({
      calendarId,
      eventId,
      timeMin,
      timeMax,
      maxResults,
      pageToken,
    });

    const instances = resp.data.items || [];
    if (instances.length === 0) {
      return textResponse("No instances found in the specified range.");
    }

    const formatted = instances.map((e) => this.fmtEvent(e)).join("\n\n");
    return textResponse(
      `Found ${instances.length} instances:\n\n${formatted}` +
        (resp.data.nextPageToken ? `\n\nNext page token: ${resp.data.nextPageToken}` : ""),
    );
  }

  private async moveEvent(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    const eventId = requireString(args, "eventId");
    const destinationCalendarId = requireString(
      args,
      "destinationCalendarId",
    );
    const sendUpdates = requireEnum(
      args,
      "sendUpdates",
      ["all", "externalOnly", "none"] as const,
      "none",
    );

    const response = await this.cal.events.move({
      calendarId,
      eventId,
      destination: destinationCalendarId,
      sendUpdates,
    });

    return textResponse(
      `Event moved to calendar "${destinationCalendarId}".\n${this.fmtEventFull(response.data)}`,
    );
  }

  private async createCalendar(args: Record<string, unknown>) {
    const summary = requireString(args, "summary");
    const description = optionalString(args, "description");
    const timeZone = optionalString(args, "timeZone");
    validateTimeZone(timeZone);

    const response = await this.cal.calendars.insert({
      requestBody: {
        summary,
        description: description || undefined,
        timeZone: timeZone || undefined,
      },
    });

    return textResponse(
      `Calendar created!\nName: ${response.data.summary}\nID: ${response.data.id}`,
    );
  }

  private async deleteCalendar(args: Record<string, unknown>) {
    const calendarId = requireString(args, "calendarId");

    if (calendarId === "primary") {
      throw new Error("Cannot delete the primary calendar.");
    }

    await this.cal.calendars.delete({ calendarId });
    return textResponse(`Calendar "${calendarId}" deleted.`);
  }

  private async getCalendar(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    const response = await this.cal.calendars.get({ calendarId });
    return textResponse(JSON.stringify(response.data, null, 2));
  }

  private async updateCalendarLabels(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    if (!Array.isArray(args.labels)) {
      throw new Error("'labels' is required and must be an array");
    }
    if (args.labels.length > 200) {
      throw new Error("A calendar can have at most 200 event labels");
    }
    const labels: CalendarEventLabel[] = args.labels.map((item, index) => {
      if (!isRecord(item)) throw new Error(`labels[${index}] must be an object`);
      const backgroundColor = requireString(item, "backgroundColor");
      if (!/^#[0-9a-f]{6}$/i.test(backgroundColor)) {
        throw new Error(`labels[${index}].backgroundColor must be a 6-digit hex color`);
      }
      const id = optionalString(item, "id");
      if (id) requireUuid(id, `labels[${index}].id`);
      const name = optionalString(item, "name");
      if (name !== undefined && name.length > 50) {
        throw new Error(`labels[${index}].name must be at most 50 characters`);
      }
      return { id, backgroundColor, name };
    });
    const requestBody: CalendarWithLabels = {
      labelProperties: { eventLabels: labels },
    };
    const response = await this.cal.calendars.patch({ calendarId, requestBody });
    return textResponse(JSON.stringify(response.data as CalendarWithLabels, null, 2));
  }

  private async listCalendarColors(_args: Record<string, unknown>) {
    const response = await this.cal.colors.get();
    return textResponse(JSON.stringify({
      updated: response.data.updated,
      event: response.data.event || {},
      calendar: response.data.calendar || {},
    }, null, 2));
  }

  private async suggestTime(args: Record<string, unknown>) {
    const calendarIds = args.calendarIds === undefined
      ? ["primary"]
      : requireStringArray(args, "calendarIds");
    if (calendarIds.length > 50) throw new Error("At most 50 calendarIds are supported");
    const timeMin = requireString(args, "timeMin");
    const timeMax = requireString(args, "timeMax");
    validateOptionalTimeRange(timeMin, timeMax);
    const durationMinutes = requireInteger(args, "durationMinutes", 1, 10080);
    const bufferMinutes = optionalInteger(args, "bufferMinutes", 0, 1440) ?? 0;
    const maxSuggestions = optionalInteger(args, "maxSuggestions", 1, 50) ?? 10;
    const slotStepMinutes = optionalInteger(args, "slotStepMinutes", 1, 1440) ?? durationMinutes;
    const timeZone = optionalString(args, "timeZone");
    validateTimeZone(timeZone);

    const response = await this.cal.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone,
        items: calendarIds.map((id) => ({ id })),
      },
    });
    const errors: Array<{ calendarId: string; errors: unknown }> = [];
    const bufferMs = bufferMinutes * 60_000;
    const rangeStart = Date.parse(timeMin);
    const rangeEnd = Date.parse(timeMax);
    const busy: Array<{ start: number; end: number }> = [];
    for (const [calendarId, info] of Object.entries(response.data.calendars || {})) {
      if (info.errors?.length) errors.push({ calendarId, errors: info.errors });
      for (const period of info.busy || []) {
        if (!period.start || !period.end) continue;
        busy.push({
          start: Math.max(rangeStart, Date.parse(period.start) - bufferMs),
          end: Math.min(rangeEnd, Date.parse(period.end) + bufferMs),
        });
      }
    }
    if (errors.length) {
      throw new Error("Free/busy lookup failed: " + JSON.stringify(errors));
    }
    busy.sort((left, right) => left.start - right.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const period of busy) {
      const previous = merged[merged.length - 1];
      if (previous && period.start <= previous.end) {
        previous.end = Math.max(previous.end, period.end);
      } else if (period.end > period.start) {
        merged.push({ ...period });
      }
    }

    const durationMs = durationMinutes * 60_000;
    const stepMs = slotStepMinutes * 60_000;
    const suggestions: Array<{ start: string; end: string }> = [];
    const addGap = (start: number, end: number): void => {
      for (
        let candidate = start;
        candidate + durationMs <= end && suggestions.length < maxSuggestions;
        candidate += stepMs
      ) {
        suggestions.push({
          start: new Date(candidate).toISOString(),
          end: new Date(candidate + durationMs).toISOString(),
        });
      }
    };
    let cursor = rangeStart;
    for (const period of merged) {
      addGap(cursor, period.start);
      if (suggestions.length >= maxSuggestions) break;
      cursor = Math.max(cursor, period.end);
    }
    if (suggestions.length < maxSuggestions) addGap(cursor, rangeEnd);

    return textResponse(JSON.stringify({
      calendarIds,
      timeMin,
      timeMax,
      durationMinutes,
      bufferMinutes,
      timeZone: timeZone || "UTC",
      suggestions,
    }, null, 2));
  }
}
