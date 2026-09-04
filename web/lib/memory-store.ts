import { and, cosineDistance, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { employees, memories } from "@/db/schema";
import { embedPassage, embedQuery } from "@/lib/embeddings";

export type MemoryKind = "history" | "preference" | "context";
export type Provenance = "trusted" | "untrusted_derived";

export async function saveMemory(
  employeeId: string,
  content: string,
  kind: MemoryKind = "context",
  // agent-society P2: information-flow provenance. A fact distilled from
  // untrusted content (a tool output, an inbound document, another agent's
  // answer) must be marked untrusted_derived so the red-team taint detector can
  // flag an auto action later driven by it.
  opts?: { provenance?: Provenance; sourceAgentId?: string | null },
): Promise<{ id: string }> {
  const embedding = await embedPassage(content);
  const [m] = await db
    .insert(memories)
    .values({
      employeeId,
      kind,
      content,
      embedding,
      provenance: opts?.provenance ?? "trusted",
      sourceAgentId: opts?.sourceAgentId ?? null,
    })
    .returning({ id: memories.id });
  return m;
}

// Blue-team actuator: isolate a poisoned row so it can never be retrieved again
// (reversible — the row is kept for forensics, not deleted).
export async function quarantineMemory(id: string): Promise<boolean> {
  const rows = await db
    .update(memories)
    .set({ quarantined: true })
    .where(eq(memories.id, id))
    .returning({ id: memories.id });
  return rows.length > 0;
}

export async function unquarantineMemory(id: string): Promise<boolean> {
  const rows = await db
    .update(memories)
    .set({ quarantined: false })
    .where(eq(memories.id, id))
    .returning({ id: memories.id });
  return rows.length > 0;
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
    provenance: string; // trusted | untrusted_derived
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
      provenance: memories.provenance,
    })
    .from(memories)
    .leftJoin(employees, eq(memories.sourceEmployeeId, employees.id))
    // Quarantined (poisoned) rows are never retrievable — the blue-team's
    // isolation is enforced at read time, not just flagged.
    .where(and(eq(memories.employeeId, employeeId), eq(memories.quarantined, false)))
    .orderBy(distance)
    .limit(limit);
  return rows
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      content: r.content,
      similarity: 1 - Number(r.distance),
      sourceName: r.sourceName,
      provenance: r.provenance,
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
