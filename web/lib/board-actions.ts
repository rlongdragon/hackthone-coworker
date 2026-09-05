"use server";

import { revalidatePath } from "next/cache";
import { count, eq, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { cards, employees, projectColumns, projects } from "@/db/schema";
import { getMembership } from "@/lib/project-store";
import { endOfColumnPosition } from "@/lib/board-store";
import { asUuid } from "@/lib/validate";

export type BoardState = { error: string } | undefined;

// Every mutation: caller must be a member of an *active* project.
async function boardGate(projectId: string | null): Promise<string | null> {
  if (!projectId) return null;
  const session = await auth();
  if (!session?.user?.id) return null;
  if (!(await getMembership(projectId, session.user.id))) return null;
  const [p] = await db
    .select({ status: projects.status })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (p?.status !== "active") return null;
  return session.user.id;
}

async function columnProject(columnId: string): Promise<string | null> {
  const [c] = await db
    .select({ projectId: projectColumns.projectId })
    .from(projectColumns)
    .where(eq(projectColumns.id, columnId))
    .limit(1);
  return c?.projectId ?? null;
}

export async function createColumn(
  _prev: BoardState,
  formData: FormData,
): Promise<BoardState> {
  const projectId = asUuid(formData.get("projectId"));
  const name = String(formData.get("name") ?? "").trim().slice(0, 40);
  if (!projectId || !name) return { error: "請填欄位名稱。" };
  const userId = await boardGate(projectId);
  if (!userId) return { error: "沒有權限。" };
  const [{ n }] = await db
    .select({ n: count() })
    .from(projectColumns)
    .where(eq(projectColumns.projectId, projectId));
  if (n >= 10) return { error: "欄位太多了(上限 10)。" };
  await db.insert(projectColumns).values({ projectId, name, position: n });
  revalidatePath(`/projects/${projectId}`);
}

export async function renameColumn(formData: FormData): Promise<void> {
  const columnId = asUuid(formData.get("columnId"));
  const name = String(formData.get("name") ?? "").trim().slice(0, 40);
  if (!columnId || !name) return;
  const projectId = await columnProject(columnId);
  const userId = await boardGate(projectId);
  if (!userId || !projectId) return;
  await db
    .update(projectColumns)
    .set({ name })
    .where(eq(projectColumns.id, columnId));
  revalidatePath(`/projects/${projectId}`);
}

export async function deleteColumn(formData: FormData): Promise<void> {
  const columnId = asUuid(formData.get("columnId"));
  if (!columnId) return;
  const projectId = await columnProject(columnId);
  const userId = await boardGate(projectId);
  if (!userId || !projectId) return;
  // Single statement — no TOCTOU window for a card inserted mid-delete.
  await db.execute(sql`
    delete from ${projectColumns}
    where ${projectColumns.id} = ${columnId}
      and not exists (select 1 from ${cards} where ${cards.columnId} = ${columnId})
  `);
  revalidatePath(`/projects/${projectId}`);
}

export async function createCard(
  _prev: BoardState,
  formData: FormData,
): Promise<BoardState> {
  const columnId = asUuid(formData.get("columnId"));
  const title = String(formData.get("title") ?? "").trim().slice(0, 200);
  if (!columnId || !title) return { error: "請填卡片標題。" };
  const projectId = await columnProject(columnId);
  const userId = await boardGate(projectId);
  if (!userId || !projectId) return { error: "沒有權限。" };
  await db.insert(cards).values({
    projectId,
    columnId,
    title,
    position: endOfColumnPosition(columnId),
  });
  revalidatePath(`/projects/${projectId}`);
}

export async function moveCard(
  cardId: string,
  toColumnId: string,
  position: number,
): Promise<{ ok: boolean }> {
  const cid = asUuid(cardId);
  const colId = asUuid(toColumnId);
  // Clamp: garbage positions must not corrupt ordering or overflow.
  if (!cid || !colId || !Number.isFinite(position) || position < 0 || position > 1e9) {
    return { ok: false };
  }
  const [card] = await db
    .select({ projectId: cards.projectId })
    .from(cards)
    .where(eq(cards.id, cid))
    .limit(1);
  if (!card) return { ok: false };
  const userId = await boardGate(card.projectId);
  if (!userId) return { ok: false };
  // target column must belong to the same project
  const colProject = await columnProject(colId);
  if (colProject !== card.projectId) return { ok: false };
  await db
    .update(cards)
    .set({ columnId: colId, position, updatedAt: new Date() })
    .where(eq(cards.id, cid));
  revalidatePath(`/projects/${card.projectId}`);
  return { ok: true };
}

export async function assignCard(formData: FormData): Promise<void> {
  const cardId = asUuid(formData.get("cardId"));
  const assigneeId = asUuid(formData.get("assigneeId")); // null clears
  if (!cardId) return;
  const [card] = await db
    .select({ projectId: cards.projectId })
    .from(cards)
    .where(eq(cards.id, cardId))
    .limit(1);
  if (!card) return;
  const userId = await boardGate(card.projectId);
  if (!userId) return;
  if (assigneeId && !(await getMembership(card.projectId, assigneeId))) return;
  await db
    .update(cards)
    .set({ assigneeId, updatedAt: new Date() })
    .where(eq(cards.id, cardId));
  revalidatePath(`/projects/${card.projectId}`);
}

export async function deleteCard(formData: FormData): Promise<void> {
  const cardId = asUuid(formData.get("cardId"));
  if (!cardId) return;
  const [card] = await db
    .select({ projectId: cards.projectId })
    .from(cards)
    .where(eq(cards.id, cardId))
    .limit(1);
  if (!card) return;
  const userId = await boardGate(card.projectId);
  if (!userId) return;
  await db.delete(cards).where(eq(cards.id, cardId));
  revalidatePath(`/projects/${card.projectId}`);
}
