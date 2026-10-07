import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPost, clioPatch, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";

const TASK_FIELDS = "id,name,priority,due_at,status,time_estimated,assignee{id,name},matter{id,display_number},reminders{id,notification_method}";

// Clio returns Task time_estimated as an integer number of seconds.
const SECONDS_PER_HOUR = 3600;
const ALL_PAGES_PAGE_SIZE = 200;
const ALL_PAGES_MAX_PAGES = 10;

function estimateHours(seconds: unknown): number | null {
  return typeof seconds === "number" ? Math.round((seconds / SECONDS_PER_HOUR) * 100) / 100 : null;
}

function summarizeEstimates(tasks: any[]) {
  let totalSeconds = 0;
  let withEstimate = 0;
  const byAssignee = new Map<string, { assignee: string; estimated_hours: number; tasks_with_estimate: number; tasks_without_estimate: number }>();
  for (const t of tasks) {
    const key = t.assignee?.name ?? "Unassigned";
    const row = byAssignee.get(key) ?? { assignee: key, estimated_hours: 0, tasks_with_estimate: 0, tasks_without_estimate: 0 };
    if (typeof t.time_estimated === "number") {
      totalSeconds += t.time_estimated;
      withEstimate++;
      row.estimated_hours += t.time_estimated;
      row.tasks_with_estimate++;
    } else {
      row.tasks_without_estimate++;
    }
    byAssignee.set(key, row);
  }
  return {
    total_estimated_hours: estimateHours(totalSeconds),
    tasks_with_estimate: withEstimate,
    tasks_without_estimate: tasks.length - withEstimate,
    by_assignee: [...byAssignee.values()].map((r) => ({ ...r, estimated_hours: estimateHours(r.estimated_hours) })),
  };
}

const STATUS_MAP: Record<string, string> = { Pending: "pending", Complete: "complete", "In Progress": "in_progress", "In Review": "in_review", "Draft": "draft" };

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    "list_tasks",
    {
      description: "List tasks from Clio with optional filters",
      inputSchema: {
        matter_id: z.number().int().positive().optional().describe("Filter tasks by matter ID"),
        status: z.enum(["Pending", "Complete", "In Progress", "In Review", "Draft"]).optional().describe("Filter by task status"),
        due_date_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date (YYYY-MM-DD) — tasks due on or after this date"),
        due_date_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date (YYYY-MM-DD) — tasks due on or before this date"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1-200)"),
        page_token: z.string().optional().describe("Cursor from a previous list_tasks response to fetch the next page"),
        all_pages: z.boolean().default(false).describe("Fetch every matching task (up to 2,000) instead of one page, and include an estimate_summary with total estimated hours overall and per assignee. Use with a due date range to total a week."),
      },
    },
    async ({ matter_id, status, due_date_start, due_date_end, limit, page_token, all_pages }) => {
      try {
        const pageSize = all_pages ? ALL_PAGES_PAGE_SIZE : limit;
        const params: Record<string, string> = { fields: TASK_FIELDS, limit: String(pageSize) };
        if (matter_id) params["matter_id"] = String(matter_id);
        if (status) params["status"] = STATUS_MAP[status];
        if (due_date_start) params["due_at_from"] = due_date_start;
        if (due_date_end) params["due_at_to"] = due_date_end;
        if (page_token && !all_pages) params["page_token"] = page_token;

        let data = await clioGet("/tasks.json", params);
        let tasks = data.data as any[];
        let nextPageToken = tasks.length >= pageSize ? extractNextPageToken(data.meta) : null;
        let truncated = false;

        if (all_pages) {
          let pages = 1;
          while (nextPageToken !== null && pages < ALL_PAGES_MAX_PAGES) {
            data = await clioGet("/tasks.json", { ...params, page_token: nextPageToken });
            const page = data.data as any[];
            tasks = tasks.concat(page);
            nextPageToken = page.length >= pageSize ? extractNextPageToken(data.meta) : null;
            pages++;
          }
          truncated = nextPageToken !== null;
          nextPageToken = null;
        }

        await appendAuditLog({
          tool: "list_tasks",
          args: { matter_id, status, due_date_start, due_date_end, limit, page_token, all_pages },
          outcome: "success",
          result_count: tasks?.length ?? 0,
          ...(matter_id && { matter_id }),
        });

        const result = {
          tasks: tasks.map((t) => ({
            id: t.id,
            name: t.name,
            priority: t.priority,
            due_date: t.due_at ? t.due_at.substring(0, 10) : null,
            status: t.status,
            time_estimated_hours: estimateHours(t.time_estimated),
            time_estimated_seconds: typeof t.time_estimated === "number" ? t.time_estimated : null,
            assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.name } : null,
            matter: t.matter ? { id: t.matter.id, display_number: t.matter.display_number } : null,
            reminder: t.reminders?.length > 0
              ? { notification_method: t.reminders[0].notification_method }
              : null,
          })),
          total_count: data.meta?.records ?? tasks.length,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
          ...(all_pages && { estimate_summary: summarizeEstimates(tasks), truncated }),
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_tasks",
          args: { matter_id, status, due_date_start, due_date_end, limit, page_token, all_pages },
          outcome: "error",
          error_message: err.message,
          ...(matter_id && { matter_id }),
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "create_task",
    {
      description: "Create a task on a matter in Clio",
      inputSchema: {
        matter_id: z.number().int().positive().describe("Matter ID to associate the task with"),
        name: z.string().min(1).describe("Task name / description"),
        description: z.string().min(2).describe("Detailed description of the task"),
        priority: z.enum(["High", "Normal", "Low"]).default("Normal").describe("Task priority"),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date (YYYY-MM-DD) when the task is due"),
        assignee_id: z.number().int().positive().optional().describe("Clio user ID to assign the task to"),
      },
    },
    async ({ matter_id, name, description, priority, due_date, assignee_id }) => {
      try {
        const taskData: Record<string, unknown> = {
          name,
          description,
          priority,
          matter: { id: matter_id },
        };
        if (due_date) taskData["due_at"] = `${due_date}T00:00:00Z`; // midnight UTC — consistent with calendar tool convention
        if (assignee_id) taskData["assignee"] = { id: assignee_id, type: "User" };

        const data = await clioPost("/tasks.json", { data: taskData }, { fields: TASK_FIELDS });
        const task = data.data;

        await appendAuditLog({
          tool: "create_task",
          args: { matter_id, name, priority, due_date, assignee_id },
          outcome: "success",
          matter_id,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              task: {
                id: task.id,
                name: task.name,
                priority: task.priority,
                due_at: task.due_at ? task.due_at.substring(0, 10) : null,
                matter_id,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        await appendAuditLog({
          tool: "create_task",
          args: { matter_id, name, priority, due_date, assignee_id },
          outcome: "error",
          error_message: err.message,
          matter_id,
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "update_task",
    {
      description: "Update one or more fields on an existing Clio task",
      inputSchema: {
        task_id: z.number().int().positive().describe("ID of the task to update"),
        name: z.string().min(1).optional().describe("New task name"),
        description: z.string().optional().describe("New task description"),
        priority: z.enum(["High", "Normal", "Low"]).optional().describe("New priority"),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date (YYYY-MM-DD) for due date"),
        status: z.enum(["Pending", "Complete", "In Progress", "In Review", "Draft"]).optional().describe("New task status"),
        assignee_id: z.number().int().positive().optional().describe("Clio user ID to reassign the task to"),
      },
    },
    async ({ task_id, name, description, priority, due_date, status, assignee_id }) => {
      if ([name, description, priority, due_date, status, assignee_id].every((v) => v === undefined)) {
        return { content: [{ type: "text", text: "Error: at least one field to update must be provided" }], isError: true };
      }
      try {
        const taskData: Record<string, unknown> = {};
        if (name !== undefined) taskData["name"] = name;
        if (description !== undefined) taskData["description"] = description;
        if (priority !== undefined) taskData["priority"] = priority;
        if (due_date !== undefined) taskData["due_at"] = `${due_date}T00:00:00Z`;
        if (status !== undefined) taskData["status"] = STATUS_MAP[status];
        if (assignee_id !== undefined) taskData["assignee"] = { id: assignee_id, type: "User" };

        const data = await clioPatch(`/tasks/${task_id}.json`, { data: taskData }, { fields: TASK_FIELDS });
        const task = data.data;

        await appendAuditLog({
          tool: "update_task",
          args: { task_id, name, description, priority, due_date, status, assignee_id },
          outcome: "success",
          ...(task.matter?.id && { matter_id: task.matter.id }),
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              task: {
                id: task.id,
                name: task.name,
                priority: task.priority,
                status: task.status,
                due_date: task.due_at ? task.due_at.substring(0, 10) : null,
                matter_id: task.matter?.id ?? null,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        await appendAuditLog({
          tool: "update_task",
          args: { task_id, name, description, priority, due_date, status, assignee_id },
          outcome: "error",
          error_message: err.message,
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "complete_task",
    {
      description: "Mark a Clio task as complete",
      inputSchema: {
        task_id: z.number().int().positive().describe("ID of the task to mark complete"),
      },
    },
    async ({ task_id }) => {
      try {
        const data = await clioPatch(`/tasks/${task_id}.json`, { data: { status: STATUS_MAP["Complete"] } }, { fields: TASK_FIELDS });
        const task = data.data;

        await appendAuditLog({
          tool: "complete_task",
          args: { task_id },
          outcome: "success",
          ...(task.matter?.id && { matter_id: task.matter.id }),
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              task: {
                id: task.id,
                name: task.name,
                status: task.status,
                completed_at: task.completed_at ?? null,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        await appendAuditLog({
          tool: "complete_task",
          args: { task_id },
          outcome: "error",
          error_message: err.message,
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
