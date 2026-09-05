// A delegated sub-run may recall the CALLEE's own memory, but only rows within
// the PEP-approved query scope: a project question carries project facts out
// and never a leave reason / salary note — even when the embedding search
// ranks that row. Unit-checks the content floor, then proves it end-to-end
// through runScopedAsk (real model; the filter keeps the sensitive row out of
// the model's context, so the answer cannot contain it).
// Run: npx tsx --env-file=.env.local worker/delegate-memory.test.mts
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { auditLog, departments, employees, memories, projectMembers, projects } from "../db/schema";
import { memoryWithinScope, runScopedAsk } from "../lib/delegation";
import { saveMemory } from "../lib/memory-store";

const check = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) process.exitCode = 1;
};
const rand = Math.random().toString(36).slice(2, 8);
const ids: string[] = [];
let deptId = "";
let projId = "";

try {
  // ---- unit: content floor ---------------------------------------------------
  check("project scope keeps a project fact", memoryWithinScope("project", "P 專案預算覆核完成 70%,9/15 送簽"));
  check("project scope withholds a leave reason", !memoryWithinScope("project", "9/1 請假一天,原因:家人就醫"));
  check("project scope withholds a salary note", !memoryWithinScope("project", "本月薪資 NT$68,000 已入帳"));
  check("team scope withholds private contact info", !memoryWithinScope("team", "私人手機 0912-345-678"));
  check("sensitive scope (self-only) can see everything", memoryWithinScope("sensitive", "請假原因:家人就醫"));

  // ---- e2e: manager asks subordinate's agent about a shared project -----------
  const [d] = await db.insert(departments).values({ name: `qa-dm-${rand}` }).returning({ id: departments.id });
  deptId = d.id;
  const [mgr] = await db.insert(employees).values({ email: `qa-dm-mgr-${rand}@qa.local`, name: `qa-dm-mgr-${rand}`, passwordHash: "x", role: "manager", departmentId: deptId }).returning({ id: employees.id });
  const [sub] = await db.insert(employees).values({ email: `qa-dm-sub-${rand}@qa.local`, name: `qa-dm-sub-${rand}`, passwordHash: "x", role: "employee", departmentId: deptId }).returning({ id: employees.id });
  ids.push(mgr.id, sub.id);
  const pname = `qa-dm-P-${rand}`;
  const [p] = await db.insert(projects).values({ name: pname, ownerId: mgr.id, departmentId: deptId }).returning({ id: projects.id });
  projId = p.id;
  await db.insert(projectMembers).values([{ projectId: projId, employeeId: mgr.id, memberRole: "owner" }, { projectId: projId, employeeId: sub.id }]);
  await saveMemory(sub.id, `${pname} 專案:預算覆核完成 70%,預計 9/15 送主管簽核,目前超支 8%。`, "context");
  await saveMemory(sub.id, "9/1 請假一天,原因:家人就醫,不方便對外說明。", "context");

  const r = await runScopedAsk({ callerId: mgr.id, target: `qa-dm-sub-${rand}`, question: `${pname} 專案目前進度如何?`, scope: "project", chain: [mgr.id] });
  check("project-scope ask allowed", r.ok === true, r);
  const answer = r.ok ? r.answer : "";
  console.log("   answer:", answer.slice(0, 200).replace(/\n/g, " "));
  check("answer carries the project memory (70% / 9/15 / 8%)", /70|9\/15|8%/.test(answer), answer.slice(0, 200));
  check("answer never carries the sensitive memory (就醫 / 請假)", !/就醫|請假/.test(answer), answer.slice(0, 200));
} finally {
  const safe = async (fn: () => Promise<unknown>) => { try { await fn(); } catch { /* partial */ } };
  if (ids.length) {
    await safe(() => db.delete(auditLog).where(inArray(auditLog.employeeId, ids)));
    await safe(() => db.delete(auditLog).where(inArray(auditLog.subjectId, ids)));
    await safe(() => db.delete(memories).where(inArray(memories.employeeId, ids)));
  }
  if (projId) await safe(() => db.delete(projects).where(eq(projects.id, projId)));
  if (ids.length) await safe(() => db.delete(employees).where(inArray(employees.id, ids)));
  if (deptId) await safe(() => db.delete(departments).where(eq(departments.id, deptId)));
}
console.log("delegate-memory.test done");
process.exit(process.exitCode ?? 0);
