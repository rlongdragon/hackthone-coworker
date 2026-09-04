"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { requireAdmin } from "@/lib/authz";
import { runRedTeam } from "@/lib/red-team";
import { quarantineMemory, unquarantineMemory } from "@/lib/memory-store";

export type RedTeamState = {
  error?: string;
  ok?: boolean;
  ran?: number;
  detected?: number;
  defended?: number;
};

// Fire one self-red-team pass at the live fleet. Admin-only; audit-logged inside
// runRedTeam. Blue-team auto-tightening (memory quarantine) happens per-finding.
export async function runRedTeamAction(): Promise<RedTeamState> {
  const admin = await requireAdmin();
  try {
    const r = await runRedTeam({ persist: true });
    await db.insert(auditLog).values({
      employeeId: admin.id,
      action: "redteam.trigger",
      detail: { ran: r.ran, detected: r.detected },
    });
    revalidatePath("/admin/governance");
    return { ok: true, ran: r.ran, detected: r.detected, defended: r.defended };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "red-team run failed" };
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
