import type { GwsClient } from "../gws-client.js";
import { jsonResponse, deleteResponse } from "./response.js";

export const calendarTools = [
  {
    name: "calendar_list_events",
    description:
      "List upcoming events from a Google Calendar. Returns event titles, times, attendees, and meeting links.",
    inputSchema: {
      type: "object" as const,
      properties: {
        calendar_id: {
          type: "string",
          description:
            "Calendar ID (default: \"primary\" for the user's main calendar)",
        },
        time_min: {
          type: "string",
          description:
            "Start of time range (ISO 8601, e.g., \"2024-06-01T00:00:00Z\"). Defaults to now.",
        },
        time_max: {
          type: "string",
          description:
            "End of time range (ISO 8601, e.g., \"2024-06-30T23:59:59Z\"). Defaults to 7 days from now.",
        },
        max_results: {
          type: "number",
          description: "Maximum number of events to return (default: 20)",
        },
        query: {
          type: "string",
          description: "Free-text search query to filter events",
        },
      },
      required: [] as string[],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "calendar_get_event",
    description:
      "Get details of a specific calendar event by its event ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        event_id: {
          type: "string",
          description: "The calendar event ID",
        },
        calendar_id: {
          type: "string",
          description: "Calendar ID (default: \"primary\")",
        },
      },
      required: ["event_id"],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "calendar_create_event",
    description:
      "Create a new calendar event. Supports setting title, time, attendees, description, location, and Google Meet links.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string",
          description: "Event title",
        },
        start: {
          type: "string",
          description:
            "Start time in ISO 8601 format (e.g., \"2024-06-15T14:00:00-07:00\")",
        },
        end: {
          type: "string",
          description:
            "End time in ISO 8601 format (e.g., \"2024-06-15T15:00:00-07:00\")",
        },
        attendees: {
          type: "string",
          description:
            "Comma-separated email addresses of attendees",
        },
        description: {
          type: "string",
          description: "Event description or agenda",
        },
        location: {
          type: "string",
          description: "Event location (physical address or room name)",
        },
        add_meet: {
          type: "boolean",
          description:
            "Attach a Google Meet video conference link to the event (default: false)",
        },
        calendar_id: {
          type: "string",
          description: "Calendar ID (default: \"primary\")",
        },
        send_updates: {
          type: "string",
          enum: ["all", "externalOnly", "none"],
          description:
            "Who to send invite notifications to (default: \"all\")",
        },
      },
      required: ["summary", "start", "end"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "calendar_update_event",
    description:
      "Update an existing calendar event. Only provided fields are changed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        event_id: {
          type: "string",
          description: "The calendar event ID to update",
        },
        summary: {
          type: "string",
          description: "New event title",
        },
        start: {
          type: "string",
          description: "New start time (ISO 8601)",
        },
        end: {
          type: "string",
          description: "New end time (ISO 8601)",
        },
        attendees: {
          type: "string",
          description: "Comma-separated email addresses (replaces existing attendees)",
        },
        description: {
          type: "string",
          description: "New event description",
        },
        location: {
          type: "string",
          description: "New event location",
        },
        calendar_id: {
          type: "string",
          description: "Calendar ID (default: \"primary\")",
        },
        send_updates: {
          type: "string",
          enum: ["all", "externalOnly", "none"],
          description: "Who to send update notifications to (default: \"all\")",
        },
      },
      required: ["event_id"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "calendar_delete_event",
    description: "Delete a calendar event by its event ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        event_id: {
          type: "string",
          description: "The calendar event ID to delete",
        },
        calendar_id: {
          type: "string",
          description: "Calendar ID (default: \"primary\")",
        },
        send_updates: {
          type: "string",
          enum: ["all", "externalOnly", "none"],
          description:
            "Who to send cancellation notifications to (default: \"all\")",
        },
      },
      required: ["event_id"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "calendar_freebusy",
    description:
      "Check availability (free/busy) for one or more people over a time range. Useful for finding open slots to schedule meetings.",
    inputSchema: {
      type: "object" as const,
      properties: {
        time_min: {
          type: "string",
          description: "Start of the time range to check (ISO 8601)",
        },
        time_max: {
          type: "string",
          description: "End of the time range to check (ISO 8601)",
        },
        emails: {
          type: "string",
          description:
            "Comma-separated email addresses to check availability for",
        },
      },
      required: ["time_min", "time_max", "emails"],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
];

function buildEventBody(args: Record<string, unknown>) {
  const body: Record<string, unknown> = {};

  if (args.summary) body.summary = args.summary;
  if (args.description) body.description = args.description;
  if (args.location) body.location = args.location;

  if (args.start) {
    body.start = { dateTime: args.start };
  }
  if (args.end) {
    body.end = { dateTime: args.end };
  }

  if (args.attendees) {
    body.attendees = (args.attendees as string)
      .split(",")
      .map((e) => ({ email: e.trim() }));
  }

  if (args.add_meet) {
    body.conferenceData = {
      createRequest: {
        requestId: `meet-${Date.now()}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  return body;
}

export async function handleCalendar(
  client: GwsClient,
  toolName: string,
  args: Record<string, unknown>
) {
  const calendarId = (args.calendar_id as string) || "primary";

  switch (toolName) {
    case "calendar_list_events": {
      const nowMs = Date.now();
      const params: Record<string, unknown> = {
        calendarId,
        timeMin: (args.time_min as string) || new Date(nowMs).toISOString(),
        timeMax:
          (args.time_max as string) ||
          new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString(),
        maxResults: (args.max_results as number) || 20,
        singleEvents: true,
        orderBy: "startTime",
      };
      if (args.query) params.q = args.query;

      const result = await client.api("calendar", "events", "list", {
        params,
      });
      return jsonResponse(result.data);
    }

    case "calendar_get_event": {
      const result = await client.api("calendar", "events", "get", {
        params: { calendarId, eventId: args.event_id },
      });
      return jsonResponse(result.data);
    }

    case "calendar_create_event": {
      const params: Record<string, unknown> = {
        calendarId,
        sendUpdates: (args.send_updates as string) || "all",
      };
      if (args.add_meet) {
        params.conferenceDataVersion = 1;
      }

      const result = await client.api("calendar", "events", "insert", {
        params,
        jsonBody: buildEventBody(args),
      });
      return jsonResponse(result.data);
    }

    case "calendar_update_event": {
      const result = await client.api("calendar", "events", "patch", {
        params: {
          calendarId,
          eventId: args.event_id,
          sendUpdates: (args.send_updates as string) || "all",
        },
        jsonBody: buildEventBody(args),
      });
      return jsonResponse(result.data);
    }

    case "calendar_delete_event": {
      const result = await client.api("calendar", "events", "delete", {
        params: {
          calendarId,
          eventId: args.event_id,
          sendUpdates: (args.send_updates as string) || "all",
        },
      });
      return deleteResponse(result, "Event");
    }

    case "calendar_freebusy": {
      const items = (args.emails as string)
        .split(",")
        .map((e) => ({ id: e.trim() }));

      const result = await client.api("calendar", "freebusy", "query", {
        jsonBody: {
          timeMin: args.time_min,
          timeMax: args.time_max,
          items,
        },
      });
      return jsonResponse(result.data);
    }

    default:
      throw new Error(`Unknown Calendar tool: ${toolName}`);
  }
}
