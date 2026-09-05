import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMembership } from "@/lib/project-store";
import { getMeetingRecord } from "@/lib/meeting-store";
import { dispatchTask } from "@/lib/dispatch";
import { asUuid } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string; eventId: string }> };

// Confirm extracted action items and dispatch them through the one dispatch
// rule (lib/dispatch): same-department → todo now; cross-department → parked
// for the assignee's consent (HITL). Already-handled items are skipped.
export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const { id, eventId: rawEvent } = await ctx.params;
  const projectId = asUuid(id);
  const eventId = asUuid(rawEvent);
  if (!projectId || !eventId) return new Response("Not found", { status: 404 });
  if (!(await getMembership(projectId, session.user.id))) return new Response("Not found", { status: 404 });
  const record = await getMeetingRecord(eventId);
  if (!record || record.projectId !== projectId) return new Response("Not found", { status: 404 });

  const body = (await req.json().catch(() => null)) as { items?: { index: number; assigneeId: string }[] } | null;
  const items = (body?.items ?? []).filter((i) => Number.isInteger(i.index) && asUuid(i.assigneeId));
  if (!items.length) return NextResponse.json({ error: "沒有選擇任何項目" }, { status: 400 });

  const results: { index: number; status: "assigned" | "pending_consent" | "skipped"; todoId?: string; pendingId?: string; error?: string }[] = [];
  for (const it of items) {
    const task = record.tasks[it.index];
    if (!task || task.status === "assigned" || task.status === "pending_consent") {
      results.push({ index: it.index, status: "skipped" });
      continue;
    }
    const r = await dispatchTask({
      actorId: session.user.id,
      projectId,
      assigneeId: it.assigneeId,
      title: task.title,
      eventId,
      index: it.index,
    });
    if (!r.ok) results.push({ index: it.index, status: "skipped", error: r.error });
    else if (r.status === "assigned") results.push({ index: it.index, status: "assigned", todoId: r.todoId });
    else results.push({ index: it.index, status: "pending_consent", pendingId: r.pendingId });
  }
  return NextResponse.json({ results, record: await getMeetingRecord(eventId) });
}
