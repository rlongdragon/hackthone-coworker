"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { requireAdmin } from "@/lib/authz";
import { actuateFinding, rerunFinding, runRedTeam } from "@/lib/red-team";
import { quarantineMemory, unquarantineMemory } from "@/lib/memory-store";
import { asUuid } from "@/lib/validate";

export type RedTeamState = {
  error?: string;
  ok?: boolean;
  ran?: number;
  detected?: number;
  defended?: number;
};

// Fire one self-red-team pass at the live fleet. Admin-only; audit-logged inside
// runRedTeam. Blue-team auto-tightening happens per-finding: memory quarantine
// and MCP rug-pull blocking always, and (actuate) disabling over-granted tools.
export async function runRedTeamAction(): Promise<RedTeamState> {
  const admin = await requireAdmin();
  try {
    const r = await runRedTeam({ persist: true, actuate: true });
    await db.insert(auditLog).values({
      employeeId: admin.id,
      action: "redteam.trigger",
      detail: { ran: r.ran, detected: r.detected, actuate: true },
    });
    revalidatePath("/admin/governance");
    return { ok: true, ran: r.ran, detected: r.detected, defended: r.defended };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "red-team run failed" };
  }
}

export type FindingActionState =
  | { ok: true; actionTaken: string; applied: string[] }
  | { ok: false; error: string };

// 收緊 / 封鎖: apply the actuator that matches this finding (mcp_drift → block
// the drifted MCP tools; over_privilege → disable the over-granted tool rows).
export async function tightenFindingAction(id: string): Promise<FindingActionState> {
  const admin = await requireAdmin();
  const findingId = asUuid(id);
  if (!findingId) return { ok: false, error: "bad id" };
  try {
    const r = await actuateFinding(findingId);
    if (r.ok) {
      await db.insert(auditLog).values({
        employeeId: admin.id,
        action: "redteam.tighten",
        detail: { findingId, actionTaken: r.actionTaken, applied: r.applied },
      });
    }
    revalidatePath("/admin/governance");
    return r;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "tighten failed" };
  }
}

export type RerunActionState =
  | { ok: true; findingId: string; status: string; actionTaken: string; summary: string }
  | { ok: false; error: string };

// 再跑一次: re-fire only this finding's template at its target; the new finding
// is persisted (a fresh row) and its status returned for inline display.
export async function rerunFindingAction(id: string): Promise<RerunActionState> {
  const admin = await requireAdmin();
  const findingId = asUuid(id);
  if (!findingId) return { ok: false, error: "bad id" };
  try {
    const r = await rerunFinding(findingId);
    if (r.ok) {
      await db.insert(auditLog).values({
        employeeId: admin.id,
        action: "redteam.rerun",
        detail: { from: findingId, findingId: r.findingId, status: r.status },
      });
    }
    revalidatePath("/admin/governance");
    return r;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "rerun failed" };
  }
}

export async function quarantineMemoryAction(id: string): Promise<{ ok: boolean }> {
  const admin = await requireAdmin();
  const ok = await quarantineMemory(id);
  await db.insert(auditLog).values({
    employeeId: admin.id,
    action: "memory.quarantine",
    detail: { memoryId: id },
  });
  revalidatePath("/admin/governance");
  return { ok };
}

export async function unquarantineMemoryAction(id: string): Promise<{ ok: boolean }> {
  const admin = await requireAdmin();
  const ok = await unquarantineMemory(id);
  await db.insert(auditLog).values({
    employeeId: admin.id,
    action: "memory.unquarantine",
    detail: { memoryId: id },
  });
  revalidatePath("/admin/governance");
  return { ok };
}
