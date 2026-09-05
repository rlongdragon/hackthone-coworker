import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { getActiveLinkTgId } from "@/lib/telegram-store";
import type { ScopeLabel } from "@/lib/pep";

// ============================================================================
// Notification dispatcher (feat/a2a-ledger) — the transparency channel. Writing
// a notification is how the SUBJECT learns another agent queried about them,
// allowed or denied. A best-effort Telegram push mirrors it (the app's existing
// bot; never blocks, never throws into the caller).
// ============================================================================

const SCOPE_ZH: Record<ScopeLabel, string> = {
  project: "專案進度",
  team: "團隊事務",
  private: "私人資訊",
  sensitive: "敏感資訊(請假原因/健康/薪資)",
};

export async function notifyQuery(input: {
  subjectId: string;
  actorId: string;
  actorName: string;
  scope: ScopeLabel;
  allowed: boolean;
  purpose: string;
  auditId?: string;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(notifications)
    .values({
      recipientId: input.subjectId,
      actorId: input.actorId,
      type: input.allowed ? "query_allowed" : "query_denied",
      scope: input.scope,
      purpose: input.purpose,
      auditId: input.auditId ?? null,
    })
    .returning({ id: notifications.id });

  // Best-effort Telegram push — the subject sees the denial too.
  void pushTelegram(input).catch(() => {});
  return { id: row.id };
}

async function pushTelegram(input: {
  subjectId: string;
  actorName: string;
  scope: ScopeLabel;
  allowed: boolean;
  purpose: string;
}): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const tgId = await getActiveLinkTgId(input.subjectId);
  if (!tgId) return;
  const mark = input.allowed ? "✅ 已允許" : "⛔ 已拒絕";
  const text =
    `🔎 有人查詢了關於你的資訊\n` +
    `對方:${input.actorName} 的代理\n` +
    `範圍:${SCOPE_ZH[input.scope]}\n` +
    `目的:${input.purpose}\n` +
    `結果:${mark}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: tgId, text }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function getMyNotifications(
  userId: string,
  opts?: { unreadOnly?: boolean; limit?: number },
) {
  const where = opts?.unreadOnly
    ? and(eq(notifications.recipientId, userId), isNull(notifications.readAt))
    : eq(notifications.recipientId, userId);
  return db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt))
    .limit(opts?.limit ?? 50);
}

export async function unreadCount(userId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.recipientId, userId), isNull(notifications.readAt)));
  return r?.n ?? 0;
}

// Scoped to the recipient — a viewer can only mark their OWN notifications read.
export async function markNotificationRead(id: string, userId: string): Promise<boolean> {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.recipientId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length > 0;
}

export async function markAllRead(userId: string): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.recipientId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}
