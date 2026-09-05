import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { createEvent, listEventsInRange } from "@/lib/event-store";

async function requireUserId() {
  const session = await auth();
  return session?.user?.id ?? null;
}

export async function GET(req: Request) {
  const userId = await requireUserId();
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);
  const start = new Date(url.searchParams.get("start") ?? "");
  const end = new Date(url.searchParams.get("end") ?? "");
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return new Response("Bad range", { status: 400 });
  }
  const rows = await listEventsInRange(userId, start, end);
  return NextResponse.json(
    rows.map((e) => ({
      id: e.id,
      title: e.title,
      start: e.startsAt.toISOString(),
      end: e.endsAt.toISOString(),
      allDay: e.allDay,
    })),
  );
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  start: z.coerce.date(),
  end: z.coerce.date(),
  allDay: z.boolean().optional(),
  description: z.string().max(2000).nullish(),
  location: z.string().max(200).nullish(),
});

export async function POST(req: Request) {
  const userId = await requireUserId();
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response("Bad body", { status: 400 });
  const { title, start, end, allDay, description, location } = parsed.data;
  if (end < start) return new Response("end before start", { status: 400 });
  const ev = await createEvent(userId, {
    title,
    startsAt: start,
    endsAt: end,
    allDay: allDay ?? false,
    description: description ?? null,
    location: location ?? null,
  });
  return NextResponse.json({ id: ev.id }, { status: 201 });
}
