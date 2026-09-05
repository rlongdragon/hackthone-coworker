import { eq, desc, and, isNotNull } from "drizzle-orm";
import { generateText } from "ai";
import type { UIMessage } from "ai";
import { db } from "@/db";
import { conversations, messages, projects } from "@/db/schema";
import { model } from "@/lib/provider";

// One conversation per AI SDK chat id (= assistant-ui thread). `projectId`
// binds the thread to a project at creation time (ignored for existing rows).
export async function getOrCreateConversation(
  employeeId: string,
  chatId: string,
  projectId?: string | null,
  channel?: string,
): Promise<{ id: string; title: string | null }> {
  const [existing] = await db
    .select({ id: conversations.id, title: conversations.title })
    .from(conversations)
    .where(
      and(eq(conversations.chatId, chatId), eq(conversations.employeeId, employeeId)),
    )
    .limit(1);
  if (existing) return existing;
  // Two first-messages can race here — let the loser fall through to re-select.
  const [c] = await db
    .insert(conversations)
    .values({ employeeId, chatId, projectId: projectId ?? null, channel: channel ?? "web" })
    .onConflictDoNothing()
    .returning({ id: conversations.id, title: conversations.title });
  if (c) return c;
  const [again] = await db
    .select({ id: conversations.id, title: conversations.title })
    .from(conversations)
    .where(
      and(eq(conversations.chatId, chatId), eq(conversations.employeeId, employeeId)),
    )
    .limit(1);
  return again;
}

export async function saveMessage(
  conversationId: string,
  role: string,
  parts: unknown,
): Promise<void> {
  await db.insert(messages).values({ conversationId, role, parts });
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

// Sidebar list: newest first.
export async function listThreads(employeeId: string, limit = 50) {
  return db
    .select({
      chatId: conversations.chatId,
      title: conversations.title,
      updatedAt: conversations.updatedAt,
      projectId: conversations.projectId,
      projectName: projects.name,
    })
    .from(conversations)
    .leftJoin(projects, eq(conversations.projectId, projects.id))
    .where(
      and(eq(conversations.employeeId, employeeId), isNotNull(conversations.chatId)),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
}

// Which project (if any) a thread is bound to.
export async function getThreadProjectId(
  employeeId: string,
  chatId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ projectId: conversations.projectId })
    .from(conversations)
    .where(
      and(eq(conversations.chatId, chatId), eq(conversations.employeeId, employeeId)),
    )
    .limit(1);
  return row?.projectId ?? null;
}

// The employee's own threads inside one project, for the project page.
export async function listMyProjectThreads(employeeId: string, projectId: string) {
  return db
    .select({
      chatId: conversations.chatId,
      title: conversations.title,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.employeeId, employeeId),
        eq(conversations.projectId, projectId),
        isNotNull(conversations.chatId),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(20);
}

// Load a thread's history as AI SDK UIMessages (for useChatRuntime initial messages).
export async function loadUIMessages(
  employeeId: string,
  chatId: string,
): Promise<UIMessage[]> {
  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(eq(conversations.chatId, chatId), eq(conversations.employeeId, employeeId)),
    )
    .limit(1);
  if (!conv) return [];
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(messages.createdAt);
  return rows.map((r) => ({
    id: r.id,
    role: r.role as UIMessage["role"],
    parts: r.parts as UIMessage["parts"],
  }));
}

// Auto-title: fire-and-forget after the first exchange. Small LLM call.
export async function maybeAutoTitle(
  conversationId: string,
  currentTitle: string | null,
  userText: string,
  assistantText: string,
): Promise<void> {
  if (currentTitle) return;
  try {
    const { text } = await generateText({
      model,
      prompt:
        `用使用者的語言,為這段對話取一個 4-10 字的短標題。只回標題本身,不要引號或句號。\n` +
        `使用者:${userText.slice(0, 300)}\n助理:${assistantText.slice(0, 300)}`,
      experimental_telemetry: { isEnabled: true, functionId: "auto-title" },
    });
    const title = text.trim().slice(0, 60);
    if (title) {
      await db
        .update(conversations)
        .set({ title })
        .where(eq(conversations.id, conversationId));
    }
  } catch (e) {
    console.warn("auto-title failed:", e instanceof Error ? e.message : e);
  }
}
