import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMembership } from "@/lib/project-store";
import { assignTodoFromDispatch, getMeetingRecord, markMeetingTask } from "@/lib/meeting-store";
import { createPendingAction } from "@/lib/approval-store";
import { principalOf } from "@/lib/principal";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { asUuid } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

// Confirm extracted action items and dispatch them. Same-department (or
// self) assignment creates the todo immediately; CROSS-department assignment
// is parked for the assignee's consent (HITL) — a manager can't drop work on
// another department's people without them accepting.
export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const { id, eventId: rawEvent } = await ctx.params;
  const projectId = asUuid(id);
  const eventId = asUuid(rawEvent);
  if (!projectId || !eventId) return new Response("Not found", { status: 404 });
  if (!(await getMembership(projectId, session.user.id))) return new Response("Not found", { status: 404 });
  const record = await getMeetingRecord(eventId);
  if (!record || record.projectId !== projectId) return new Response("Not found", { status: 404 });

  const body = (await req.json().catch(() => null)) as { items?: { index: number; assigneeId: string }[] } | null;
  const items = (body?.items ?? []).filter((i) => Number.isInteger(i.index) && asUuid(i.assigneeId));
  if (!items.length) return NextResponse.json({ error: "沒有選擇任何項目" }, { status: 400 });

  const actor = await principalOf(session.user.id);
  const results: { index: number; status: "assigned" | "pending_consent"; todoId?: string; pendingId?: string }[] = [];
  for (const it of items) {
    const task = record.tasks[it.index];
    if (!task || task.status === "assigned" || task.status === "pending_consent") continue;
    // Assignee must be a member of this project.
    if (!(await getMembership(projectId, it.assigneeId))) continue;
    const assignee = await principalOf(it.assigneeId);
    if (!assignee?.active) continue;
    const crossDept =
      it.assigneeId !== session.user.id &&
      !!actor?.departmentId &&
      actor.departmentId !== assignee.departmentId;
    if (crossDept) {
      const p = await createPendingAction(it.assigneeId, "dispatch.assign", {
        eventId, index: it.index, projectId, title: task.title, assignedBy: session.user.id,
      });
      await markMeetingTask(eventId, it.index, { assigneeId: it.assigneeId, needsConfirm: false, pendingId: p.id, status: "pending_consent" });
      results.push({ index: it.index, status: "pending_consent", pendingId: p.id });
    } else {
      const { todoId } = await assignTodoFromDispatch({ assigneeId: it.assigneeId, assignedBy: session.user.id, projectId, title: task.title });
      await markMeetingTask(eventId, it.index, { assigneeId: it.assigneeId, needsConfirm: false, todoId, status: "assigned" });
      await db.insert(auditLog).values({
        employeeId: session.user.id,
        action: "dispatch.assign",
        detail: { assigneeId: it.assigneeId, projectId, title: task.title, todoId, eventId },
      });
      results.push({ index: it.index, status: "assigned", todoId });
    }
  }
  return NextResponse.json({ results, record: await getMeetingRecord(eventId) });
}
