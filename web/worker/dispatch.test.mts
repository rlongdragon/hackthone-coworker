// Regression for the acceptance-review findings on dispatch:
//  HIGH-1 concurrent confirms must create exactly ONE todo (atomic claim);
//  HIGH-2 malformed extraction rows must not break record mapping;
//  HIGH-3 cross-dept consent: assignee is notified, reject hands the item back
//         (never stuck), 7-day TTL; MED-5 only owner/manager may dispatch to
//         others (self always ok).
// Run: npx tsx --env-file=.env.local worker/dispatch.test.mts
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { collabEvents, departments, employees, notifications, pendingActions, projectMembers, projects, todos } from "../db/schema";
import { dispatchTask } from "../lib/dispatch";
import { getMeetingRecord, listMeetingRecords } from "../lib/meeting-store";
import { resolvePendingAction } from "../lib/approval-store";

const check = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) process.exitCode = 1;
};
const rand = Math.random().toString(36).slice(2, 8);
const empIds: string[] = []; const deptIds: string[] = []; let projId = "";
async function mkDept(n: string) { const [d] = await db.insert(departments).values({ name: `qa-${n}-${rand}` }).returning({ id: departments.id }); deptIds.push(d.id); return d.id; }
async function mkEmp(n: string, role: "employee" | "manager", dept: string) { const [e] = await db.insert(employees).values({ email: `qa-${n}-${rand}@qa.local`, name: `qa-${n}-${rand}`, passwordHash: "x", role, departmentId: dept }).returning({ id: employees.id }); empIds.push(e.id); return e.id; }
async function mkEvent(tasks: unknown[]) {
  const [ev] = await db.insert(collabEvents).values({ sourceType: "meeting_asr", sourceId: "text", scopeLabel: "team", projectId: projId, content: "x", isTainted: true, extractedData: { decisions: ["d"], tasks, tainted: true } }).returning({ id: collabEvents.id });
  return ev.id;
}

try {
  const A = await mkDept("A"), B = await mkDept("B");
  const owner = await mkEmp("owner", "manager", A);
  const emp1 = await mkEmp("emp1", "employee", A);
  const emp2 = await mkEmp("emp2", "employee", B);
  const outsider = await mkEmp("out", "manager", B);
  const [p] = await db.insert(projects).values({ name: `qa-proj-${rand}`, ownerId: owner }).returning({ id: projects.id });
  projId = p.id;
  await db.insert(projectMembers).values([{ projectId: projId, employeeId: owner, memberRole: "owner" }, { projectId: projId, employeeId: emp1 }, { projectId: projId, employeeId: emp2 }]);

  // ---- HIGH-1: concurrent confirm → exactly one todo ----------------------
  const ev1 = await mkEvent([{ title: `race ${rand}`, needsConfirm: true, status: "unconfirmed" }]);
  const results = await Promise.all([0, 1, 2, 3, 4].map(() => dispatchTask({ actorId: owner, projectId: projId, assigneeId: emp1, title: `race ${rand}`, eventId: ev1, index: 0 })));
  const wins = results.filter((r) => r.ok && r.status === "assigned").length;
  const losses = results.filter((r) => !r.ok && r.error.includes("已被處理")).length;
  check("5 concurrent confirms → exactly 1 assigned", wins === 1, results);
  check("the other 4 report already-handled", losses === 4, results);
  const n1 = await db.select().from(todos).where(and(eq(todos.employeeId, emp1), eq(todos.title, `race ${rand}`)));
  check("exactly one todo row exists", n1.length === 1, n1.length);
  const notif1 = await db.select().from(notifications).where(and(eq(notifications.recipientId, emp1), eq(notifications.type, "task_assigned")));
  check("exactly one task_assigned notification", notif1.length === 1, notif1.length);

  // ---- HIGH-2: malformed extraction rows don't break mapping ---------------
  const ev2 = await mkEvent([{ title: "ok", assignee: 12345, status: "unconfirmed" }, { title: 99 }, "junk", null, { title: "x".repeat(500), assignee: { a: 1 } }]);
  const rec2 = await getMeetingRecord(ev2);
  check("record maps despite non-string assignee / non-object tasks", !!rec2 && rec2.tasks.length === 2, rec2?.tasks);
  check("non-string assignee dropped, long title capped", rec2!.tasks.every((t) => t.assignee === undefined || typeof t.assignee === "string") && rec2!.tasks[1].title.length === 200);

  // ---- MED-5: role gate ------------------------------------------------------
  const ev3 = await mkEvent([{ title: `t1 ${rand}`, status: "unconfirmed" }, { title: `t2 ${rand}`, status: "unconfirmed" }]);
  const denied = await dispatchTask({ actorId: emp1, projectId: projId, assigneeId: owner, title: "x", eventId: ev3, index: 0 });
  check("plain member cannot dispatch to someone else", !denied.ok && denied.error.includes("負責人或主管"), denied);
  const rec3a = await getMeetingRecord(ev3);
  check("denied dispatch releases the claimed item (still unconfirmed)", rec3a?.tasks[0].status === "unconfirmed", rec3a?.tasks[0]);
  const selfOk = await dispatchTask({ actorId: emp1, projectId: projId, assigneeId: emp1, title: "mine", eventId: ev3, index: 1 });
  check("member can put a task on their OWN list", selfOk.ok && selfOk.status === "assigned", selfOk);
  const nonMember = await dispatchTask({ actorId: outsider, projectId: projId, assigneeId: emp1, title: "x" });
  check("non-member manager cannot dispatch into the project", !nonMember.ok, nonMember);

  // ---- HIGH-3: cross-dept consent is visible, rejectable, never stuck ------
  const ev4 = await mkEvent([{ title: `xdept ${rand}`, status: "unconfirmed" }]);
  const cross = await dispatchTask({ actorId: owner, projectId: projId, assigneeId: emp2, title: `xdept ${rand}`, eventId: ev4, index: 0 });
  check("cross-dept → pending_consent", cross.ok && cross.status === "pending_consent", cross);
  const pid = cross.ok && cross.status === "pending_consent" ? cross.pendingId : "";
  const [prow] = await db.select().from(pendingActions).where(eq(pendingActions.id, pid));
  check("consent TTL is days, not minutes", prow.expiresAt.getTime() - Date.now() > 6 * 24 * 3600 * 1000, prow.expiresAt);
  const consentNotif = await db.select().from(notifications).where(and(eq(notifications.recipientId, emp2), eq(notifications.type, "dispatch_consent")));
  check("assignee got a dispatch_consent notification carrying the pending id", consentNotif.some((n) => n.auditId === pid), consentNotif);
  const rej = await resolvePendingAction(pid, emp2, "employee", "reject");
  check("assignee rejects", rej.ok);
  const rec4 = await getMeetingRecord(ev4);
  check("rejected item handed back as unconfirmed (not stuck)", rec4?.tasks[0].status === "unconfirmed" && !rec4?.tasks[0].pendingId, rec4?.tasks[0]);
  const again = await dispatchTask({ actorId: owner, projectId: projId, assigneeId: emp2, title: `xdept ${rand}`, eventId: ev4, index: 0 });
  check("can be re-dispatched after reject", again.ok && again.status === "pending_consent", again);
  const pid2 = again.ok && again.status === "pending_consent" ? again.pendingId : "";
  // stale pending (expired) is also handed back on read
  await db.update(pendingActions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(pendingActions.id, pid2));
  const recs = await listMeetingRecords(projId);
  check("expired consent handed back on listing", recs.find((r) => r.id === ev4)?.tasks[0].status === "unconfirmed");
  const third = await dispatchTask({ actorId: owner, projectId: projId, assigneeId: emp2, title: `xdept ${rand}`, eventId: ev4, index: 0 });
  const pid3 = third.ok && third.status === "pending_consent" ? third.pendingId : "";
  const app = await resolvePendingAction(pid3, emp2, "employee", "approve");
  check("approve → todo on the assignee's list with assignedBy", app.ok && (await db.select().from(todos).where(and(eq(todos.employeeId, emp2), eq(todos.assignedBy, owner)))).length === 1, app);
  const rec4b = await getMeetingRecord(ev4);
  check("meeting item now assigned", rec4b?.tasks[0].status === "assigned" && !!rec4b?.tasks[0].todoId, rec4b?.tasks[0]);
} finally {
  const safe = async (fn: () => Promise<unknown>) => { try { await fn(); } catch { /* partial */ } };
  if (projId) await safe(() => db.delete(collabEvents).where(eq(collabEvents.projectId, projId)));
  if (projId) await safe(() => db.delete(projects).where(eq(projects.id, projId)));
  if (empIds.length) {
    await safe(() => db.delete(pendingActions).where(inArray(pendingActions.requesterId, empIds)));
    await safe(() => db.delete(employees).where(inArray(employees.id, empIds)));
  }
  if (deptIds.length) await safe(() => db.delete(departments).where(inArray(departments.id, deptIds)));
}
console.log("dispatch.test done");
process.exit(process.exitCode ?? 0);
