import type { GwsClient } from "../gws-client.js";
import {
  jsonResponse,
  deleteResponse,
  stripHtml,
  truncate,
} from "./response.js";

interface RawAttendee {
  email?: string;
  self?: boolean;
  responseStatus?: string;
  resource?: boolean;
}

interface RawEvent {
  id?: string;
  summary?: string;
  status?: string;
  description?: string;
  location?: string;
  start?: unknown;
  end?: unknown;
  organizer?: { email?: string };
  attendees?: RawAttendee[];
  hangoutLink?: string;
  eventType?: string;
}

/** Bound on raw description size fed to the tag-stripper, so its regex
 * passes stay O(cap) on pathological multi-KB HTML blobs instead of
 * scanning the whole thing only to throw 99% away at truncation. */
const STRIP_INPUT_CAP = 10_000;

/** Calendar descriptions are free-form: plain text from humans, HTML from
 * Zoom/marketing/scheduling tools. Only run the tag-stripper when the text
 * actually looks like markup, so "a < b" in a human note survives. */
function descriptionText(description: string, maxChars: number): string {
  const capped =
    description.length > STRIP_INPUT_CAP
      ? // Drop any partial tag the cut leaves dangling, so the tag-strip
        // regex (which needs a closing ">") doesn't leak it as text.
        description.slice(0, STRIP_INPUT_CAP).replace(/<[^>]*$/, "")
      : description;
  const text = /<\/?[a-z][^>]*>/i.test(capped)
    ? stripHtml(capped)
    : capped.trim();
  return truncate(text, maxChars);
}

/** Compact per-event shape for the default calendar_list_events view.
 * Keeps what agenda/triage consumers use; drops the bloat that blows
 * response limits on busy calendars (full attendee rosters, reminders,
 * conferenceData, htmlLink). Room resources don't count as attendees. */
function compactEvent(event: RawEvent, maxDescriptionChars: number) {
  const out: Record<string, unknown> = {
    id: event.id,
    summary: event.summary,
    start: event.start,
    end: event.end,
  };
  if (event.status && event.status !== "confirmed") out.status = event.status;
  if (event.eventType && event.eventType !== "default") {
    out.event_type = event.eventType;
  }
  if (event.location) out.location = event.location;
  if (event.description && maxDescriptionChars !== 0) {
    const text = descriptionText(event.description, maxDescriptionChars);
    if (text) out.description = text;
  }
  if (event.organizer?.email) out.organizer = event.organizer.email;
  const attendees = (event.attendees ?? []).filter((a) => !a.resource);
  if (attendees.length > 0) {
    out.attendee_count = attendees.length;
    const self = attendees.find((a) => a.self);
    if (self?.responseStatus) out.my_response = self.responseStatus;
  }
  if (event.hangoutLink) out.meet_link = event.hangoutLink;
  return out;
}

export const calendarTools = [
  {
    name: "calendar_list_events",
    description:
      "List upcoming events from a Google Calendar. By default returns a compact view per event — id, title, start/end, location, plain-text description (HTML stripped, truncated), organizer email, attendee count plus your own response status, and Meet link — which keeps busy calendars well within response limits. Use full for the raw Calendar API payload, or calendar_get_event for one event's complete detail.",
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
        full: {
          type: "boolean",
          description:
            "Return the raw Calendar API response instead of the compact view: full attendee rosters, reminders, conferenceData, htmlLink, and original (often HTML) descriptions. On busy calendars this can be very large — prefer the default compact view for triage and agenda use.",
        },
        max_description_chars: {
          type: "number",
          description:
            "In the compact view, truncate each event's plain-text description to this many characters (default: 500; adds a truncation marker). Set to 0 to omit descriptions entirely. Ignored when full is true.",
        },
      },
      required: [] as string[],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "calendar_get_event",
    description:
      "Get details of a specific calendar event by its event ID. Returns the full event (all attendees, reminders, conference data), with the description converted to plain text; use full for the original (often HTML) description.",
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
        full: {
          type: "boolean",
          description:
            "Keep the description exactly as stored (often multi-KB HTML from Zoom/scheduling tools) instead of converting it to plain text.",
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
      if (args.full) return jsonResponse(result.data);

      const data = result.data as {
        summary?: string;
        timeZone?: string;
        nextPageToken?: string;
        items?: RawEvent[];
      };
      const maxDescriptionChars =
        (args.max_description_chars as number | undefined) ?? 500;
      const compact: Record<string, unknown> = {
        calendar: data.summary,
        timeZone: data.timeZone,
        events: (data.items ?? []).map((e) =>
          compactEvent(e, maxDescriptionChars)
        ),
      };
      if (data.nextPageToken) compact.nextPageToken = data.nextPageToken;
      return jsonResponse(compact);
    }

    case "calendar_get_event": {
      const result = await client.api("calendar", "events", "get", {
        params: { calendarId, eventId: args.event_id },
      });
      const event = result.data as RawEvent;
      if (!args.full && event?.description) {
        // Single-event detail keeps everything else raw; only the
        // description gets the HTML→text treatment (untruncated).
        event.description = descriptionText(event.description, Infinity);
      }
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
      await client.api("calendar", "events", "delete", {
        params: {
          calendarId,
          eventId: args.event_id,
          sendUpdates: (args.send_updates as string) || "all",
        },
      });
      return deleteResponse("Event");
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
