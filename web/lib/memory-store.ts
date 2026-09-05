import { and, cosineDistance, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { employees, memories } from "@/db/schema";
import { embedPassage, embedQuery } from "@/lib/embeddings";

export type MemoryKind = "history" | "preference" | "context";

export async function saveMemory(
  employeeId: string,
  content: string,
  kind: MemoryKind = "context",
): Promise<{ id: string }> {
  const embedding = await embedPassage(content);
  const [m] = await db
    .insert(memories)
    .values({ employeeId, kind, content, embedding })
    .returning({ id: memories.id });
  return m;
}

// Semantic recall via pgvector cosine distance. ORDER BY distance ASC + LIMIT
// is the only shape the HNSW index accelerates — the similarity threshold is
// applied in app code afterwards.
export async function searchMemories(
  employeeId: string,
  query: string,
  limit = 5,
  minSimilarity = 0.8,
): Promise<
  {
    id: string;
    kind: string;
    content: string;
    similarity: number;
    sourceName: string | null; // set when the row arrived via a handover
  }[]
> {
  const qvec = await embedQuery(query);
  const distance = cosineDistance(memories.embedding, qvec);
  const rows = await db
    .select({
      id: memories.id,
      kind: memories.kind,
      content: memories.content,
      distance: sql<number>`${distance}`,
      sourceName: employees.name,
    })
    .from(memories)
    .leftJoin(employees, eq(memories.sourceEmployeeId, employees.id))
    .where(eq(memories.employeeId, employeeId))
    .orderBy(distance)
    .limit(limit);
  return rows
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      content: r.content,
      similarity: 1 - Number(r.distance),
      sourceName: r.sourceName,
    }))
    .filter((r) => r.similarity > minSimilarity);
}

export async function listMemories(employeeId: string, limit = 100) {
  return db
    .select({
      id: memories.id,
      kind: memories.kind,
      content: memories.content,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(eq(memories.employeeId, employeeId))
    .orderBy(desc(memories.createdAt))
    .limit(limit);
}

export async function deleteMemory(employeeId: string, memoryId: string) {
  const rows = await db
    .delete(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.employeeId, employeeId)))
    .returning({ id: memories.id });
  return rows.length > 0;
}
