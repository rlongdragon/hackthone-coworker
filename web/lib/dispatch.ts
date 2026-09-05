import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { getMembership } from "@/lib/project-store";
import { principalOf } from "@/lib/principal";
import { createPendingAction } from "@/lib/approval-store";
import { assignTodoFromDispatch, markMeetingTask } from "@/lib/meeting-store";

// ============================================================================
// Manager task dispatch (P4). One rule, two entry points (meeting-item confirm
// and the standalone 指派任務 form): the assignee must be a CURRENT member of
// the project and active; same-department (or self) dispatch creates the todo
// now; CROSS-department dispatch is parked for the ASSIGNEE's consent (HITL,
// dispatch.assign executor) — a manager can't put work on another
// department's people without them accepting. Every dispatch is audited.
// ============================================================================

export type DispatchResult =
  | { ok: true; status: "assigned"; todoId: string }
  | { ok: true; status: "pending_consent"; pendingId: string }
  | { ok: false; error: string };

export async function dispatchTask(input: {
  actorId: string;
  projectId: string;
  assigneeId: string;
  title: string;
  // when the dispatch originates from an extracted meeting item
  eventId?: string;
  index?: number;
}): Promise<DispatchResult> {
  const title = input.title.trim().slice(0, 200);
  if (!title) return { ok: false, error: "任務內容不能是空的" };
  if (!(await getMembership(input.projectId, input.actorId))) return { ok: false, error: "你不是專案成員" };
  if (!(await getMembership(input.projectId, input.assigneeId))) return { ok: false, error: "被指派者不是專案成員" };
  const [actor, assignee] = await Promise.all([principalOf(input.actorId), principalOf(input.assigneeId)]);
  if (!assignee?.active) return { ok: false, error: "被指派者帳號不可用" };

  const crossDept =
    input.assigneeId !== input.actorId &&
    !!actor?.departmentId &&
    actor.departmentId !== assignee.departmentId;

  if (crossDept) {
    const p = await createPendingAction(input.assigneeId, "dispatch.assign", {
      eventId: input.eventId ?? null,
      index: input.index ?? -1,
      projectId: input.projectId,
      title,
      assignedBy: input.actorId,
    });
    if (input.eventId !== undefined && input.index !== undefined) {
      await markMeetingTask(input.eventId, input.index, { assigneeId: input.assigneeId, needsConfirm: false, pendingId: p.id, status: "pending_consent" });
    }
    await db.insert(auditLog).values({
      employeeId: input.actorId,
      action: "dispatch.request",
      detail: { assigneeId: input.assigneeId, projectId: input.projectId, title, pendingId: p.id, crossDept: true },
    });
    return { ok: true, status: "pending_consent", pendingId: p.id };
  }

  const { todoId } = await assignTodoFromDispatch({ assigneeId: input.assigneeId, assignedBy: input.actorId, projectId: input.projectId, title });
  if (input.eventId !== undefined && input.index !== undefined) {
    await markMeetingTask(input.eventId, input.index, { assigneeId: input.assigneeId, needsConfirm: false, todoId, status: "assigned" });
  }
  await db.insert(auditLog).values({
    employeeId: input.actorId,
    action: "dispatch.assign",
    detail: { assigneeId: input.assigneeId, projectId: input.projectId, title, todoId, eventId: input.eventId ?? null },
  });
  return { ok: true, status: "assigned", todoId };
}
