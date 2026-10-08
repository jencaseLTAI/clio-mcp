import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockClioGet, mockClioPatch, mockAppendAuditLog } = vi.hoisted(() => ({
  mockClioGet: vi.fn(),
  mockClioPatch: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/clioClient.js", () => ({
  clioGet: mockClioGet,
  clioPost: vi.fn(),
  clioPatch: mockClioPatch,
  extractNextPageToken: (meta: any) => {
    const nextUrl = meta?.paging?.next;
    if (!nextUrl) return null;
    try { return new URL(nextUrl).searchParams.get("page_token"); }
    catch { return null; }
  },
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { registerTaskTools } from "../tasks.js";

const TASK_FIXTURE = {
  id: 1,
  name: "Draft contract",
  priority: "Normal",
  status: "complete",
  due_at: "2026-01-15T00:00:00Z",
  completed_at: "2026-05-22T10:00:00Z",
  matter: { id: 99 },
};

const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();

beforeAll(() => {
  const fakeServer = {
    registerTool: (name: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  };
  registerTaskTools(fakeServer as any);
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendAuditLog.mockResolvedValue(undefined);
});

// ─── list_tasks ───────────────────────────────────────────────────────────────

describe("list_tasks", () => {
  it("returns has_more: false and next_page_token: null on a short final page", async () => {
    mockClioGet.mockResolvedValue({ data: [TASK_FIXTURE], meta: { records: 1, paging: {} } });
    const handler = handlers.get("list_tasks")!;
    const result = await handler({ limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.has_more).toBe(false);
    expect(parsed.next_page_token).toBeNull();
  });

  it("returns has_more: true and the extracted token when a next page cursor is present", async () => {
    const twoTasks = [TASK_FIXTURE, { ...TASK_FIXTURE, id: 2 }];
    mockClioGet.mockResolvedValue({
      data: twoTasks,
      meta: { records: 10, paging: { next: "https://app.clio.com/api/v4/tasks.json?page_token=abc123" } },
    });
    const handler = handlers.get("list_tasks")!;
    const result = await handler({ limit: 2 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.has_more).toBe(true);
    expect(parsed.next_page_token).toBe("abc123");
  });

  it("forwards page_token into the outgoing request params when supplied", async () => {
    mockClioGet.mockResolvedValue({ data: [TASK_FIXTURE], meta: { records: 1 } });
    const handler = handlers.get("list_tasks")!;
    await handler({ limit: 25, page_token: "xyz" });
    expect(mockClioGet).toHaveBeenCalledWith(
      "/tasks.json",
      expect.objectContaining({ page_token: "xyz" }),
    );
  });

  it("returns a JSON result with has_more: false when the page is empty, not a plain-text sentinel", async () => {
    mockClioGet.mockResolvedValue({ data: [], meta: { records: 0, paging: {} } });
    const handler = handlers.get("list_tasks")!;
    const result = await handler({ limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tasks).toEqual([]);
    expect(parsed.has_more).toBe(false);
    expect(parsed.next_page_token).toBeNull();
  });
});

describe("list_tasks time estimates", () => {
  const WEEK = { due_date_start: "2026-10-12", due_date_end: "2026-10-16" };
  const parse = (r: any) => JSON.parse(r.content[0].text);

  it("requests time_estimated from Clio on list_tasks", async () => {
    mockClioGet.mockResolvedValue({ data: [], meta: { records: 0, paging: {} } });
    await handlers.get("list_tasks")!({ limit: 25 });
    expect(mockClioGet.mock.calls[0][1].fields).toContain("time_estimated");
  });

  it("does not add time_estimated to write requests", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    await handlers.get("update_task")!({ task_id: 1, priority: "High" });
    await handlers.get("complete_task")!({ task_id: 1 });
    for (const call of mockClioPatch.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("time_estimated");
    }
  });

  it("returns the estimate in hours and raw value, null when unset, and 0 as 0", async () => {
    mockClioGet.mockResolvedValue({
      data: [{ ...TASK_FIXTURE, time_estimated: 5400 }, { ...TASK_FIXTURE, id: 2 }, { ...TASK_FIXTURE, id: 3, time_estimated: 0 }],
      meta: { records: 3, paging: {} },
    });
    const parsed = parse(await handlers.get("list_tasks")!({ limit: 25 }));
    expect(parsed.tasks[0].time_estimated_hours).toBe(1.5);
    expect(parsed.tasks[0].time_estimated_seconds).toBe(5400);
    expect(parsed.tasks[1].time_estimated_hours).toBeNull();
    expect(parsed.tasks[2].time_estimated_hours).toBe(0);
    expect(parsed.estimate_summary).toBeUndefined();
    expect(parsed.truncated).toBeUndefined();
  });

  it("all_pages requires a due date range", async () => {
    const result = await handlers.get("list_tasks")!({ limit: 25, all_pages: true }) as any;
    expect(result.isError).toBe(true);
    expect(mockClioGet).not.toHaveBeenCalled();
  });

  it("all_pages rejects page_token", async () => {
    const result = await handlers.get("list_tasks")!({ limit: 25, all_pages: true, page_token: "x", ...WEEK }) as any;
    expect(result.isError).toBe(true);
    expect(mockClioGet).not.toHaveBeenCalled();
  });

  it("all_pages follows every page, totals per assignee by id, and omits rows by default", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      ...TASK_FIXTURE, id: i + 1, time_estimated: 1800, assignee: { id: 7, name: "Jamaal Solomon" },
    }));
    mockClioGet
      .mockResolvedValueOnce({ data: page1, meta: { records: 203, paging: { next: "https://app.clio.com/api/v4/tasks.json?page_token=p2" } } })
      .mockResolvedValueOnce({ data: [
        { ...TASK_FIXTURE, id: 201, time_estimated: 3600, assignee: { id: 8, name: "Sally Reddy" } },
        { ...TASK_FIXTURE, id: 202, assignee: { id: 8, name: "Sally Reddy" } },
        { ...TASK_FIXTURE, id: 203, time_estimated: 900, assignee: { id: 9, name: "Sally Reddy" } },
      ], meta: { records: 203, paging: {} } });
    const parsed = parse(await handlers.get("list_tasks")!({ limit: 25, all_pages: true, ...WEEK }));
    expect(mockClioGet).toHaveBeenCalledTimes(2);
    expect(mockClioGet.mock.calls[1][1]).toEqual(expect.objectContaining({ page_token: "p2", limit: "200", due_at_from: "2026-10-12" }));
    expect(parsed.tasks).toBeUndefined();
    expect(parsed.has_more).toBe(false);
    const sum = parsed.estimate_summary;
    expect(sum.total_estimated_hours).toBe(101.25);
    expect(sum.tasks_counted).toBe(203);
    expect(sum.tasks_with_estimate).toBe(202);
    expect(sum.tasks_without_estimate).toBe(1);
    expect(sum.truncated).toBe(false);
    const sally8 = sum.by_assignee.find((r: any) => r.assignee_id === 8);
    expect(sally8).toEqual({ assignee_id: 8, assignee: "Sally Reddy", estimated_hours: 1, tasks_with_estimate: 1, tasks_without_estimate: 1 });
    expect(sum.by_assignee.find((r: any) => r.assignee_id === 9).estimated_hours).toBe(0.25);
  });

  it("all_pages stops early on a short page", async () => {
    mockClioGet.mockResolvedValueOnce({ data: [{ ...TASK_FIXTURE, time_estimated: 3600 }], meta: { records: 1, paging: {} } });
    const parsed = parse(await handlers.get("list_tasks")!({ limit: 25, all_pages: true, ...WEEK }));
    expect(mockClioGet).toHaveBeenCalledTimes(1);
    expect(parsed.estimate_summary.total_estimated_hours).toBe(1);
  });

  it("all_pages returns rows when include_tasks is true", async () => {
    mockClioGet.mockResolvedValueOnce({ data: [{ ...TASK_FIXTURE, time_estimated: 3600 }], meta: { records: 1, paging: {} } });
    const parsed = parse(await handlers.get("list_tasks")!({ limit: 25, all_pages: true, include_tasks: true, ...WEEK }));
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].time_estimated_hours).toBe(1);
  });

  it("all_pages stops at the page cap and flags truncation in both places", async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => ({ ...TASK_FIXTURE, id: i + 1 }));
    mockClioGet.mockResolvedValue({ data: fullPage, meta: { records: 5000, paging: { next: "https://app.clio.com/api/v4/tasks.json?page_token=more" } } });
    const parsed = parse(await handlers.get("list_tasks")!({ limit: 25, all_pages: true, ...WEEK }));
    expect(mockClioGet).toHaveBeenCalledTimes(10);
    expect(parsed.has_more).toBe(true);
    expect(parsed.estimate_summary.truncated).toBe(true);
    expect(parsed.estimate_summary.tasks_counted).toBe(2000);
    expect(parsed.total_count).toBe(5000);
  });
});

// ─── update_task ──────────────────────────────────────────────────────────────

describe("update_task", () => {
  it("returns isError without calling clioPatch when all fields are undefined", async () => {
    const handler = handlers.get("update_task")!;
    const result = await handler({ task_id: 1 }) as any;
    expect(mockClioPatch).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it("translates status 'Complete' via STATUS_MAP to 'complete'", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("update_task")!;
    await handler({ task_id: 1, status: "Complete" });
    expect(mockClioPatch).toHaveBeenCalledWith(
      "/tasks/1.json",
      expect.objectContaining({ data: expect.objectContaining({ status: "complete" }) }),
      expect.anything(),
    );
  });

  it("translates status 'In Progress' via STATUS_MAP to 'in_progress'", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("update_task")!;
    await handler({ task_id: 1, status: "In Progress" });
    expect(mockClioPatch).toHaveBeenCalledWith(
      "/tasks/1.json",
      expect.objectContaining({ data: expect.objectContaining({ status: "in_progress" }) }),
      expect.anything(),
    );
  });

  it("formats due_date as due_at with midnight UTC suffix", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("update_task")!;
    await handler({ task_id: 1, due_date: "2026-01-15" });
    expect(mockClioPatch).toHaveBeenCalledWith(
      "/tasks/1.json",
      expect.objectContaining({ data: expect.objectContaining({ due_at: "2026-01-15T00:00:00Z" }) }),
      expect.anything(),
    );
  });

  it("shapes assignee as { id, type: 'User' } when assignee_id is provided", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("update_task")!;
    await handler({ task_id: 1, assignee_id: 42 });
    expect(mockClioPatch).toHaveBeenCalledWith(
      "/tasks/1.json",
      expect.objectContaining({ data: expect.objectContaining({ assignee: { id: 42, type: "User" } }) }),
      expect.anything(),
    );
  });

  it("does not include assignee key when assignee_id is absent", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("update_task")!;
    await handler({ task_id: 1, name: "New name" });
    const sentBody = mockClioPatch.mock.calls[0][1] as { data: Record<string, unknown> };
    expect(sentBody.data).not.toHaveProperty("assignee");
  });

  it("calls appendAuditLog with outcome 'success' on happy path", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("update_task")!;
    await handler({ task_id: 1, name: "New name" });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "update_task", outcome: "success" }),
    );
  });

  it("returns isError and logs outcome 'error' when clioPatch rejects", async () => {
    mockClioPatch.mockRejectedValue(new Error("network failure"));
    const handler = handlers.get("update_task")!;
    const result = await handler({ task_id: 1, name: "X" }) as any;
    expect(result.isError).toBe(true);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "update_task", outcome: "error", error_message: "network failure" }),
    );
  });
});

// ─── complete_task ────────────────────────────────────────────────────────────

describe("complete_task", () => {
  it("calls clioPatch with status 'complete' from STATUS_MAP", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("complete_task")!;
    await handler({ task_id: 1 });
    expect(mockClioPatch).toHaveBeenCalledWith("/tasks/1.json", { data: { status: "complete" } }, expect.anything());
  });

  it("returns task shape with id, name, status, and completed_at", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("complete_task")!;
    const result = await handler({ task_id: 1 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      success: true,
      task: { id: 1, name: "Draft contract", status: "complete", completed_at: "2026-05-22T10:00:00Z" },
    });
  });

  it("calls appendAuditLog with outcome 'success' on happy path", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("complete_task")!;
    await handler({ task_id: 1 });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "complete_task", outcome: "success" }),
    );
  });

  it("returns isError and logs outcome 'error' when clioPatch rejects", async () => {
    mockClioPatch.mockRejectedValue(new Error("timeout"));
    const handler = handlers.get("complete_task")!;
    const result = await handler({ task_id: 1 }) as any;
    expect(result.isError).toBe(true);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "complete_task", outcome: "error", error_message: "timeout" }),
    );
  });
});
