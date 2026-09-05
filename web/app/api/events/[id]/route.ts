import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { deleteEvent, getEventWithNotes, updateEvent } from "@/lib/event-store";
import { asUuid } from "@/lib/validate";

async function requireUserId() {
  const session = await auth();
  return session?.user?.id ?? null;
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const userId = await requireUserId();
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const id = asUuid((await ctx.params).id);
  if (!id) return new Response("Not found", { status: 404 });
  const data = await getEventWithNotes(id, userId);
  if (!data) return new Response("Not found", { status: 404 });
  return NextResponse.json({
    event: {
      id: data.event.id,
      title: data.event.title,
      description: data.event.description,
      location: data.event.location,
      start: data.event.startsAt.toISOString(),
      end: data.event.endsAt.toISOString(),
      allDay: data.event.allDay,
      source: data.event.source,
    },
    notes: data.notes.map((n) => ({
      id: n.id,
      authorType: n.authorType,
      content: n.content,
      createdAt: n.createdAt.toISOString(),
    })),
  });
}

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  start: z.coerce.date().optional(),
  end: z.coerce.date().optional(),
  allDay: z.boolean().optional(),
});

export async function PATCH(req: Request, ctx: Ctx) {
  const userId = await requireUserId();
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const id = asUuid((await ctx.params).id);
  if (!id) return new Response("Not found", { status: 404 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response("Bad body", { status: 400 });
  const { start, end, ...rest } = parsed.data;

  // Cross-check the *effective* range — a partial patch must never persist a
  // negative-duration event.
  const existing = await getEventWithNotes(id, userId);
  if (!existing) return new Response("Not found", { status: 404 });
  const effStart = start ?? existing.event.startsAt;
  const effEnd = end ?? existing.event.endsAt;
  if (effEnd < effStart) return new Response("end before start", { status: 400 });

  const ev = await updateEvent(id, userId, {
    ...rest,
    ...(start ? { startsAt: start } : {}),
    ...(end ? { endsAt: end } : {}),
  });
  if (!ev) return new Response("Not found", { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const userId = await requireUserId();
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const id = asUuid((await ctx.params).id);
  if (!id) return new Response("Not found", { status: 404 });
  const ok = await deleteEvent(id, userId);
  if (!ok) return new Response("Not found", { status: 404 });
  return NextResponse.json({ ok: true });
}
