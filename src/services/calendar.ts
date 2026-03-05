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
          inputSchema: { type: "object", properties: {} },
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
                  "End of time range (ISO 8601). Defaults to 7 days from now.",
              },
              maxResults: {
                type: "number",
                description: "Max events to return (default: 50, max: 2500)",
              },
              showDeleted: {
                type: "boolean",
                description: "Include deleted/cancelled events (default: false)",
              },
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
                description: "Start of time range (ISO 8601). Defaults to now.",
              },
              timeMax: {
                type: "string",
                description: "End of time range (ISO 8601). Defaults to 30 days from now.",
              },
              maxResults: {
                type: "number",
                description: "Max events to return (default: 25)",
              },
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
                      description: "Minutes before the event",
                    },
                  },
                },
                description:
                  "Custom reminders. Example: [{\"method\":\"popup\",\"minutes\":10}]",
              },
              colorId: {
                type: "string",
                description:
                  "Event color ID (1-11). 1=Lavender, 2=Sage, 3=Grape, 4=Flamingo, 5=Banana, 6=Tangerine, 7=Peacock, 8=Graphite, 9=Blueberry, 10=Basil, 11=Tomato",
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
              visibility: {
                type: "string",
                enum: ["default", "public", "private", "confidential"],
              },
              transparency: {
                type: "string",
                enum: ["opaque", "transparent"],
              },
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
                description: "Start of range (ISO 8601). Defaults to now.",
              },
              timeMax: {
                type: "string",
                description: "End of range (ISO 8601). Defaults to 90 days from now.",
              },
              maxResults: {
                type: "number",
                description: "Max instances to return (default: 50)",
              },
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
    ];
  }

  // ── Handlers ────────────────────────────────────────────

  private async listCalendars(_args: Record<string, unknown>) {
    const response = await this.cal.calendarList.list({
      minAccessRole: "reader",
    });

    const calendars = response.data.items || [];
    const lines = calendars.map(
      (c) =>
        `- ${c.summary} (ID: ${c.id})\n  Access: ${c.accessRole}${c.primary ? " [PRIMARY]" : ""}${c.description ? `\n  Description: ${c.description}` : ""}`,
    );

    return textResponse(
      `Found ${calendars.length} calendars:\n\n${lines.join("\n\n")}`,
    );
  }

  private async listEvents(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    const maxResults = optionalNumber(args, "maxResults") || 50;
    const showDeleted = optionalBoolean(args, "showDeleted") || false;

    const now = new Date().toISOString();
    const weekFromNow = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const timeMin = optionalString(args, "timeMin") || now;
    const timeMax = optionalString(args, "timeMax") || weekFromNow;

    const response = await this.cal.events.list({
      calendarId,
      timeMin,
      timeMax,
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
      showDeleted,
    });

    const events = response.data.items || [];
    if (events.length === 0) {
      return textResponse("No events found in the specified time range.");
    }

    const formatted = events.map((e) => this.fmtEvent(e)).join("\n\n");
    return textResponse(
      `Found ${events.length} events (${timeMin} to ${timeMax}):\n\n${formatted}`,
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
    const maxResults = optionalNumber(args, "maxResults") || 25;

    const now = new Date().toISOString();
    const monthFromNow = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const timeMin = optionalString(args, "timeMin") || now;
    const timeMax = optionalString(args, "timeMax") || monthFromNow;

    const response = await this.cal.events.list({
      calendarId,
      q: query,
      timeMin,
      timeMax,
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = response.data.items || [];
    if (events.length === 0) {
      return textResponse(`No events matching "${query}" found.`);
    }

    const formatted = events.map((e) => this.fmtEvent(e)).join("\n\n");
    return textResponse(
      `Found ${events.length} events matching "${query}":\n\n${formatted}`,
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
    const attendees = args.attendees as string[] | undefined;
    const addGoogleMeet = optionalBoolean(args, "addGoogleMeet") || false;
    const recurrence = args.recurrence as string[] | undefined;
    const reminders = args.reminders as
      | Array<{ method: string; minutes: number }>
      | undefined;
    const colorId = optionalString(args, "colorId");
    const visibility = optionalString(args, "visibility");
    const transparency = optionalString(args, "transparency");

    const isAllDay = !startDateTime.includes("T");

    const event: calendar_v3.Schema$Event = {
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
      visibility: visibility || undefined,
      transparency: transparency || undefined,
    };

    if (reminders?.length) {
      event.reminders = { useDefault: false, overrides: reminders };
    }

    if (addGoogleMeet) {
      event.conferenceData = {
        createRequest: {
          requestId: `meet-${Date.now()}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }

    const response = await this.cal.events.insert({
      calendarId,
      requestBody: event,
      conferenceDataVersion: addGoogleMeet ? 1 : undefined,
      sendUpdates: attendees?.length ? "all" : "none",
    });

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
    const attendees = args.attendees as string[] | undefined;
    const colorId = optionalString(args, "colorId");
    const visibility = optionalString(args, "visibility");
    const transparency = optionalString(args, "transparency");

    const patch: calendar_v3.Schema$Event = {};

    if (summary) patch.summary = summary;
    if (description) patch.description = description;
    if (location) patch.location = location;
    if (colorId) patch.colorId = colorId;
    if (visibility) patch.visibility = visibility;
    if (transparency) patch.transparency = transparency;
    if (attendees) patch.attendees = attendees.map((email) => ({ email }));

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

    const response = await this.cal.events.patch({
      calendarId,
      eventId,
      requestBody: patch,
      sendUpdates: attendees ? "all" : "none",
    });

    return textResponse(`Event updated!\n${this.fmtEventFull(response.data)}`);
  }

  private async deleteEvent(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    const eventId = requireString(args, "eventId");
    const sendUpdates = optionalString(args, "sendUpdates") || "all";

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

    const response = await this.cal.events.quickAdd({
      calendarId,
      text,
    });

    return textResponse(
      `Event created from text!\n${this.fmtEventFull(response.data)}`,
    );
  }

  private async getFreeBusy(args: Record<string, unknown>) {
    const calendarIds = (args.calendarIds as string[] | undefined) || [
      "primary",
    ];
    const timeMin = requireString(args, "timeMin");
    const timeMax = requireString(args, "timeMax");

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
    const response = requireString(args, "response");

    // Get current event to find our attendee entry
    const event = await this.cal.events.get({ calendarId, eventId });
    const attendees = event.data.attendees || [];

    // Find self in attendees and update response
    let found = false;
    for (const a of attendees) {
      if (a.self) {
        a.responseStatus = response;
        found = true;
        break;
      }
    }

    if (!found) {
      return textResponse(
        "Could not find your attendee entry in this event. You may not be invited to this event.",
      );
    }

    await this.cal.events.patch({
      calendarId,
      eventId,
      requestBody: { attendees },
      sendUpdates: "all",
    });

    return textResponse(
      `Responded "${response}" to event "${event.data.summary}".`,
    );
  }

  private async listRecurringInstances(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    const eventId = requireString(args, "eventId");
    const maxResults = optionalNumber(args, "maxResults") || 50;

    const now = new Date().toISOString();
    const ninetyDays = new Date(
      Date.now() + 90 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const timeMin = optionalString(args, "timeMin") || now;
    const timeMax = optionalString(args, "timeMax") || ninetyDays;

    const resp = await this.cal.events.instances({
      calendarId,
      eventId,
      timeMin,
      timeMax,
      maxResults,
    });

    const instances = resp.data.items || [];
    if (instances.length === 0) {
      return textResponse("No instances found in the specified range.");
    }

    const formatted = instances.map((e) => this.fmtEvent(e)).join("\n\n");
    return textResponse(
      `Found ${instances.length} instances:\n\n${formatted}`,
    );
  }

  private async moveEvent(args: Record<string, unknown>) {
    const calendarId = optionalString(args, "calendarId") || "primary";
    const eventId = requireString(args, "eventId");
    const destinationCalendarId = requireString(
      args,
      "destinationCalendarId",
    );

    const response = await this.cal.events.move({
      calendarId,
      eventId,
      destination: destinationCalendarId,
    });

    return textResponse(
      `Event moved to calendar "${destinationCalendarId}".\n${this.fmtEventFull(response.data)}`,
    );
  }

  private async createCalendar(args: Record<string, unknown>) {
    const summary = requireString(args, "summary");
    const description = optionalString(args, "description");
    const timeZone = optionalString(args, "timeZone");

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
}
