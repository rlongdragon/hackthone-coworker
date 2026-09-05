import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { collabEvents, employees, notifications, todos } from "@/db/schema";
import { extractDecisionsAndTasks, ingestCollabEvent } from "@/lib/collab-events";
import { asrConfigured, transcribeAudio } from "@/lib/asr";

// ============================================================================
// Meeting records (feat/a2a-ledger · P2 made operable)
//
// A meeting (audio → self-hosted ASR, or a pasted transcript) becomes ONE
// collab_event scoped `team`, tainted (untrusted input), with decisions +
// action items extracted by the self-hosted model. Every action item stays
// 需確認 until a human confirms it and picks an assignee; confirming creates a
// todo with `assignedBy` (manager dispatch). Cross-department dispatch is
// parked for the ASSIGNEE's consent (HITL) — the route decides that, this
// module stays free of the approval-store import.
// ============================================================================

export type MeetingTask = {
  title: string;
  assignee?: string; // name hint from extraction (untrusted)
  needsConfirm: boolean;
  assigneeId?: string;
  assigneeName?: string;
  todoId?: string;
  pendingId?: string; // cross-dept consent pending
  status?: "unconfirmed" | "assigned" | "pending_consent";
};

export type MeetingRecord = {
  id: string;
  projectId: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
  source: "audio" | "text" | "telegram";
  transcript: string;
  decisions: string[];
  tasks: MeetingTask[];
  tainted: boolean;
  asr?: { mock?: boolean; sessionId?: string };
};

type Extracted = {
  decisions?: string[];
  tasks?: MeetingTask[];
  tainted?: boolean;
  asr?: { mock?: boolean; sessionId?: string };
};

async function mapRows(rows: (typeof collabEvents.$inferSelect)[]): Promise<MeetingRecord[]> {
  const creatorIds = [...new Set(rows.map((r) => r.createdBy).filter(Boolean))] as string[];
  const assigneeIds = [
    ...new Set(
      rows.flatMap((r) => ((r.extractedData as Extracted | null)?.tasks ?? []).map((t) => t.assigneeId).filter(Boolean)),
    ),
  ] as string[];
  const ids = [...new Set([...creatorIds, ...assigneeIds])];
  const people = ids.length
    ? await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, ids))
    : [];
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  return rows.map((r) => {
    const ex = (r.extractedData as Extracted | null) ?? {};
    return {
      id: r.id,
      projectId: r.projectId,
      createdBy: r.createdBy,
      createdByName: r.createdBy ? (nameOf.get(r.createdBy) ?? null) : null,
      createdAt: r.createdAt,
      source: r.sourceType === "telegram_group" ? "telegram" : r.sourceId === "audio" ? "audio" : "text",
      transcript: r.content ?? "",
      decisions: ex.decisions ?? [],
      tasks: (ex.tasks ?? []).map((t) => ({
        ...t,
        status: t.status ?? (t.todoId ? "assigned" : t.pendingId ? "pending_consent" : "unconfirmed"),
        assigneeName: t.assigneeId ? nameOf.get(t.assigneeId) : undefined,
      })),
      tainted: r.isTainted,
      asr: ex.asr,
    };
  });
}

export async function listMeetingRecords(projectId: string): Promise<MeetingRecord[]> {
  const rows = await db
    .select()
    .from(collabEvents)
    .where(eq(collabEvents.projectId, projectId))
    .orderBy(desc(collabEvents.createdAt));
  return mapRows(rows.filter((r) => r.sourceType === "meeting_asr" || r.sourceType === "telegram_group"));
}

export async function getMeetingRecord(eventId: string): Promise<MeetingRecord | null> {
  const [row] = await db.select().from(collabEvents).where(eq(collabEvents.id, eventId)).limit(1);
  if (!row) return null;
  return (await mapRows([row]))[0];
}

// Audio (→ ASR) or pasted transcript → collab event → extraction.
export async function createMeetingRecord(input: {
  projectId: string;
  createdBy: string;
  transcript?: string;
  audio?: { bytes: Uint8Array; filename: string };
}): Promise<{ ok: true; record: MeetingRecord } | { ok: false; error: string }> {
  let transcript = input.transcript?.trim() ?? "";
  let asr: { mock?: boolean; sessionId?: string } | undefined;
  if (!transcript && input.audio) {
    if (!asrConfigured()) return { ok: false, error: "尚未設定 ASR 服務(ASR_BASE_URL),請改貼逐字稿。" };
    const r = await transcribeAudio(input.audio.bytes, input.audio.filename);
    if (!r.ok) return { ok: false, error: `語音轉文字失敗:${r.error}` };
    transcript = r.transcript.trim();
    asr = { mock: r.mock, sessionId: r.sessionId };
  }
  if (!transcript) return { ok: false, error: "請上傳會議音檔或貼上逐字稿。" };
  if (transcript.length > 200_000) return { ok: false, error: "逐字稿過長(上限 200k 字)。" };

  const ev = await ingestCollabEvent({
    sourceType: "meeting_asr",
    sourceId: input.audio ? "audio" : "text",
    scopeLabel: "team",
    projectId: input.projectId,
    createdBy: input.createdBy,
    content: transcript,
    isTainted: true,
  });
  const ext = await extractDecisionsAndTasks(ev.id, transcript);
  // Keep the ASR provenance beside the extraction.
  await db
    .update(collabEvents)
    .set({ extractedData: { ...ext, tasks: ext.tasks.map((t) => ({ ...t, status: "unconfirmed" })), asr } })
    .where(eq(collabEvents.id, ev.id));
  const record = await getMeetingRecord(ev.id);
  if (!record) return { ok: false, error: "建立失敗" };
  return { ok: true, record };
}

// Patch one extracted task in place (index into extractedData.tasks).
export async function markMeetingTask(
  eventId: string,
  index: number,
  patch: Partial<MeetingTask>,
): Promise<boolean> {
  const [row] = await db.select({ ex: collabEvents.extractedData }).from(collabEvents).where(eq(collabEvents.id, eventId)).limit(1);
  const ex = (row?.ex as Extracted | null) ?? null;
  if (!ex || !ex.tasks || !ex.tasks[index]) return false;
  ex.tasks[index] = { ...ex.tasks[index], ...patch };
  await db.update(collabEvents).set({ extractedData: ex }).where(eq(collabEvents.id, eventId));
  return true;
}

// Manager dispatch primitive: create the todo for the assignee, record who
// assigned it, and notify the assignee (task_assigned). Pure — the cross-dept
// consent decision happens in the caller (route / approval executor).
export async function assignTodoFromDispatch(input: {
  assigneeId: string;
  assignedBy: string;
  projectId: string | null;
  title: string;
}): Promise<{ todoId: string }> {
  const [t] = await db
    .insert(todos)
    .values({
      employeeId: input.assigneeId,
      projectId: input.projectId,
      title: input.title.slice(0, 200),
      assignedBy: input.assignedBy,
      status: "assigned",
    })
    .returning({ id: todos.id });
  await db.insert(notifications).values({
    recipientId: input.assigneeId,
    actorId: input.assignedBy,
    type: "task_assigned",
    scope: "project",
    purpose: `指派任務:${input.title.slice(0, 80)}`,
  });
  return { todoId: t.id };
}
