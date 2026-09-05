import { and, asc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, eventNotes, events } from "@/db/schema";

export async function listEventsInRange(
  employeeId: string,
  start: Date,
  end: Date,
) {
  return db
    .select()
    .from(events)
    .where(
      and(
        eq(events.employeeId, employeeId),
        lt(events.startsAt, end),
        gte(events.endsAt, start),
      ),
    )
    .orderBy(asc(events.startsAt));
}

export async function getEventWithNotes(eventId: string, employeeId: string) {
  const [ev] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.employeeId, employeeId)))
    .limit(1);
  if (!ev) return null;
  const notes = await db
    .select()
    .from(eventNotes)
    .where(eq(eventNotes.eventId, eventId))
    .orderBy(asc(eventNotes.createdAt));
  return { event: ev, notes };
}

export async function createEvent(
  employeeId: string,
  data: {
    title: string;
    startsAt: Date;
    endsAt: Date;
    allDay?: boolean;
    description?: string | null;
    location?: string | null;
  },
) {
  const [ev] = await db
    .insert(events)
    .values({ employeeId, ...data })
    .returning();
  await db.insert(auditLog).values({
    employeeId,
    action: "event.create",
    detail: { eventId: ev.id, title: ev.title },
  });
  return ev;
}

export async function updateEvent(
  eventId: string,
  employeeId: string,
  patch: Partial<{
    title: string;
    description: string | null;
    location: string | null;
    startsAt: Date;
    endsAt: Date;
    allDay: boolean;
  }>,
) {
  const [ev] = await db
    .update(events)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(events.id, eventId), eq(events.employeeId, employeeId)))
    .returning();
  if (ev) {
    await db.insert(auditLog).values({
      employeeId,
      action: "event.update",
      detail: { eventId, fields: Object.keys(patch) },
    });
  }
  return ev ?? null;
}

export async function deleteEvent(eventId: string, employeeId: string) {
  const rows = await db
    .delete(events)
    .where(and(eq(events.id, eventId), eq(events.employeeId, employeeId)))
    .returning({ id: events.id });
  if (rows.length > 0) {
    await db.insert(auditLog).values({
      employeeId,
      action: "event.delete",
      detail: { eventId },
    });
  }
  return rows.length > 0;
}

export async function addEventNote(
  eventId: string,
  employeeId: string,
  content: string,
  authorType: "user" | "ai" = "user",
) {
  // Note must attach to the caller's own event.
  const [ev] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.employeeId, employeeId)))
    .limit(1);
  if (!ev) return null;
  const [note] = await db
    .insert(eventNotes)
    .values({ eventId, authorId: employeeId, authorType, content })
    .returning();
  return note;
}
