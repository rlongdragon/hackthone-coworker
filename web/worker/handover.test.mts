// End-to-end DB test for the handover engine (FR-P-08/09), non-happy paths
// included. Creates throwaway employees, runs a real handover (including the
// LLM-generated position report), asserts side effects, then cleans up.
// Run: npx tsx --env-file=.env.local worker/handover.test.mts
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { auditLog, employees, events, handovers, memories, todos } from "../db/schema";
import { saveMemory } from "../lib/memory-store";
import {
  approveAndRunHandover,
  createHandover,
  deactivateEmployee,
  reactivateEmployee,
  rollbackHandover,
} from "../lib/handover-store";

const check = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) process.exitCode = 1;
};

const [admin] = await db
  .select({ id: employees.id })
  .from(employees)
  .where(eq(employees.email, "admin@coworker.local"));

// throwaway A (leaver), B (successor), and a second admin for the dual-admin path
async function upsertTest(email: string, name: string, role: "employee" | "admin" = "employee") {
  const stale = await db
    .select({ id: employees.id })
    .from(employees)
    .where(eq(employees.email, email));
  if (stale.length) {
    const ids = stale.map((s) => s.id);
    // handover copies reference the source employee (no cascade) — clear first
    await db.delete(memories).where(inArray(memories.sourceEmployeeId, ids));
    await db.delete(handovers).where(inArray(handovers.fromEmployeeId, ids));
    await db.delete(handovers).where(inArray(handovers.toEmployeeId, ids));
    await db.delete(auditLog).where(inArray(auditLog.employeeId, ids));
    await db.delete(employees).where(inArray(employees.id, ids));
  }
  const [e] = await db
    .insert(employees)
    .values({ email, name, passwordHash: "x", role })
    .returning({ id: employees.id });
  return e.id;
}
const aId = await upsertTest("ha@test.local", "交接甲");
const bId = await upsertTest("hb@test.local", "交接乙");
const admin2Id = await upsertTest("hadmin2@test.local", "交接管理員二", "admin");

await saveMemory(aId, "Q3 報表流程:每週五匯出 ERP 數據,用 skills/report.py 整理", "history");
await saveMemory(aId, "供應商小張聯絡窗口只回 Line,電話不接", "context");
await saveMemory(aId, "我喜歡早上開會", "preference");
await db.insert(todos).values({ employeeId: aId, title: "追第三季發票", done: false });
await db.insert(events).values({
  employeeId: aId,
  title: "供應商季會",
  startsAt: new Date(Date.now() + 7 * 86400_000),
  endsAt: new Date(Date.now() + 7 * 86400_000 + 3600_000),
});

// -- create + wrong approver ---------------------------------------------------
const created = await createHandover({
  createdBy: admin.id,
  fromEmployeeId: aId,
  toEmployeeId: bId,
  scope: "all",
  include: { memories: true, skills: true, todos: true, events: true },
});
check("create ok", "id" in created && created.approver === "from-employee", created);
const hid = "id" in created ? created.id : "";

const wrong = await approveAndRunHandover(hid, admin.id, "admin");
check("active leaver: admin cannot approve", !wrong.ok);

// self-approval by initiator is always refused
const self1 = await createHandover({
  createdBy: aId,
  fromEmployeeId: aId,
  toEmployeeId: bId,
  scope: "all",
  include: {},
});
const selfR = await approveAndRunHandover("id" in self1 ? self1.id : "", aId, "employee");
check("initiator cannot self-approve", !selfR.ok);

// -- the real run (A approves own handover) -----------------------------------
const run = await approveAndRunHandover(hid, aId, "employee");
check("approve+run by leaver ok", run.ok, run);

const copied = await db.select().from(memories).where(eq(memories.handoverId, hid));
check("2 memories copied (history+context)", copied.length === 2, copied.length);
check(
  "copies carry provenance",
  copied.every((m) => m.employeeId === bId && m.sourceEmployeeId === aId),
);
check("preference NOT copied", copied.every((m) => m.kind !== "preference"));
const aOwn = await db.select().from(memories).where(eq(memories.employeeId, aId));
check("A's originals untouched", aOwn.length === 3, aOwn.length);
const bTodos = await db
  .select()
  .from(todos)
  .where(and(eq(todos.employeeId, bId), eq(todos.done, false)));
check("todo reassigned to B", bTodos.some((t) => t.title === "追第三季發票"));
const bEvents = await db.select().from(events).where(eq(events.employeeId, bId));
check("future event reassigned to B", bEvents.some((e) => e.title === "供應商季會"));
const [hRow] = await db.select().from(handovers).where(eq(handovers.id, hid));
check("status completed", hRow.status === "completed");
check("position report generated", (hRow.summary ?? "").length > 50);
console.log("---- report head:", (hRow.summary ?? "").slice(0, 120).replace(/\n/g, " "));

const replay = await approveAndRunHandover(hid, aId, "employee");
check("completed handover cannot replay", !replay.ok);

const audits = await db
  .select()
  .from(auditLog)
  .where(inArray(auditLog.action, ["handover.create", "handover.completed"]));
check("audit rows present", audits.length >= 2);

// -- rollback removes every copied row ----------------------------------------
const removed = await rollbackHandover(hid);
check("rollback removes copies", removed === 2, removed);
const residual = await db.select().from(memories).where(eq(memories.handoverId, hid));
check("zero residual after rollback", residual.length === 0);

// -- deactivation (P3) ---------------------------------------------------------
const de = await deactivateEmployee(aId, admin.id);
check("deactivate leaver ok", de.ok, de);
const [aRow] = await db.select({ active: employees.active }).from(employees).where(eq(employees.id, aId));
check("leaver inactive", aRow.active === false);
// Last-admin guard: park the throwaway admin first so the REAL admin is the
// only active one, assert the block, then bring the throwaway back.
const parkAdmin2 = await deactivateEmployee(admin2Id, admin.id);
check("second admin can be deactivated while another admin exists", parkAdmin2.ok, parkAdmin2);
const lastAdmin = await deactivateEmployee(admin.id, bId);
check("last admin protected", !lastAdmin.ok);
await reactivateEmployee(admin2Id, admin.id);

// inactive leaver: dual-admin rule — non-admin initiator is refused outright
const hBad = await createHandover({
  createdBy: bId,
  fromEmployeeId: aId,
  toEmployeeId: bId,
  scope: "all",
  include: { memories: true },
});
check("inactive leaver: non-admin initiator refused", "error" in hBad, hBad);

// admin initiates, a SECOND admin approves
const h2 = await createHandover({
  createdBy: admin.id,
  fromEmployeeId: aId,
  toEmployeeId: bId,
  scope: "all",
  include: { memories: true },
});
check("create for inactive leaver → second-admin", "id" in h2 && h2.approver === "second-admin", h2);
const h2id = "id" in h2 ? h2.id : "";
const selfAdmin = await approveAndRunHandover(h2id, admin.id, "admin");
check("initiating admin cannot self-approve", !selfAdmin.ok);
// reject eligibility: a random employee cannot reject either
const rejByB = await (await import("../lib/handover-store")).rejectHandover(h2id, bId, "employee");
check("non-approver cannot reject", !rejByB.ok, rejByB);
const run2 = await approveAndRunHandover(h2id, admin2Id, "admin");
check("second admin approves inactive leaver's handover", run2.ok, run2);

await reactivateEmployee(aId, admin.id);

// -- cleanup -------------------------------------------------------------------
const testIds = [aId, bId, admin2Id];
await db.delete(memories).where(inArray(memories.sourceEmployeeId, testIds)); // FK, no cascade
await db.delete(handovers).where(inArray(handovers.fromEmployeeId, testIds));
await db.delete(handovers).where(inArray(handovers.toEmployeeId, testIds));
await db.delete(auditLog).where(inArray(auditLog.employeeId, testIds)); // FK has no cascade
await db.delete(employees).where(inArray(employees.id, testIds)); // cascades memories/todos/events
console.log("cleanup done");
process.exit(process.exitCode ?? 0);
