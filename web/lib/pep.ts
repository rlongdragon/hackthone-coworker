import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, projectMembers } from "@/db/schema";
import { principalOf, type Principal } from "@/lib/delegation";
import { pepEnforced } from "@/lib/tool-store";

// ============================================================================
// A2A scope-intersection PEP + transparent ledger (feat/a2a-ledger)
//
// A SECOND, complementary enforcement point to the tool-visibility intersection
// in tool-store: this one classifies WHAT is being asked about a SUBJECT and
// decides allowed/denied by the caller↔subject relationship. Effective =
// caller ∩ subject. `sensitive`/`private` are self-only — no role and no HITL
// bypasses them (that non-bypass is the demo's money shot). Every decision is
// written to the ledger (audit_log) as a side-effect: 不留紀錄 = 不執行.
// ============================================================================

export type ScopeLabel = "project" | "team" | "private" | "sensitive";

export type PepDecision = {
  allowed: boolean;
  effectiveScope: ScopeLabel | null;
  deniedReason?: string;
  deniedFields: string[];
};

// Illustrative sensitive fields a subject-scope query would touch (for the
// ledger/notification, so the subject sees exactly what was blocked).
const SENSITIVE_FIELDS = ["leave_reason", "health", "salary", "personal_contact"];

async function projectsOf(id: string): Promise<Set<string>> {
  const rows = await db
    .select({ p: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.employeeId, id));
  return new Set(rows.map((r) => r.p));
}

async function sharesProject(a: string, b: string): Promise<boolean> {
  const [pa, pb] = await Promise.all([projectsOf(a), projectsOf(b)]);
  for (const p of pa) if (pb.has(p)) return true;
  return false;
}

// A manager/admin in the SUBJECT's own department is the subject's line manager.
function isManagerOf(caller: Principal, subject: Principal): boolean {
  return (
    (caller.role === "manager" || caller.role === "admin") &&
    !!caller.departmentId &&
    caller.departmentId === subject.departmentId
  );
}

export async function pepIntersection(
  callerId: string,
  subjectId: string,
  requestedScope: ScopeLabel,
  _purpose?: string,
): Promise<PepDecision> {
  // A principal querying about themselves: always allowed.
  if (callerId === subjectId) {
    return { allowed: true, effectiveScope: requestedScope, deniedFields: [] };
  }
  const [caller, subject] = await Promise.all([principalOf(callerId), principalOf(subjectId)]);
  if (!caller || !subject) {
    return { allowed: false, effectiveScope: null, deniedReason: "未知的委派對象", deniedFields: [requestedScope] };
  }
  // Framework-default (PEP off, non-prod only) → everything answers. This is the
  // contrast the demo toggles to show the leak.
  if (!pepEnforced()) {
    return { allowed: true, effectiveScope: requestedScope, deniedFields: [] };
  }

  switch (requestedScope) {
    case "sensitive":
      return {
        allowed: false,
        effectiveScope: null,
        deniedReason: "敏感範圍(請假原因/健康/薪資等):僅本人可存取,無角色或 HITL 例外",
        deniedFields: SENSITIVE_FIELDS,
      };
    case "private":
      return {
        allowed: false,
        effectiveScope: null,
        deniedReason: "私人範圍:僅本人可存取",
        deniedFields: ["private"],
      };
    case "team": {
      const ok = caller.role === "admin" || isManagerOf(caller, subject) || (await sharesProject(callerId, subjectId));
      return ok
        ? { allowed: true, effectiveScope: "team", deniedFields: [] }
        : { allowed: false, effectiveScope: null, deniedReason: "非同隊成員、也非其主管", deniedFields: ["team"] };
    }
    case "project": {
      const ok = caller.role === "admin" || isManagerOf(caller, subject) || (await sharesProject(callerId, subjectId));
      return ok
        ? { allowed: true, effectiveScope: "project", deniedFields: [] }
        : { allowed: false, effectiveScope: null, deniedReason: "無共同專案、也非其主管", deniedFields: ["project"] };
    }
    default:
      return { allowed: false, effectiveScope: null, deniedReason: "未知範圍", deniedFields: [String(requestedScope)] };
  }
}

// Write one ledger row. This is the "no record = no execute" primitive: the A2A
// path MUST call this (and get an id) before returning any answer.
export async function recordQueryAudit(params: {
  callerId: string;
  subjectId: string;
  scope: ScopeLabel;
  purpose: string;
  allowed: boolean;
  deniedFields?: string[];
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(auditLog)
    .values({
      employeeId: params.callerId,
      action: "a2a.query",
      subjectId: params.subjectId,
      queryScope: params.scope,
      queryAllowed: params.allowed,
      deniedFields: params.deniedFields ?? [],
      detail: { purpose: params.purpose },
    })
    .returning({ id: auditLog.id });
  return { id: row.id };
}

export type LedgerRow = {
  id: string;
  actorId: string | null;
  scope: ScopeLabel | null;
  allowed: boolean | null;
  deniedFields: string[] | null;
  purpose: string | null;
  createdAt: Date;
};

// The subject-facing view: "who queried about me, and what was denied." Denied
// rows are included by default — that visibility is the point.
export async function listQueriesAboutMe(
  subjectId: string,
  opts?: { includeDenied?: boolean; limit?: number },
): Promise<LedgerRow[]> {
  const includeDenied = opts?.includeDenied ?? true;
  const where = includeDenied
    ? and(eq(auditLog.subjectId, subjectId), eq(auditLog.action, "a2a.query"))
    : and(eq(auditLog.subjectId, subjectId), eq(auditLog.action, "a2a.query"), eq(auditLog.queryAllowed, true));
  const rows = await db
    .select({
      id: auditLog.id,
      actorId: auditLog.employeeId,
      scope: auditLog.queryScope,
      allowed: auditLog.queryAllowed,
      deniedFields: auditLog.deniedFields,
      detail: auditLog.detail,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.createdAt))
    .limit(opts?.limit ?? 100);
  return rows.map((r) => ({
    id: r.id,
    actorId: r.actorId,
    scope: r.scope,
    allowed: r.allowed,
    deniedFields: r.deniedFields,
    purpose: (r.detail as { purpose?: string } | null)?.purpose ?? null,
    createdAt: r.createdAt,
  }));
}

// Governance rollup for the dashboard.
export async function auditSummary(days = 30): Promise<{
  totalQueries: number;
  deniedCount: number;
  byScope: Record<string, { allowed: number; denied: number }>;
}> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ scope: auditLog.queryScope, allowed: auditLog.queryAllowed, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(eq(auditLog.action, "a2a.query"));
  const recent = rows.filter((r) => r.createdAt >= since);
  const byScope: Record<string, { allowed: number; denied: number }> = {};
  let denied = 0;
  for (const r of recent) {
    const k = r.scope ?? "unknown";
    byScope[k] ??= { allowed: 0, denied: 0 };
    if (r.allowed) byScope[k].allowed++;
    else {
      byScope[k].denied++;
      denied++;
    }
  }
  return { totalQueries: recent.length, deniedCount: denied, byScope };
}
