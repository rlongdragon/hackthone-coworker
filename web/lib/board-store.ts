import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { cards, employees, projectColumns, todos } from "@/db/schema";

const DEFAULT_COLUMNS = ["待辦", "進行中", "完成"];

// Ensure the project has a board; on first touch, create the default columns
// and pull any legacy project todos over as cards (待辦/完成 by done flag).
export async function ensureBoard(projectId: string): Promise<void> {
  const existing = await db
    .select({ id: projectColumns.id })
    .from(projectColumns)
    .where(eq(projectColumns.projectId, projectId))
    .limit(1);
  if (existing.length > 0) return;

  await db.transaction(async (tx) => {
    // Serialize first-touch per project (page load + agent tool can race) —
    // without this both would create default columns and migrate todos twice.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${projectId}::text))`,
    );
    const check = await tx
      .select({ id: projectColumns.id })
      .from(projectColumns)
      .where(eq(projectColumns.projectId, projectId))
      .limit(1);
    if (check.length > 0) return;

    const created = await tx
      .insert(projectColumns)
      .values(
        DEFAULT_COLUMNS.map((name, i) => ({ projectId, name, position: i })),
      )
      .returning({ id: projectColumns.id, name: projectColumns.name });
    const byName = Object.fromEntries(created.map((c) => [c.name, c.id]));

    // migrate legacy project todos into cards, then detach them
    const legacy = await tx
      .select()
      .from(todos)
      .where(eq(todos.projectId, projectId));
    if (legacy.length > 0) {
      await tx.insert(cards).values(
        legacy.map((t, i) => ({
          projectId,
          columnId: t.done ? byName["完成"] : byName["待辦"],
          title: t.title,
          assigneeId: t.employeeId,
          position: i,
        })),
      );
      await tx.delete(todos).where(eq(todos.projectId, projectId));
    }
  });
}

export async function getBoard(projectId: string) {
  await ensureBoard(projectId);
  const columns = await db
    .select()
    .from(projectColumns)
    .where(eq(projectColumns.projectId, projectId))
    .orderBy(asc(projectColumns.position), asc(projectColumns.createdAt));
  const cardRows = await db
    .select({
      id: cards.id,
      columnId: cards.columnId,
      title: cards.title,
      description: cards.description,
      assigneeId: cards.assigneeId,
      assigneeName: employees.name,
      position: cards.position,
    })
    .from(cards)
    .leftJoin(employees, eq(cards.assigneeId, employees.id))
    .where(eq(cards.projectId, projectId))
    .orderBy(asc(cards.position), asc(cards.createdAt));
  return { columns, cards: cardRows };
}

// SQL expression for "end of this column" — evaluated inside the same
// statement as the insert/update, so concurrent writers can't read the same
// max (positions are float8; a tie would only wobble ordering, but avoid it).
export function endOfColumnPosition(columnId: string) {
  return sql<number>`(select coalesce(max(${cards.position}), 0) + 1 from ${cards} where ${cards.columnId} = ${columnId})`;
}
