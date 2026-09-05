import { db } from "@/db";
import { auditLog, notifications } from "@/db/schema";
import { getMembership } from "@/lib/project-store";
import { principalOf } from "@/lib/principal";
import { createPendingAction } from "@/lib/approval-store";
import { assignTodoFromDispatch, claimMeetingTask, markMeetingTask, releaseMeetingTask } from "@/lib/meeting-store";

// ============================================================================
// Manager task dispatch (P4). One rule, two entry points (meeting-item confirm
// and the standalone 指派任務 form):
//  - who may dispatch: the project OWNER, or a manager/admin member; any member
//    may put a task on their OWN list.
//  - assignee must be a CURRENT, active member of the project.
//  - same department (or self) → todo now; CROSS-department → parked for the
//    ASSIGNEE's consent (dispatch.assign HITL, 7-day TTL) and the assignee is
//    notified so they can decide from their own pages.
//  - meeting items are CLAIMED atomically first, so concurrent confirms can't
//    create duplicate todos.
// Every dispatch is audited.
// ============================================================================

const CONSENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  const actorMembership = await getMembership(input.projectId, input.actorId);
  if (!actorMembership) return { ok: false, error: "你不是專案成員" };
  if (!(await getMembership(input.projectId, input.assigneeId))) return { ok: false, error: "被指派者不是專案成員" };
  const [actor, assignee] = await Promise.all([principalOf(input.actorId), principalOf(input.assigneeId)]);
  if (!actor) return { ok: false, error: "找不到指派者" };
  if (!assignee?.active) return { ok: false, error: "被指派者帳號不可用" };

  const self = input.assigneeId === input.actorId;
  const mayDispatch = self || actorMembership.memberRole === "owner" || actor.role === "manager" || actor.role === "admin";
  if (!mayDispatch) return { ok: false, error: "只有專案負責人或主管可以指派給別人" };

  const fromMeeting = input.eventId !== undefined && input.index !== undefined;
  if (fromMeeting && !(await claimMeetingTask(input.eventId!, input.index!))) {
    return { ok: false, error: "此項目已被處理(或正在處理中)" };
  }

  try {
    // Any department mismatch — including a dispatcher with NO department
    // assigning into one — needs the assignee's consent. Only "same department"
    // (or self) is immediate.
    const crossDept = !self && (actor.departmentId ?? null) !== (assignee.departmentId ?? null);
    if (crossDept) {
      const p = await createPendingAction(
        input.assigneeId,
        "dispatch.assign",
        { eventId: input.eventId ?? null, index: input.index ?? -1, projectId: input.projectId, title, assignedBy: input.actorId },
        { ttlMs: CONSENT_TTL_MS },
      );
      if (fromMeeting) {
        await markMeetingTask(input.eventId!, input.index!, { assigneeId: input.assigneeId, needsConfirm: false, pendingId: p.id, status: "pending_consent" });
      }
      // The assignee must be able to SEE and decide on this from their own pages.
      await db.insert(notifications).values({
        recipientId: input.assigneeId,
        actorId: input.actorId,
        type: "dispatch_consent",
        scope: "project",
        purpose: `跨部門指派待你同意:${title.slice(0, 80)}`,
        auditId: p.id, // the pending action to decide on
      });
      await db.insert(auditLog).values({
        employeeId: input.actorId,
        action: "dispatch.request",
        detail: { assigneeId: input.assigneeId, projectId: input.projectId, title, pendingId: p.id, crossDept: true },
      });
      return { ok: true, status: "pending_consent", pendingId: p.id };
    }

    const { todoId } = await assignTodoFromDispatch({ assigneeId: input.assigneeId, assignedBy: input.actorId, projectId: input.projectId, title });
    if (fromMeeting) {
      await markMeetingTask(input.eventId!, input.index!, { assigneeId: input.assigneeId, needsConfirm: false, todoId, status: "assigned" });
    }
    await db.insert(auditLog).values({
      employeeId: input.actorId,
      action: "dispatch.assign",
      detail: { assigneeId: input.assigneeId, projectId: input.projectId, title, todoId, eventId: input.eventId ?? null },
    });
    return { ok: true, status: "assigned", todoId };
  } catch (e) {
    if (fromMeeting) await releaseMeetingTask(input.eventId!, input.index!).catch(() => {});
    throw e;
  }
}
