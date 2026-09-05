import { NextResponse } from "next/server";
import { z } from "zod";
import { generateText } from "ai";
import { auth } from "@/auth";
import { model } from "@/lib/provider";
import { addEventNote, getEventWithNotes } from "@/lib/event-store";
import { asUuid } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

// Cheap per-user throttle on the AI branch — generateText costs money.
const aiNoteHits = new Map<string, { count: number; resetAt: number }>();
const AI_NOTE_LIMIT = 10; // per minute per user

function aiNoteAllowed(userId: string): boolean {
  const now = Date.now();
  const e = aiNoteHits.get(userId);
  if (!e || now > e.resetAt) {
    aiNoteHits.set(userId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  e.count += 1;
  return e.count <= AI_NOTE_LIMIT;
}

const bodySchema = z.union([
  // plain user note
  z.object({ content: z.string().min(1).max(4000) }),
  // ask the AI to write the note from an instruction
  z.object({ ai: z.literal(true), instruction: z.string().min(1).max(2000) }),
]);

export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const userId = session.user.id;
  const id = asUuid((await ctx.params).id);
  if (!id) return new Response("Not found", { status: 404 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response("Bad body", { status: 400 });

  if ("content" in parsed.data) {
    const note = await addEventNote(id, userId, parsed.data.content, "user");
    if (!note) return new Response("Not found", { status: 404 });
    return NextResponse.json({ id: note.id }, { status: 201 });
  }

  // AI-written note: give the model the event context + prior notes.
  if (!aiNoteAllowed(userId)) {
    return new Response("Too many AI notes, slow down", { status: 429 });
  }
  const data = await getEventWithNotes(id, userId);
  if (!data) return new Response("Not found", { status: 404 });
  const { event, notes } = data;
  const context = [
    `事件:${event.title}`,
    `時間:${event.startsAt.toISOString()} → ${event.endsAt.toISOString()}`,
    event.location ? `地點:${event.location}` : null,
    event.description ? `說明:${event.description}` : null,
    notes.length
      ? `既有筆記:\n${notes.map((n) => `- [${n.authorType}] ${n.content}`).join("\n")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const { text } = await generateText({
    model,
    system:
      "你是使用者的 AI 工作夥伴。根據行事曆事件的資訊與使用者的指示,寫一則要附加在該事件上的筆記。" +
      "直接輸出筆記內容本身(用使用者的語言,條列或短段落皆可),不要開場白、不要引號。",
    prompt: `${context}\n\n使用者指示:${parsed.data.instruction}`,
    experimental_telemetry: {
      isEnabled: true,
      functionId: "event-ai-note",
      metadata: { eventId: id, employeeId: userId },
    },
  });

  const content = text.trim();
  if (!content) return new Response("empty", { status: 502 });
  const note = await addEventNote(id, userId, content, "ai");
  if (!note) return new Response("Not found", { status: 404 });
  return NextResponse.json(
    { id: note.id, content, createdAt: note.createdAt.toISOString() },
    { status: 201 },
  );
}
