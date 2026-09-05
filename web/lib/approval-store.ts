import { and, count, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, departments, employees, pendingActions } from "@/db/schema";
import { findVisibleToolById } from "@/lib/tool-store";
import { executeAction } from "@/lib/tool-runtime";
import { resolveAgentTool, runMcpToolGuarded } from "@/lib/mcp-exec";
import { runScopedAsk } from "@/lib/delegation";
import type { ScopeLabel } from "@/lib/pep";
import { assignTodoFromDispatch, markMeetingTask } from "@/lib/meeting-store";
import { sendMail } from "@/lib/mail-store";

const TTL_MS = 10 * 60 * 1000;

// ---- executor registry ------------------------------------------------------
// Each sensitive action: who may run it, and what actually happens on approve.
// Executors re-validate everything at execution time — the pending row is an
// intent, never a capability.

type ExecResult = { ok: boolean; message: string };

type ActionDef = {
  requiredRole: "admin" | "manager" | "employee";
  execute: (params: Record<string, unknown>, actorId: string) => Promise<ExecResult>;
};

async function findEmployeeByEmail(email: string) {
  const [u] = await db
    .select({ id: employees.id, role: employees.role, name: employees.name })
    .from(employees)
    .where(eq(employees.email, email.toLowerCase().trim()))
    .limit(1);
  return u ?? null;
}

const ACTIONS: Record<string, ActionDef> = {
  "admin.assignDepartment": {
    requiredRole: "admin",
    execute: async (params, actorId) => {
      const email = String(params.email ?? "");
      const departmentName = params.departmentName
        ? String(params.departmentName)
        : null;
      const target = await findEmployeeByEmail(email);
      if (!target) return { ok: false, message: `找不到員工 ${email}` };
      let departmentId: string | null = null;
      if (departmentName) {
        const [d] = await db
          .select({ id: departments.id })
          .from(departments)
          .where(eq(departments.name, departmentName))
          .limit(1);
        if (!d) return { ok: false, message: `找不到部門「${departmentName}」` };
        departmentId = d.id;
      }
      await db
        .update(employees)
        .set({ departmentId })
        .where(eq(employees.id, target.id));
      await db.insert(auditLog).values({
        employeeId: actorId,
        action: "admin.employee.assignDepartment",
        detail: { targetId: target.id, email, departmentName, via: "agent-approval" },
      });
      return {
        ok: true,
        message: departmentName
          ? `已把 ${target.name} 指派到「${departmentName}」`
          : `已移除 ${target.name} 的部門`,
      };
    },
  },
  "admin.setRole": {
    requiredRole: "admin",
    execute: async (params, actorId) => {
      const email = String(params.email ?? "");
      const role = String(params.role ?? "");
      if (!["employee", "manager", "admin"].includes(role)) {
        return { ok: false, message: "角色不合法" };
      }
      const target = await findEmployeeByEmail(email);
      if (!target) return { ok: false, message: `找不到員工 ${email}` };
      if (target.role === "admin" && role !== "admin") {
        const [{ others }] = await db
          .select({ others: count() })
          .from(employees)
          .where(and(eq(employees.role, "admin"), ne(employees.id, target.id)));
        if (others === 0) return { ok: false, message: "不能降級最後一位管理員" };
      }
      await db
        .update(employees)
        .set({ role: role as "employee" | "manager" | "admin" })
        .where(eq(employees.id, target.id));
      await db.insert(auditLog).values({
        employeeId: actorId,
        action: "admin.employee.setRole",
        detail: { targetId: target.id, email, role, via: "agent-approval" },
      });
      return { ok: true, message: `已把 ${target.name} 的角色改為 ${role}` };
    },
  },
  // A sensitive shared action tool. Visibility (personal/dept/org) is the gate —
  // re-checked here at execution time, not at proposal time.
  "tool.action": {
    requiredRole: "employee",
    execute: async (params, actorId) => {
      const toolId = String(params.toolId ?? "");
      const args = (params.args ?? {}) as Record<string, string>;
      const tool = await findVisibleToolById(actorId, toolId);
      if (!tool || tool.kind !== "action") {
        return { ok: false, message: "找不到工具或無權使用" };
      }
      const r = await executeAction(tool, args, actorId);
      if (!r.ok) return { ok: false, message: `執行失敗:${r.error ?? r.status}` };
      return { ok: true, message: `已執行「${tool.name}」(HTTP ${r.status})` };
    },
  },
  // An MCP tool marked HITL. Visibility + enabled + non-blocked is re-checked
  // here (resolveAgentTool), then run through the rug-pull guard.
  "mcp.tool": {
    requiredRole: "employee",
    execute: async (params, actorId) => {
      const serverId = String(params.serverId ?? "");
      const toolName = String(params.toolName ?? "");
      const args = (params.args ?? {}) as Record<string, unknown>;
      const t = await resolveAgentTool(actorId, serverId, toolName);
      if (!t) return { ok: false, message: "找不到 MCP 工具或已停用/無權使用" };
      const r = await runMcpToolGuarded(t, args);
      if (!r.ok) return { ok: false, message: r.text };
      return { ok: true, message: `已執行「${t.serverName} · ${toolName}」` };
    },
  },
  // A cross-department delegation the CALLEE must consent to. The pending row's
  // requester IS the callee (the approver), so actorId here is the coworker who
  // was asked. On approval the sub-run executes as them, still under the
  // intersected scope of the delegation chain (caller ∩ callee).
  "delegation.ask": {
    requiredRole: "employee",
    execute: async (params, actorId) => {
      const callerId = String(params.callerId ?? "");
      const question = String(params.question ?? "");
      const target = String(params.target ?? "");
      const scope = (String(params.scope ?? "team") as ScopeLabel);
      const purpose = params.purpose ? String(params.purpose) : undefined;
      const chain = Array.isArray(params.chain) ? params.chain.map(String) : [callerId];
      // Post-consent: run the full scoped path now (ledger + subject notify are
      // written HERE, after the callee approved — never pre-recorded as allowed).
      // allowHitl:false so it actually executes rather than re-parking. actorId
      // is the consenting callee; runScopedAsk re-resolves + re-checks the PEP.
      const r = await runScopedAsk({ callerId, target, question, scope, purpose, chain, allowHitl: false });
      void actorId;
      if (!r.ok) return { ok: false, message: "error" in r ? r.error : "委派未成立" };
      return { ok: true, message: `已同意並在交集權限下回覆:${r.answer.slice(0, 500)}` };
    },
  },
  // Cross-department task dispatch: the ASSIGNEE (requester == approver) must
  // consent before a manager from another department can put a task on their
  // list. On approval the todo is created as them, with assignedBy provenance.
  "dispatch.assign": {
    requiredRole: "employee",
    execute: async (params, actorId) => {
      const title = String(params.title ?? "").trim();
      const assignedBy = String(params.assignedBy ?? "");
      const projectId = params.projectId ? String(params.projectId) : null;
      const eventId = params.eventId ? String(params.eventId) : null;
      const index = Number(params.index ?? -1);
      if (!title || !assignedBy) return { ok: false, message: "指派內容不完整" };
      const { todoId } = await assignTodoFromDispatch({ assigneeId: actorId, assignedBy, projectId, title });
      if (eventId && index >= 0) await markMeetingTask(eventId, index, { todoId, status: "assigned", pendingId: undefined });
      await db.insert(auditLog).values({
        employeeId: assignedBy,
        action: "dispatch.assign",
        detail: { assigneeId: actorId, projectId, title, todoId, via: "cross-dept-approval" },
      });
      return { ok: true, message: `已接受指派:「${title}」已加入你的待辦` };
    },
  },
  // Outbound mail ALWAYS goes through here: the employee (requester == approver)
  // confirms the exact to/subject/body before anything leaves their mailbox.
  // Sent as them, via their own SMTP credentials.
  "mail.send": {
    requiredRole: "employee",
    execute: async (params, actorId) => {
      const to = String(params.to ?? "").trim();
      const subject = String(params.subject ?? "").trim();
      const text = String(params.text ?? "");
      if (!to || !subject) return { ok: false, message: "收件人與主旨必填" };
      const r = await sendMail(actorId, { to, subject, text });
      if (!r.ok) return { ok: false, message: r.error };
      return { ok: true, message: `已寄出給 ${to}:「${subject}」` };
    },
  },
};

export function isKnownAction(action: string): boolean {
  return action in ACTIONS;
}

// ---- lifecycle --------------------------------------------------------------

export async function createPendingAction(
  requesterId: string,
  action: string,
  params: Record<string, unknown>,
): Promise<{ id: string; expiresAt: Date }> {
  if (!isKnownAction(action)) throw new Error(`unknown action ${action}`);
  const expiresAt = new Date(Date.now() + TTL_MS);
  const [row] = await db
    .insert(pendingActions)
    .values({ requesterId, action, params, expiresAt })
    .returning({ id: pendingActions.id });
  return { id: row.id, expiresAt };
}

export async function resolvePendingAction(
  id: string,
  actorId: string,
  actorRole: string,
  decision: "approve" | "reject",
): Promise<ExecResult> {
  // Claim atomically into an intermediate state: only one resolver wins, and
  // only the requester may act. The *final* status is written after the
  // outcome is known — "approved" in the audit trail always means "ran ok".
  const [row] = await db
    .update(pendingActions)
    .set({
      status: decision === "approve" ? "executing" : "rejected",
      resolvedAt: new Date(),
    })
    .where(
      and(
        eq(pendingActions.id, id),
        eq(pendingActions.requesterId, actorId),
        eq(pendingActions.status, "pending"),
      ),
    )
    .returning();
  if (!row) return { ok: false, message: "找不到待審核動作(可能已處理過)" };

  if (decision === "reject") {
    return { ok: true, message: "已拒絕,未執行任何變更" };
  }

  const finalize = async (status: string, result: ExecResult) => {
    await db
      .update(pendingActions)
      .set({ status, result })
      .where(eq(pendingActions.id, id));
    return result;
  };

  if (row.expiresAt < new Date()) {
    return finalize("expired", { ok: false, message: "已過期,請重新請 AI 發起" });
  }

  const def = ACTIONS[row.action];
  if (!def) return finalize("failed", { ok: false, message: "未知動作" });
  // Role re-checked at execution time, not proposal time.
  const roleRank = { employee: 0, manager: 1, admin: 2 } as const;
  if (
    roleRank[(actorRole as keyof typeof roleRank) ?? "employee"] <
    roleRank[def.requiredRole]
  ) {
    return finalize("failed", { ok: false, message: "權限不足" });
  }

  try {
    const result = await def.execute(row.params as Record<string, unknown>, actorId);
    return finalize(result.ok ? "approved" : "failed", result);
  } catch (e) {
    console.error("pending action execute failed:", e);
    return finalize("failed", { ok: false, message: "執行失敗,請再試一次" });
  }
}
