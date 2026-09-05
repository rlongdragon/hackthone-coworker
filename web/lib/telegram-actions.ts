"use server";

import { revalidatePath } from "next/cache";
import { requireEmployee } from "@/lib/authz";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { createLinkCode, unlinkByEmployee } from "@/lib/telegram-store";

// Issue a one-time code the employee sends to the bot as `/link <code>`.
export async function generateTelegramLinkCode(): Promise<{ code: string }> {
  const user = await requireEmployee();
  const code = await createLinkCode(user.id);
  await db.insert(auditLog).values({
    employeeId: user.id,
    action: "telegram.link_code",
    detail: { channel: "web" },
  });
  return { code };
}

export async function unlinkTelegramAction(): Promise<void> {
  const user = await requireEmployee();
  const removed = await unlinkByEmployee(user.id);
  if (removed) {
    await db.insert(auditLog).values({
      employeeId: user.id,
      action: "telegram.unlink",
      detail: { channel: "web" },
    });
  }
  revalidatePath("/me");
}
