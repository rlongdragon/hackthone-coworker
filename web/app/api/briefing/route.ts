import { generateText } from "ai";
import { NextResponse } from "next/server";
import { and, asc, eq, lte } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { employees, todos } from "@/db/schema";
import { listEventsInRange } from "@/lib/event-store";
import { searchMemories } from "@/lib/memory-store";
import { model } from "@/lib/provider";

// One briefing generation per user per minute — it is an LLM call.
const hits = new Map<string, number>();

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const userId = session.user.id;

  // Same gate as /api/chat: temp-password accounts don't get LLM access.
  const [gate] = await db
    .select({ mustChange: employees.mustChangePassword })
    .from(employees)
    .where(eq(employees.id, userId))
    .limit(1);
  if (!gate) return new Response("Unauthorized", { status: 401 });
  if (gate.mustChange) return new Response("Password change required", { status: 403 });

  const last = hits.get(userId) ?? 0;
  if (Date.now() - last < 60_000) {
    return new Response("Too fast", { status: 429 });
  }

  // "Today" in the user's timezone (Asia/Taipei, UTC+8).
  const now = new Date();
  const tzOffsetMs = 8 * 3600 * 1000;
  const local = new Date(now.getTime() + tzOffsetMs);
  const dayStartLocal = new Date(local.toISOString().slice(0, 10) + "T00:00:00Z");
  const dayStart = new Date(dayStartLocal.getTime() - tzOffsetMs);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);

  const [events, dueTodos, prefs] = await Promise.all([
    listEventsInRange(userId, dayStart, dayEnd),
    db
      .select({ title: todos.title, due: todos.due })
      .from(todos)
      .where(
        and(
          eq(todos.employeeId, userId),
          eq(todos.done, false),
          lte(todos.due, dayEnd),
        ),
      )
      .orderBy(asc(todos.due))
      .limit(20),
    searchMemories(userId, "工作偏好 重要提醒 目前進行中的事", 5, 0.78).catch(
      () => [],
    ),
  ]);

  const fmtT = (d: Date) =>
    d.toLocaleTimeString("zh-TW", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Taipei",
    });

  const context = [
    `今天日期:${local.toISOString().slice(0, 10)}(Asia/Taipei)`,
    events.length
      ? `今日行程:\n${events
          .map((e) => `- ${e.allDay ? "全天" : `${fmtT(e.startsAt)}–${fmtT(e.endsAt)}`} ${e.title}${e.location ? ` @${e.location}` : ""}`)
          .join("\n")}`
      : "今日行程:無",
    dueTodos.length
      ? `今天(含逾期)到期的待辦:\n${dueTodos
          .map((t) => `- ${t.title}${t.due ? `(${t.due.toISOString().slice(0, 10)})` : ""}`)
          .join("\n")}`
      : "今天到期的待辦:無",
    prefs.length
      ? `關於這位員工的長期記憶:\n${prefs.map((p) => `- ${p.content}`).join("\n")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const { text } = await generateText({
    model,
    system:
      "你是員工的 AI 工作夥伴。根據資料寫一份精簡的每日工作簡報:先一句總覽,再條列今天的重點與建議的處理順序。" +
      "有衝突或該提早準備的事要點出來。全部用員工的語言(繁體中文),不要開場白。" +
      "輸出純文字(可用「- 」條列),絕對不要用 Markdown 粗體或其他標記。",
    prompt: context,
    experimental_telemetry: {
      isEnabled: true,
      functionId: "daily-briefing",
      metadata: { employeeId: userId },
    },
  });

  // Stamp only on success — a failed generation shouldn't burn the window.
  hits.set(userId, Date.now());
  return NextResponse.json({ briefing: text.trim() });
}
