import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { collabEvents, employees, notifications, pendingActions, todos } from "@/db/schema";
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
  truncated?: boolean;
  analysedChars?: number;
};

type Extracted = {
  decisions?: string[];
  tasks?: MeetingTask[];
  tainted?: boolean;
  asr?: { mock?: boolean; sessionId?: string };
  truncated?: boolean;
  analysedChars?: number;
};

async function mapRows(rows: (typeof collabEvents.$inferSelect)[]): Promise<MeetingRecord[]> {
  const creatorIds = [...new Set(rows.map((r) => r.createdBy).filter(Boolean))] as string[];
  const taskRows = (r: (typeof collabEvents.$inferSelect)) => {
    const ts = (r.extractedData as Extracted | null)?.tasks;
    return (Array.isArray(ts) ? ts : []).filter((t): t is MeetingTask => !!t && typeof t === "object");
  };
  const assigneeIds = [
    ...new Set(rows.flatMap((r) => taskRows(r).map((t) => t.assigneeId).filter((v): v is string => typeof v === "string"))),
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
      decisions: (Array.isArray(ex.decisions) ? ex.decisions : []).filter((d) => typeof d === "string").map((d) => d.slice(0, 500)),
      // extractedData is model-derived (untrusted): coerce every field we render
      // so a malformed row can never crash the page.
      tasks: (Array.isArray(ex.tasks) ? ex.tasks : [])
        .filter((t) => t && typeof t === "object" && typeof (t as MeetingTask).title === "string")
        .map((t) => ({
          ...t,
          title: String(t.title).slice(0, 200),
          assignee: typeof t.assignee === "string" ? t.assignee.slice(0, 100) : undefined,
          status: t.status ?? (t.todoId ? "assigned" : t.pendingId ? "pending_consent" : "unconfirmed"),
          assigneeName: t.assigneeId ? nameOf.get(t.assigneeId) : undefined,
        })),
      tainted: r.isTainted,
      asr: ex.asr,
      truncated: ex.truncated,
      analysedChars: ex.analysedChars,
    };
  });
}

export async function listMeetingRecords(projectId: string): Promise<MeetingRecord[]> {
  const rows = await db
    .select()
    .from(collabEvents)
    .where(eq(collabEvents.projectId, projectId))
    .orderBy(desc(collabEvents.createdAt));
  return refreshStaleConsents(await mapRows(rows.filter((r) => r.sourceType === "meeting_asr" || r.sourceType === "telegram_group")));
}

export async function getMeetingRecord(eventId: string): Promise<MeetingRecord | null> {
  const [row] = await db.select().from(collabEvents).where(eq(collabEvents.id, eventId)).limit(1);
  if (!row) return null;
  return (await refreshStaleConsents(await mapRows([row])))[0];
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

// Atomically CLAIM an unconfirmed task for dispatch: flips tasks[index].status
// from "unconfirmed" to "claiming" only if it is still unconfirmed, in ONE
// UPDATE, so concurrent confirms cannot both create a todo (one wins, the
// others see no row). The caller then finalises with markMeetingTask.
export async function claimMeetingTask(eventId: string, index: number): Promise<boolean> {
  const idx = Math.trunc(index);
  if (!Number.isInteger(idx) || idx < 0) return false;
  // The array index MUST be an integer literal: a bound parameter is typed text
  // and `jsonb -> text` looks up an object key (→ NULL → the coalesce would
  // treat every row as unconfirmed and the claim would never exclude anything).
  const i = sql.raw(String(idx));
  const path = sql.raw(`'{tasks,${idx},status}'`);
  const rows = await db.execute(sql`
    UPDATE collab_events
    SET extracted_data = jsonb_set(extracted_data, ${path}, '"claiming"'::jsonb, false)
    WHERE id = ${eventId}
      AND jsonb_typeof(extracted_data->'tasks') = 'array'
      AND jsonb_array_length(extracted_data->'tasks') > ${i}
      AND jsonb_typeof(extracted_data->'tasks'->${i}) = 'object'
      AND coalesce(extracted_data->'tasks'->${i}->>'status', 'unconfirmed') = 'unconfirmed'
    RETURNING id
  `);
  return (rows as unknown as { length: number }).length > 0;
}

// Undo a claim that could not complete (e.g. assignee validation failed).
export async function releaseMeetingTask(eventId: string, index: number): Promise<void> {
  await markMeetingTask(eventId, index, { status: "unconfirmed", pendingId: undefined, todoId: undefined });
}

// A pending_consent task whose pending action was rejected / expired / failed
// is handed back as unconfirmed so it can be re-dispatched (never stuck).
async function refreshStaleConsents(records: MeetingRecord[]): Promise<MeetingRecord[]> {
  const pendingIds = records.flatMap((r) => r.tasks.map((t) => t.pendingId).filter(Boolean)) as string[];
  if (!pendingIds.length) return records;
  const rows = await db
    .select({ id: pendingActions.id, status: pendingActions.status, expiresAt: pendingActions.expiresAt })
    .from(pendingActions)
    .where(inArray(pendingActions.id, pendingIds));
  const stale = new Set(
    rows.filter((p) => p.status !== "pending" && p.status !== "executing" && p.status !== "approved" || (p.status === "pending" && p.expiresAt < new Date())).map((p) => p.id),
  );
  for (const id of pendingIds) if (!rows.some((p) => p.id === id)) stale.add(id); // row vanished
  if (!stale.size) return records;
  for (const r of records) {
    for (let i = 0; i < r.tasks.length; i++) {
      const t = r.tasks[i];
      if (t.pendingId && stale.has(t.pendingId) && t.status === "pending_consent") {
        await markMeetingTask(r.id, i, { status: "unconfirmed", pendingId: undefined, needsConfirm: true });
        r.tasks[i] = { ...t, status: "unconfirmed", pendingId: undefined, needsConfirm: true };
      }
    }
  }
  return records;
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
