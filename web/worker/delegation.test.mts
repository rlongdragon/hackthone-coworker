// E2E for governed delegation (agent-society · Pillar 1). Seeds a Sales/Finance
// org, proves the scope-intersection PEP refuses cross-dept data, the chain only
// attenuates, cross-dept HITL runs under the intersection, and the permission-
// graph auditor flags over-privilege. Needs NO new DB columns (P1 only).
// Run: npx tsx --env-file=.env.local worker/delegation.test.mts
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { auditLog, departments, employees, tools } from "../db/schema";
import { listVisibleTools } from "../lib/tool-store";
import { runSkill } from "../lib/tool-runtime";
import { askCoworker, resolveCoworker, runDelegatedTurn } from "../lib/delegation";
import { auditPermissionGraph } from "../lib/red-team";
import { createPendingAction, resolvePendingAction } from "../lib/approval-store";

const check = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) process.exitCode = 1;
};

const rand = Math.random().toString(36).slice(2, 8);
const mk = (s: string) => `qa-${s}-${rand}`;
const empIds: string[] = [];
const deptIds: string[] = [];
const toolIds: string[] = [];

async function mkDept(name: string) {
  const [d] = await db.insert(departments).values({ name: mk(name) }).returning({ id: departments.id });
  deptIds.push(d.id);
  return d.id;
}
async function mkEmp(name: string, role: "employee" | "manager" | "admin", deptId: string | null) {
  const [e] = await db
    .insert(employees)
    .values({ email: `${mk(name)}@qa.local`, name: mk(name), passwordHash: "x", role, departmentId: deptId })
    .returning({ id: employees.id });
  empIds.push(e.id);
  return e.id;
}

try {
  // ---- seed org ----------------------------------------------------------
  const finDept = await mkDept("finance");
  const salesDept = await mkDept("sales");
  const cfo = await mkEmp("cfo", "manager", finDept); // in finance
  const fin = await mkEmp("finlead", "manager", finDept); // the callee agent
  const sales = await mkEmp("salesrep", "employee", salesDept); // the caller

  // A finance-department-scoped tool: the sensitive payroll lookup.
  const [payroll] = await db
    .insert(tools)
    .values({
      name: mk("payroll_lookup").replace(/-/g, "_"),
      description: "查詢部門薪酬支出",
      kind: "action",
      scope: "department",
      ownerId: fin,
      departmentId: finDept,
      spec: { method: "GET", url: "http://127.0.0.1:9/payroll" },
    })
    .returning({ id: tools.id });
  toolIds.push(payroll.id);
  const payrollName = (await db.select({ name: tools.name }).from(tools).where(eq(tools.id, payroll.id)))[0].name;

  // An org-wide sensitive action → for the over-privilege auditor.
  const [orgTool] = await db
    .insert(tools)
    .values({
      name: mk("wire_transfer").replace(/-/g, "_"),
      description: "org-wide 匯款動作",
      kind: "action",
      scope: "org",
      ownerId: cfo,
      spec: { method: "POST", url: "http://127.0.0.1:9/wire", sensitive: true },
    })
    .returning({ id: tools.id });
  toolIds.push(orgTool.id);

  // ---- 1. scope-intersection PEP (the money shot) ------------------------
  const finAlone = (await listVisibleTools(fin, [])).map((t) => t.id);
  check("finance agent alone sees payroll tool", finAlone.includes(payroll.id));

  const finForSales = (await listVisibleTools(fin, [sales])).map((t) => t.id);
  check(
    "Sales ∩ Finance DROPS the finance dept tool (leak refused)",
    !finForSales.includes(payroll.id),
    finForSales,
  );

  const finForCfo = (await listVisibleTools(fin, [cfo])).map((t) => t.id);
  check(
    "CFO(in finance) ∩ Finance KEEPS the payroll tool (answers)",
    finForCfo.includes(payroll.id),
  );

  // ---- 2. delegation chain only attenuates -------------------------------
  const oneHop = (await listVisibleTools(fin, [cfo])).map((t) => t.id);
  const twoHop = (await listVisibleTools(fin, [cfo, sales])).map((t) => t.id);
  check(
    "chain attenuates: adding Sales never widens the set",
    twoHop.every((id) => oneHop.includes(id)) && twoHop.length <= oneHop.length,
    { oneHop: oneHop.length, twoHop: twoHop.length },
  );
  check("two-hop chain drops payroll (Sales caveat)", !twoHop.includes(payroll.id));

  // ---- 3. enforcement OFF = framework-default leak (contrast) ------------
  process.env.AGENT_SOCIETY_ENFORCE = "0";
  const finForSalesUnenforced = (await listVisibleTools(fin, [sales])).map((t) => t.id);
  check(
    "framework-default (PEP off): payroll NOT dropped → would leak",
    finForSalesUnenforced.includes(payroll.id),
  );
  process.env.AGENT_SOCIETY_ENFORCE = "1";

  // ---- 4. resolveCoworker + full delegated run (LLM) ---------------------
  const resolved = await resolveCoworker(sales, (await db.select({ name: employees.name }).from(employees).where(eq(employees.id, fin)))[0].name);
  check("resolveCoworker finds the finance lead by name", resolved?.id === fin, resolved?.id);

  const run = await runDelegatedTurn({ calleeId: fin, question: "工程部 Q3 薪酬支出多少?", chain: [sales] });
  check("delegated run computes intersected scope", run.ok);
  check("payroll appears in droppedTools for Sales", run.droppedTools.includes(payrollName), run.droppedTools);
  check("payroll NOT in exposedTools for Sales", !run.exposedTools.includes(payrollName), run.exposedTools);

  const askByDept = await askCoworker({
    chain: [sales],
    target: (await db.select({ name: departments.name }).from(departments).where(eq(departments.id, finDept)))[0].name,
    question: "工程部 Q3 薪酬支出?",
  });
  check("askCoworker (by dept) returns from a finance principal", askByDept.ok, askByDept);
  const delegRows = await db.select().from(auditLog).where(eq(auditLog.action, "delegation.ask"));
  check(
    "delegation provenance written to audit log (callee = finance)",
    delegRows.some((r) => (r.detail as { calleeDept?: string })?.calleeDept === finDept),
  );

  // ---- 5. HITL consent: callee approves → executor runs the scoped ask -----
  // The a2a executor now routes through runScopedAsk (scope-PEP + ledger written
  // POST-consent), so the parked params carry target + scope, and the caller
  // must actually pass the scope-PEP: cfo is fin's line manager → project OK.
  const finName = (await db.select({ name: employees.name }).from(employees).where(eq(employees.id, fin)))[0].name;
  const pending = await createPendingAction(fin, "delegation.ask", {
    callerId: cfo,
    chain: [cfo],
    target: finName,
    scope: "project",
    question: "幫我看 A 專案的進度",
  });
  check("delegation parked for callee consent", !!pending.id);
  const approved = await resolvePendingAction(pending.id, fin, "manager", "approve");
  check("callee approves → scoped sub-run executes (ledger post-consent)", approved.ok, approved);

  // ---- 6. permission-graph auditor flags over-privilege ------------------
  const orgToolName = (await db.select({ name: tools.name }).from(tools).where(eq(tools.id, orgTool.id)))[0].name;
  const graph = await auditPermissionGraph([sales, fin, cfo]);
  check(
    "auditor flags non-admin reachable org sensitive action",
    graph.findings.some((f) => f.employeeId === sales && f.toolName === orgToolName),
    graph.findings,
  );

  // ---- 7. delegated runSkill can't reach a personal skill the caller lacks
  //         (review finding #1: name re-resolution must honor the chain) -----
  const [secretSkill] = await db
    .insert(tools)
    .values({
      name: mk("secret_skill").replace(/-/g, "_"),
      description: "fin 的私人技能",
      kind: "skill",
      scope: "personal",
      ownerId: fin,
      lang: "bash",
      body: "echo pwned",
    })
    .returning({ id: tools.id, name: tools.name });
  toolIds.push(secretSkill.id);
  const finForSalesSkills = (await listVisibleTools(fin, [sales])).map((t) => t.id);
  check("Sales ∩ Finance drops fin's PERSONAL skill", !finForSalesSkills.includes(secretSkill.id));
  const denied = await runSkill(fin, secretSkill.name, [], [sales]);
  check(
    "delegated runSkill refuses the personal skill (chain-scoped resolve)",
    !denied.ok && (denied.error ?? "").includes("not visible"),
    denied,
  );
  // fin alone CAN run it (own personal skill) — sanity that we didn't over-block.
  const finSees = await listVisibleTools(fin, []);
  check("fin alone still sees own personal skill", finSees.some((t) => t.id === secretSkill.id));
} finally {
  // ---- cleanup -----------------------------------------------------------
  if (empIds.length) {
    await db.delete(auditLog).where(inArray(auditLog.employeeId, empIds));
    await db.delete(tools).where(inArray(tools.id, toolIds.length ? toolIds : ["00000000-0000-0000-0000-000000000000"]));
    await db.delete(employees).where(inArray(employees.id, empIds));
    await db.delete(departments).where(inArray(departments.id, deptIds));
  }
}

console.log("delegation.test done");
process.exit(process.exitCode ?? 0);
