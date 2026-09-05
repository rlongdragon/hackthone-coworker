// E2E DB test for handover v2: gap analysis (v2-B), interview answers (v2-A),
// successor questions (v2-C), custodial + second-stage handover (v2-D),
// grace/followup (v2-F). Real DB, real LLM for the analysis call.
// Run: npx tsx --env-file=.env.local worker/handover-v2.test.mts
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import {
  auditLog,
  employees,
  handoverQuestions,
  handovers,
  memories,
  todos,
} from "../db/schema";
import { saveMemory } from "../lib/memory-store";
import {
  approveAndRunHandover,
  createHandover,
  deactivateEmployee,
  reactivateEmployee,
} from "../lib/handover-store";
import { getActiveLinkTgId } from "../lib/telegram-store";
import {
  analyzeHandoverGaps,
  answerQuestion,
  askSuccessorQuestion,
  listOpenQuestionsForLeaver,
  submitFollowup,
} from "../lib/handover-gaps";

const check = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) process.exitCode = 1;
};

const [admin] = await db
  .select({ id: employees.id })
  .from(employees)
  .where(eq(employees.email, "admin@coworker.local"));

async function upsertTest(email: string, name: string) {
  const stale = await db
    .select({ id: employees.id })
    .from(employees)
    .where(eq(employees.email, email));
  if (stale.length) {
    const ids = stale.map((s) => s.id);
    await db.delete(memories).where(inArray(memories.sourceEmployeeId, ids));
    await db.delete(handovers).where(inArray(handovers.fromEmployeeId, ids));
    await db.delete(handovers).where(inArray(handovers.toEmployeeId, ids));
    await db.delete(auditLog).where(inArray(auditLog.employeeId, ids));
    await db.delete(employees).where(inArray(employees.id, ids));
  }
  const [e] = await db
    .insert(employees)
    .values({ email, name, passwordHash: "x", role: "employee" })
    .returning({ id: employees.id });
  return e.id;
}
const aId = await upsertTest("hva@test.local", "訪談甲");
const bId = await upsertTest("hvb@test.local", "訪談乙");
const cId = await upsertTest("hvc@test.local", "暫管丙");

// A has activity but thin memories → the gap analysis has something to find.
await saveMemory(aId, "報表工具的密碼放在部門保險箱", "context");
await db.insert(todos).values({ employeeId: aId, title: "續約年度稽核外包合約", done: false });
await db.insert(todos).values({ employeeId: aId, title: "移轉舊 ERP 排程到新系統", done: false });

// ---- v2-B: gap analysis ------------------------------------------------------
const h1 = await createHandover({
  createdBy: admin.id,
  fromEmployeeId: aId,
  toEmployeeId: bId,
  scope: "all",
  include: { memories: true, skills: false, todos: true },
});
check("create h1 ok", "id" in h1, h1);
const h1id = "id" in h1 ? h1.id : "";

const gap = await analyzeHandoverGaps(h1id, admin.id);
check("gap analysis ok", gap.ok, gap);
if (gap.ok) {
  check("score in range", gap.report.score >= 0 && gap.report.score <= 100, gap.report.score);
  const qRows = await db
    .select()
    .from(handoverQuestions)
    .where(eq(handoverQuestions.handoverId, h1id));
  check("gap questions rows match report", qRows.length === gap.report.gaps.length, {
    rows: qRows.length,
    gaps: gap.report.gaps.length,
  });
  console.log("---- sample gap question:", qRows[0]?.question ?? "(none)");
}
const [h1RowAfterGap] = await db.select().from(handovers).where(eq(handovers.id, h1id));
check("gap score persisted", h1RowAfterGap.gapScore !== null);

// deterministic question for the lifecycle tests
const [q1] = await db
  .insert(handoverQuestions)
  .values({ handoverId: h1id, kind: "gap", question: "[測試] ERP 排程移轉卡在哪?" })
  .returning({ id: handoverQuestions.id });

// ---- v2-A: answer before the handover runs ----------------------------------
const wrongActor = await answerQuestion(q1.id, bId, "我不該答得了");
check("only leaver can answer", !wrongActor.ok);

const openForA = await listOpenQuestionsForLeaver(aId);
check("leaver sees open questions", openForA.some((q) => q.id === q1.id), openForA.length);

const ans1 = await answerQuestion(q1.id, aId, "卡在供應商 API 金鑰還沒核發,窗口是 IT 部小林");
check("answer ok (pre-completion)", ans1.ok, ans1);
const aMemsPre = await db
  .select()
  .from(memories)
  .where(and(eq(memories.employeeId, aId), isNull(memories.handoverId)));
check(
  "answer stored as A's own memory",
  aMemsPre.some((m) => m.content.includes("小林")),
);
const bMemsPre = await db.select().from(memories).where(eq(memories.employeeId, bId));
check("nothing copied to B yet", bMemsPre.length === 0, bMemsPre.length);

const again = await answerQuestion(q1.id, aId, "再答一次");
check("double answer refused", !again.ok);

// skip records without a memory
const [q2] = await db
  .insert(handoverQuestions)
  .values({ handoverId: h1id, kind: "gap", question: "[測試] 略過我" })
  .returning({ id: handoverQuestions.id });
const skipped = await answerQuestion(q2.id, aId, "   ");
check("skip ok", skipped.ok && skipped.message === "已略過", skipped);

// ---- v2-C guards before completion ------------------------------------------
const early = await askSuccessorQuestion(h1id, bId, "太早問");
check("successor question blocked before completion", !early.ok);

// ---- run h1, then post-completion behaviour ---------------------------------
const run1 = await approveAndRunHandover(h1id, aId, "employee");
check("h1 approve+run ok", run1.ok, run1);
const [h1done] = await db.select().from(handovers).where(eq(handovers.id, h1id));
check("graceUntil set on completion", h1done.graceUntil !== null && h1done.graceUntil > new Date());
check(
  "report has對外窗口 section",
  (h1done.summary ?? "").includes("對外窗口") && (h1done.summary ?? "").includes("人事異動通知"),
  (h1done.summary ?? "").slice(0, 80),
);
const bMemsRun = await db.select().from(memories).where(eq(memories.employeeId, bId));
check(
  "interview answer arrived at B via the run",
  bMemsRun.some((m) => m.content.includes("小林") && m.handoverId === h1id),
);

// post-completion answer copies straight to B
const [q3] = await db
  .insert(handoverQuestions)
  .values({ handoverId: h1id, kind: "successor", question: "供應商季會誰主持?", askedBy: bId })
  .returning({ id: handoverQuestions.id });
const ans3 = await answerQuestion(q3.id, aId, "採購部王經理主持,我方只需帶進度表");
check("post-completion answer ok", ans3.ok, ans3);
const bMemsPost = await db.select().from(memories).where(eq(memories.employeeId, bId));
check(
  "post-completion answer copied to B with provenance",
  bMemsPost.some(
    (m) =>
      m.content.includes("王經理") && m.handoverId === h1id && m.sourceEmployeeId === aId,
  ),
);

// v2-C via the public API
const askOk = await askSuccessorQuestion(h1id, bId, "舊 ERP 的報表範本放哪?");
check("successor can ask after completion", askOk.ok, askOk);
const stranger = await askSuccessorQuestion(h1id, cId, "路人來問");
check("non-successor cannot ask", !stranger.ok);

// ---- v2-F: follow-up ---------------------------------------------------------
const fu = await submitFollowup(h1id, bId, "對帳流程還是不懂\n\n年度稽核的窗口是誰\n");
check("followup ok", fu.ok, fu);
const fuQs = await db
  .select()
  .from(handoverQuestions)
  .where(and(eq(handoverQuestions.handoverId, h1id), eq(handoverQuestions.kind, "successor")));
check(
  "followup lines became successor questions",
  fuQs.filter((q) => q.question.startsWith("[滿月回顧]")).length === 2,
  fuQs.map((q) => q.question),
);
const fu2 = await submitFollowup(h1id, bId, "再來一次");
check("followup is one-shot", !fu2.ok);
const fuWrong = await submitFollowup(h1id, cId, "路人回顧");
check("non-successor cannot followup", !fuWrong.ok);

// ---- v2-D: custodial + second stage -----------------------------------------
// A → C (custodial). C is a placeholder; later C → B moves the same package on
// with A kept as provenance.
await db.insert(todos).values({ employeeId: aId, title: "暫存包待辦:交回公務機", done: false });
await db.insert(todos).values({ employeeId: cId, title: "丙自己的待辦:部門週報", done: false });
const hc = await createHandover({
  createdBy: admin.id,
  fromEmployeeId: aId,
  toEmployeeId: cId,
  scope: "all",
  include: { memories: true, skills: false, todos: true },
  custodial: true,
});
check("custodial create ok", "id" in hc, hc);
const hcid = "id" in hc ? hc.id : "";
const runC = await approveAndRunHandover(hcid, aId, "employee");
check("custodial run ok", runC.ok, runC);
const cMems = await db
  .select()
  .from(memories)
  .where(and(eq(memories.employeeId, cId), eq(memories.handoverId, hcid)));
check("custodian holds the package", cMems.length > 0, cMems.length);
const cTodos = await db.select().from(todos).where(eq(todos.employeeId, cId));
check(
  "parked todo tagged with handover id",
  cTodos.some((t) => t.title.includes("交回公務機") && t.handoverId === hcid),
  cTodos.map((t) => [t.title, t.handoverId]),
);

// guards
const reBadParent = await createHandover({
  createdBy: admin.id,
  fromEmployeeId: bId,
  toEmployeeId: cId,
  scope: "all",
  include: {},
  parentHandoverId: h1id, // h1 is NOT custodial
});
check("rehandover of non-custodial parent refused", "error" in reBadParent, reBadParent);
const reWrongFrom = await createHandover({
  createdBy: admin.id,
  fromEmployeeId: bId, // not the custodian
  toEmployeeId: aId,
  scope: "all",
  include: {},
  parentHandoverId: hcid,
});
check("rehandover from non-custodian refused", "error" in reWrongFrom, reWrongFrom);
const reCustodial = await createHandover({
  createdBy: admin.id,
  fromEmployeeId: cId,
  toEmployeeId: bId,
  scope: "all",
  include: {},
  parentHandoverId: hcid,
  custodial: true,
});
check("rehandover cannot itself be custodial", "error" in reCustodial, reCustodial);

// the real second stage: C → B
const re = await createHandover({
  createdBy: admin.id,
  fromEmployeeId: cId,
  toEmployeeId: bId,
  scope: "all",
  include: { memories: true, skills: false, todos: true },
  parentHandoverId: hcid,
});
check("second-stage create ok", "id" in re, re);
const reid = "id" in re ? re.id : "";
const runRe = await approveAndRunHandover(reid, cId, "employee");
check("second-stage run ok", runRe.ok, runRe);
// only the PARKED todo moves on; the custodian's own work stays put
const bTodos = await db.select().from(todos).where(eq(todos.employeeId, bId));
check(
  "second stage forwards parked todo",
  bTodos.some((t) => t.title.includes("交回公務機") && t.handoverId === reid),
  bTodos.map((t) => t.title),
);
check("custodian's own todo did NOT travel", !bTodos.some((t) => t.title.includes("部門週報")));
const cTodosAfter = await db.select().from(todos).where(eq(todos.employeeId, cId));
check(
  "custodian keeps their own todo",
  cTodosAfter.some((t) => t.title.includes("部門週報")),
);
const bInherited = await db
  .select()
  .from(memories)
  .where(and(eq(memories.employeeId, bId), eq(memories.handoverId, reid)));
check("second stage copied the parked package", bInherited.length === cMems.length, {
  got: bInherited.length,
  want: cMems.length,
});
check(
  "second stage keeps ORIGINAL leaver as provenance",
  bInherited.every((m) => m.sourceEmployeeId === aId),
  bInherited.map((m) => m.sourceEmployeeId),
);
// C's own (non-inherited) memories must NOT have leaked into the second stage
const cOwnLeaked = bInherited.some((m) => !cMems.some((cm) => cm.content === m.content));
check("custodian's own memories not leaked", !cOwnLeaked);

// ---- 離職後不再問人 (product rule) --------------------------------------------
const askWhileActive = await askSuccessorQuestion(h1id, bId, "還在職時可以問");
check("question allowed while leaver active", askWhileActive.ok, askWhileActive);
const de = await deactivateEmployee(aId, admin.id);
check("deactivate leaver ok (warns about open questions)", de.ok && de.message.includes("未答"), de);
const askDead = await askSuccessorQuestion(h1id, bId, "離職後不該能問");
check("question refused after deactivation", !askDead.ok && askDead.message.includes("已離職"), askDead);
const fuHandover = await createHandover({
  createdBy: admin.id,
  fromEmployeeId: aId,
  toEmployeeId: cId,
  scope: "all",
  include: {},
});
check("post-deactivation handover create (dual-admin) ok", "id" in fuHandover, fuHandover);
check("no TG push target for deactivated leaver", (await getActiveLinkTgId(aId)) === null);
await reactivateEmployee(aId, admin.id);

// ---- cleanup -----------------------------------------------------------------
const testIds = [aId, bId, cId];
// copied rows reference the source employee — clear them before the owners go
await db.delete(memories).where(inArray(memories.sourceEmployeeId, testIds));
await db.delete(handovers).where(inArray(handovers.fromEmployeeId, testIds));
await db.delete(handovers).where(inArray(handovers.toEmployeeId, testIds));
await db.delete(auditLog).where(inArray(auditLog.employeeId, testIds));
await db.delete(employees).where(inArray(employees.id, testIds));
console.log("cleanup done");
process.exit(process.exitCode ?? 0);
