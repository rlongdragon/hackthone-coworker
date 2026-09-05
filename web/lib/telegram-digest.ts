import { and, desc, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { telegramGroupMessages, telegramGroups } from "@/db/schema";
import { extractDecisionsAndTasks, ingestCollabEvent } from "@/lib/collab-events";

// ============================================================================
// Telegram group digest (feat/a2a-ledger · P2)
//
// For groups that OPTED IN to context (telegram_groups.context_optin), the
// worker persists non-trigger messages here. A digest (manual `/digest` or the
// daily sweep) rolls the undigested window into ONE collab_event scoped `team`,
// bound to the group's project, tainted (chat = untrusted), and runs the same
// self-hosted decision/action-item extraction as meeting records — so it shows
// up in the project's 會議記錄 card with 需確認 items to dispatch.
// ============================================================================

export async function saveGroupMessage(input: {
  chatId: number;
  senderName: string;
  employeeId?: string | null;
  text: string;
}): Promise<void> {
  await db.insert(telegramGroupMessages).values({
    chatId: input.chatId,
    senderName: input.senderName.slice(0, 100),
    employeeId: input.employeeId ?? null,
    text: input.text.slice(0, 2000),
  });
}

export type DigestResult =
  | { ok: true; eventId: string; messages: number; decisions: number; tasks: number; projectId: string | null }
  | { ok: false; error: string };

// Roll up the undigested messages of one group from the last `hours`.
export async function digestGroup(chatId: number, opts?: { hours?: number; actorId?: string | null }): Promise<DigestResult> {
  const [g] = await db.select().from(telegramGroups).where(eq(telegramGroups.chatId, chatId)).limit(1);
  if (!g) return { ok: false, error: "群組未授權" };
  if (!g.contextOptin) return { ok: false, error: "本群未開啟聊天脈絡(/group_context on),不保存訊息、無法摘要" };
  const since = new Date(Date.now() - (opts?.hours ?? 24) * 3600 * 1000);
  const msgs = await db
    .select()
    .from(telegramGroupMessages)
    .where(and(eq(telegramGroupMessages.chatId, chatId), isNull(telegramGroupMessages.digestedEventId), gte(telegramGroupMessages.sentAt, since)))
    .orderBy(telegramGroupMessages.sentAt)
    .limit(500);
  if (msgs.length === 0) return { ok: false, error: "這段時間沒有新的群組訊息可摘要" };

  const content = msgs.map((m) => `${m.senderName}: ${m.text}`).join("\n");
  const ev = await ingestCollabEvent({
    sourceType: "telegram_group",
    sourceId: String(chatId),
    scopeLabel: "team",
    projectId: g.projectId,
    createdBy: opts?.actorId ?? null,
    content,
    isTainted: true,
  });
  const ext = await extractDecisionsAndTasks(ev.id, content);
  // Mark ONLY the rows that went into this digest (never the whole window) so
  // an over-limit backlog is picked up by the next digest instead of lost.
  await db
    .update(telegramGroupMessages)
    .set({ digestedEventId: ev.id })
    .where(inArray(telegramGroupMessages.id, msgs.map((m) => m.id)));
  return { ok: true, eventId: ev.id, messages: msgs.length, decisions: ext.decisions.length, tasks: ext.tasks.length, projectId: g.projectId };
}

// Privacy controls: /group_context off deletes everything we kept for the
// group; the daily sweep purges digested rows older than `days`.
export async function purgeGroupMessages(chatId: number): Promise<number> {
  const rows = await db.delete(telegramGroupMessages).where(eq(telegramGroupMessages.chatId, chatId)).returning({ id: telegramGroupMessages.id });
  return rows.length;
}

export async function purgeDigestedOlderThan(days = 30): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  const rows = await db
    .delete(telegramGroupMessages)
    .where(and(lt(telegramGroupMessages.sentAt, cutoff), isNotNull(telegramGroupMessages.digestedEventId)))
    .returning({ id: telegramGroupMessages.id });
  return rows.length;
}

// Daily sweep: every opted-in group with undigested messages.
export async function digestAllGroups(hours = 24): Promise<{ chatId: number; result: DigestResult }[]> {
  const groups = await db.select({ chatId: telegramGroups.chatId }).from(telegramGroups).where(eq(telegramGroups.contextOptin, true));
  const out: { chatId: number; result: DigestResult }[] = [];
  for (const g of groups) {
    const [pending] = await db
      .select({ id: telegramGroupMessages.id })
      .from(telegramGroupMessages)
      .where(and(eq(telegramGroupMessages.chatId, g.chatId), isNull(telegramGroupMessages.digestedEventId)))
      .orderBy(desc(telegramGroupMessages.sentAt))
      .limit(1);
    if (!pending) continue;
    out.push({ chatId: g.chatId, result: await digestGroup(g.chatId, { hours }) });
  }
  return out;
}
