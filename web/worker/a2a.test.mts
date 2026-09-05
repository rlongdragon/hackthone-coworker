// E2E for A2A scope-PEP + transparent ledger + notifications + ingestion bones
// (feat/a2a-ledger). Needs the a2a DDL applied (db/a2a-ledger.sql).
// Run: npx tsx --env-file=.env.local worker/a2a.test.mts
import { eq, inArray, or } from "drizzle-orm";
import { db } from "../db";
import { auditLog, collabEvents, departments, employees, projectMembers, projects } from "../db/schema";
import { pepIntersection, recordQueryAudit, listQueriesAboutMe, auditSummary, detectMinimumScope, stricterScope } from "../lib/pep";
import { resolveCoworker, runScopedAsk } from "../lib/delegation";
import { notifyQuery, getMyNotifications, unreadCount, markNotificationRead, markAllRead } from "../lib/notifications";
import { ingestCollabEvent, extractDecisionsAndTasks } from "../lib/collab-events";

const check = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) process.exitCode = 1;
};

const rand = Math.random().toString(36).slice(2, 8);
const mk = (s: string) => `qa-${s}-${rand}`;
const empIds: string[] = [];
const deptIds: string[] = [];
const projIds: string[] = [];
const collabIds: string[] = [];

async function mkDept(n: string) {
  const [d] = await db.insert(departments).values({ name: mk(n) }).returning({ id: departments.id });
  deptIds.push(d.id); return d.id;
}
async function mkEmp(n: string, role: "employee" | "manager" | "admin", dept: string | null) {
  const [e] = await db.insert(employees).values({ email: `${mk(n)}@qa.local`, name: mk(n), passwordHash: "x", role, departmentId: dept }).returning({ id: employees.id });
  empIds.push(e.id); return e.id;
}

try {
  const eng = await mkDept("eng");
  const sales = await mkDept("sales");
  const admin = await mkEmp("admin", "admin", eng);
  const mgr = await mkEmp("mgr", "manager", eng);
  const sub = await mkEmp("sub", "employee", eng); // manager's subordinate
  const out = await mkEmp("out", "employee", sales); // unrelated, different dept
  // a shared project between mgr and sub
  const [proj] = await db.insert(projects).values({ name: mk("proj"), ownerId: mgr }).returning({ id: projects.id });
  projIds.push(proj.id);
  await db.insert(projectMembers).values([
    { projectId: proj.id, employeeId: mgr },
    { projectId: proj.id, employeeId: sub },
  ]);

  // ---- 1. PEP intersection --------------------------------------------------
  check("self can query own sensitive", (await pepIntersection(sub, sub, "sensitive")).allowed);
  check("manager CANNOT query subordinate's sensitive (no bypass)", !(await pepIntersection(mgr, sub, "sensitive")).allowed);
  check("admin CANNOT query sensitive either (no HITL/role bypass)", !(await pepIntersection(admin, sub, "sensitive")).allowed);
  check("private denied to others", !(await pepIntersection(mgr, sub, "private")).allowed);
  const mgrProj = await pepIntersection(mgr, sub, "project");
  check("manager CAN query subordinate's project (manager-of)", mgrProj.allowed && mgrProj.effectiveScope === "project");
  check("peer sharing a project can query team", (await pepIntersection(sub, mgr, "team")).allowed);
  check("unrelated cross-dept peer DENIED project", !(await pepIntersection(out, sub, "project")).allowed);
  const denied = await pepIntersection(mgr, sub, "sensitive");
  check("denied decision carries reason + fields", !!denied.deniedReason && denied.deniedFields.length > 0, denied);

  // framework-default (enforce off, non-prod) → leaks
  process.env.AGENT_SOCIETY_ENFORCE = "0";
  check("framework-default: sensitive NOW allowed (contrast)", (await pepIntersection(out, sub, "sensitive")).allowed);
  process.env.AGENT_SOCIETY_ENFORCE = "1";

  // ---- 2. ledger: allowed + denied both visible to subject ------------------
  const a1 = await recordQueryAudit({ callerId: mgr, subjectId: sub, scope: "project", purpose: "看A專案進度", allowed: true });
  const a2 = await recordQueryAudit({ callerId: mgr, subjectId: sub, scope: "sensitive", purpose: "問請假原因", allowed: false, deniedFields: ["leave_reason"] });
  check("audit rows created", !!a1.id && !!a2.id);
  const all = await listQueriesAboutMe(sub, { includeDenied: true });
  check("subject sees BOTH allowed and denied", all.some((r) => r.allowed) && all.some((r) => !r.allowed), all.length);
  const onlyAllowed = await listQueriesAboutMe(sub, { includeDenied: false });
  check("includeDenied:false hides denied", onlyAllowed.every((r) => r.allowed));
  check("denied ledger row exposes denied fields", all.find((r) => !r.allowed)?.deniedFields?.includes("leave_reason") ?? false);
  const summary = await auditSummary(30);
  check("audit summary counts denied", summary.deniedCount >= 1 && summary.totalQueries >= 2, summary);

  // ---- 3. notifications: subject notified of the query (incl. denied) -------
  await notifyQuery({ subjectId: sub, actorId: mgr, actorName: "Mgr", scope: "sensitive", allowed: false, purpose: "問請假原因", auditId: a2.id });
  await notifyQuery({ subjectId: sub, actorId: mgr, actorName: "Mgr", scope: "project", allowed: true, purpose: "看A專案進度", auditId: a1.id });
  const notifs = await getMyNotifications(sub);
  check("subject got a query_denied notification", notifs.some((n) => n.type === "query_denied"), notifs.map((n) => n.type));
  check("unread count reflects new notifs", (await unreadCount(sub)) >= 2);
  // a different user cannot mark my notification read
  const someNotif = notifs[0].id;
  check("cannot mark someone else's notification read", !(await markNotificationRead(someNotif, out)));
  check("recipient can mark own notification read", await markNotificationRead(someNotif, sub));
  const cleared = await markAllRead(sub);
  check("mark-all-read clears the rest", cleared >= 1 && (await unreadCount(sub)) === 0, cleared);

  // ---- 3a. resolveCoworker: model-style targets must resolve ----------------
  // Found by the REAL chat E2E: the LLM wrote "小明" / "小明（財務）" (fullwidth)
  // for a row named "小明 (財務)" and exact-match failed → agent couldn't reach
  // the coworker at all. Lock in: normalisation + escaped contains-match.
  const mingLike = await mkEmp("ming (財務)", "employee", eng); // name = qa-ming (財務)-<rand>
  const byFullwidth = await resolveCoworker(mgr, `qa-ming（財務）-${rand}`);
  check("fullwidth parens normalise to the exact row", byFullwidth?.id === mingLike, byFullwidth?.name);
  const byFragment = await resolveCoworker(mgr, `qa-ming`);
  check("bare name fragment resolves via contains-match", byFragment?.id === mingLike, byFragment?.name);
  const wild = await resolveCoworker(mgr, "%");
  check("wildcard-only target does NOT resolve (escaped, <2 chars)", wild === null, wild?.name);

  // ---- 3b. F1: content-floor stops scope MISLABELLING ----------------------
  check("detectMinimumScope flags a leave question as sensitive", detectMinimumScope("小明最近為什麼請假") === "sensitive");
  check("detectMinimumScope leaves a plain project question at project", detectMinimumScope("A 專案進度如何") === "project");
  check("stricterScope ratchets up, never down", stricterScope("project", "sensitive") === "sensitive" && stricterScope("sensitive", "project") === "sensitive");
  // manager mislabels a sensitive question as "project" → runScopedAsk must
  // escalate + DENY, and record it as sensitive/denied (not a benign project row).
  const mgrName = (await db.select({ name: employees.name }).from(employees).where(eq(employees.id, sub)))[0].name;
  const mislabel = await runScopedAsk({ callerId: mgr, target: mgrName, question: "小明最近為什麼請假?", scope: "project", chain: [mgr] });
  check("mislabelled sensitive-as-project is DENIED", !mislabel.ok && "denied" in mislabel && mislabel.denied === true, mislabel);
  check("mislabel recorded under the escalated (sensitive) scope", mislabel.scope === "sensitive", mislabel.scope);
  const ledgerAfterMislabel = await listQueriesAboutMe(sub, { includeDenied: true });
  check("mislabelled query landed on the ledger as denied+sensitive", ledgerAfterMislabel.some((r) => r.scope === "sensitive" && !r.allowed));

  // ---- 3c. F2: every runScopedAsk (incl. nested chains) records + notifies --
  const beforeCount = (await listQueriesAboutMe(sub, { includeDenied: true })).length;
  // simulate a nested (depth-2) delegation reaching the same subject
  await runScopedAsk({ callerId: mgr, target: mgrName, question: "小明的健康狀況?", scope: "team", chain: [admin, mgr] });
  const afterCount = (await listQueriesAboutMe(sub, { includeDenied: true })).length;
  check("nested-depth runScopedAsk still writes a ledger row", afterCount === beforeCount + 1, { beforeCount, afterCount });

  // ---- 4. ingestion bones: write-time scope + taint + extraction ------------
  const ev = await ingestCollabEvent({
    sourceType: "meeting_asr",
    scopeLabel: "team",
    createdBy: mgr,
    content: "會議決議:Q3 專案延後兩週。行動項目:小明整理需求文件、老王聯絡客戶。",
    isTainted: true,
  });
  collabIds.push(ev.id);
  check("collab event stored with content hash", !!ev.contentHash && ev.contentHash.length === 64);
  const [evRow] = await db.select().from(collabEvents).where(eq(collabEvents.id, ev.id));
  check("collab event carries write-time scope + taint", evRow.scopeLabel === "team" && evRow.isTainted === true);
  const extraction = await extractDecisionsAndTasks(ev.id, "會議決議:Q3 專案延後兩週。行動項目:小明整理需求文件、老王聯絡客戶。");
  check("extraction returns arrays + persists", Array.isArray(extraction.decisions) && Array.isArray(extraction.tasks));
  const [evAfter] = await db.select().from(collabEvents).where(eq(collabEvents.id, ev.id));
  check("extracted data persisted on the event", !!evAfter.extractedData);
} finally {
  const safe = async (fn: () => Promise<unknown>) => { try { await fn(); } catch { /* partial */ } };
  if (collabIds.length) await safe(() => db.delete(collabEvents).where(inArray(collabEvents.id, collabIds)));
  if (empIds.length) {
    await safe(() => db.delete(auditLog).where(or(inArray(auditLog.employeeId, empIds), inArray(auditLog.subjectId, empIds))));
    await safe(() => db.delete(projectMembers).where(inArray(projectMembers.projectId, projIds)));
    await safe(() => db.delete(projects).where(inArray(projects.id, projIds)));
    await safe(() => db.delete(employees).where(inArray(employees.id, empIds))); // cascades notifications
    await safe(() => db.delete(departments).where(inArray(departments.id, deptIds)));
  }
}

console.log("a2a.test done");
process.exit(process.exitCode ?? 0);
