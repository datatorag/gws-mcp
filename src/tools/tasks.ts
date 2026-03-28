import type { GwsClient } from "../gws-client.js";
import { jsonResponse, deleteResponse } from "./response.js";

export const tasksTools = [
  {
    name: "tasks_list",
    description: "List all task lists for the authenticated user.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "tasks_list_tasks",
    description:
      "List tasks in a specific task list. Returns task titles, statuses, due dates, and notes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tasklist_id: {
          type: "string",
          description:
            "The task list ID (use tasks_list to find IDs, or '@default' for the default list)",
        },
        show_completed: {
          type: "boolean",
          description: "Include completed tasks (default: true)",
        },
        show_hidden: {
          type: "boolean",
          description: "Include hidden/deleted tasks (default: false)",
        },
      },
      required: ["tasklist_id"],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "tasks_create",
    description: "Create a new task in a task list.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tasklist_id: {
          type: "string",
          description: "The task list ID (or '@default' for the default list)",
        },
        title: {
          type: "string",
          description: "Title of the task",
        },
        notes: {
          type: "string",
          description: "Notes/description for the task",
        },
        due: {
          type: "string",
          description: "Due date in RFC 3339 format (e.g., 2026-03-28T00:00:00Z)",
        },
      },
      required: ["tasklist_id", "title"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "tasks_update",
    description: "Update an existing task's title, notes, or due date.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tasklist_id: {
          type: "string",
          description: "The task list ID",
        },
        task_id: {
          type: "string",
          description: "The task ID to update",
        },
        title: {
          type: "string",
          description: "New title for the task",
        },
        notes: {
          type: "string",
          description: "New notes for the task",
        },
        due: {
          type: "string",
          description: "New due date in RFC 3339 format",
        },
      },
      required: ["tasklist_id", "task_id"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "tasks_complete",
    description: "Mark a task as completed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tasklist_id: {
          type: "string",
          description: "The task list ID",
        },
        task_id: {
          type: "string",
          description: "The task ID to mark as complete",
        },
      },
      required: ["tasklist_id", "task_id"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "tasks_delete",
    description: "Delete a task from a task list.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tasklist_id: {
          type: "string",
          description: "The task list ID",
        },
        task_id: {
          type: "string",
          description: "The task ID to delete",
        },
      },
      required: ["tasklist_id", "task_id"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
];

export async function handleTasks(
  client: GwsClient,
  toolName: string,
  args: Record<string, unknown>
) {
  switch (toolName) {
    case "tasks_list": {
      const result = await client.api("tasks", "tasklists", "list", {});
      return jsonResponse(result.data);
    }

    case "tasks_list_tasks": {
      const params: Record<string, unknown> = {
        tasklist: args.tasklist_id as string,
      };
      if (args.show_completed === false) {
        params.showCompleted = false;
      }
      if (args.show_hidden === true) {
        params.showHidden = true;
      }
      const result = await client.api("tasks", "tasks", "list", { params });
      return jsonResponse(result.data);
    }

    case "tasks_create": {
      const body: Record<string, unknown> = {
        title: args.title as string,
      };
      if (args.notes) body.notes = args.notes as string;
      if (args.due) body.due = args.due as string;
      const result = await client.api("tasks", "tasks", "insert", {
        params: { tasklist: args.tasklist_id as string },
        jsonBody: body,
      });
      return jsonResponse(result.data);
    }

    case "tasks_update": {
      const body: Record<string, unknown> = {};
      if (args.title) body.title = args.title as string;
      if (args.notes) body.notes = args.notes as string;
      if (args.due) body.due = args.due as string;
      const result = await client.api("tasks", "tasks", "patch", {
        params: {
          tasklist: args.tasklist_id as string,
          task: args.task_id as string,
        },
        jsonBody: body,
      });
      return jsonResponse(result.data);
    }

    case "tasks_complete": {
      const result = await client.api("tasks", "tasks", "patch", {
        params: {
          tasklist: args.tasklist_id as string,
          task: args.task_id as string,
        },
        jsonBody: { status: "completed" },
      });
      return jsonResponse(result.data);
    }

    case "tasks_delete": {
      const result = await client.api("tasks", "tasks", "delete", {
        params: {
          tasklist: args.tasklist_id as string,
          task: args.task_id as string,
        },
      });
      return deleteResponse(result, "Task");
    }

    default:
      throw new Error(`Unknown Tasks tool: ${toolName}`);
  }
}
