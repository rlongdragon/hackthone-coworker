"use server";

import { revalidatePath } from "next/cache";
import { requireEmployee } from "@/lib/authz";
import { markAllRead, markNotificationRead } from "@/lib/notifications";

// A viewer may only mark THEIR OWN notifications read (scoped by recipientId).
export async function markReadAction(id: string): Promise<{ ok: boolean }> {
  const me = await requireEmployee();
  const ok = await markNotificationRead(id, me.id);
  revalidatePath("/me/ledger");
  return { ok };
}

export async function markAllReadAction(): Promise<{ n: number }> {
  const me = await requireEmployee();
  const n = await markAllRead(me.id);
  revalidatePath("/me/ledger");
  return { n };
}
