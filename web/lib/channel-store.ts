import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/db";
import { channelMessages, channels, employees } from "@/db/schema";
import { teamAgentAsk } from "@/lib/team-agent";

// ============================================================================
// Project channels (P4). One `general` channel per project, created lazily.
// Access is CURRENT project membership (checked by the routes on every
// request). `@agent` / `@團隊代理` in a message pulls the project's team agent
// in: it answers under ITS OWN team scope — the mention never elevates the
// author, and the agent never sees any member's private memory or tools.
// ============================================================================

export type ChannelMessage = {
  id: string;
  authorId: string | null;
  authorName: string;
  authorType: "user" | "agent";
  content: string;
  replyToId: string | null;
  createdAt: string;
};

export async function getOrCreateProjectChannel(projectId: string, createdBy?: string | null) {
  const [ex] = await db.select().from(channels).where(and(eq(channels.projectId, projectId), eq(channels.name, "general"))).limit(1);
  if (ex) return ex;
  const [row] = await db
    .insert(channels)
    .values({ projectId, name: "general", createdBy: createdBy ?? null })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [again] = await db.select().from(channels).where(and(eq(channels.projectId, projectId), eq(channels.name, "general"))).limit(1);
  return again;
}

async function withNames(rows: (typeof channelMessages.$inferSelect)[]): Promise<ChannelMessage[]> {
  const ids = [...new Set(rows.map((r) => r.authorId).filter(Boolean))] as string[];
  const people = ids.length ? await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, ids)) : [];
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  return rows.map((r) => ({
    id: r.id,
    authorId: r.authorId,
    authorName: r.authorType === "agent" ? "團隊代理" : (r.authorId ? nameOf.get(r.authorId) ?? "?" : "?"),
    authorType: r.authorType === "agent" ? "agent" : "user",
    content: r.content,
    replyToId: r.replyToId,
    createdAt: r.createdAt.toISOString(),
  }));
}

// Latest `limit` messages (oldest→newest), or everything strictly after `after`.
export async function listMessages(channelId: string, opts?: { after?: Date; limit?: number }): Promise<ChannelMessage[]> {
  if (opts?.after) {
    const rows = await db
      .select()
      .from(channelMessages)
      .where(and(eq(channelMessages.channelId, channelId), gt(channelMessages.createdAt, opts.after)))
      .orderBy(asc(channelMessages.createdAt))
      .limit(200);
    return withNames(rows);
  }
  const rows = await db
    .select()
    .from(channelMessages)
    .where(eq(channelMessages.channelId, channelId))
    .orderBy(desc(channelMessages.createdAt))
    .limit(opts?.limit ?? 50);
  return withNames(rows.reverse());
}

const AGENT_MENTION = /@(agent|團隊代理|代理)/i;

export async function postMessage(input: {
  channelId: string;
  projectId: string;
  authorId: string;
  content: string;
}): Promise<{ message: ChannelMessage; agentReply: ChannelMessage | null }> {
  const content = input.content.trim().slice(0, 4000);
  const mentionsAgent = AGENT_MENTION.test(content);
  const [row] = await db
    .insert(channelMessages)
    .values({
      channelId: input.channelId,
      authorId: input.authorId,
      authorType: "user",
      content,
      mentions: mentionsAgent ? [{ type: "agent", id: input.projectId }] : [],
    })
    .returning();
  const [message] = await withNames([row]);

  let agentReply: ChannelMessage | null = null;
  if (mentionsAgent) {
    // The team agent answers as ITSELF (team scope), triggered by — not acting
    // as — the author. Its reply is a separate message in the channel.
    const question = content.replace(AGENT_MENTION, "").trim() || "請摘要目前專案狀態";
    const r = await teamAgentAsk(input.projectId, input.authorId, question);
    const [reply] = await db
      .insert(channelMessages)
      .values({
        channelId: input.channelId,
        authorId: null,
        authorType: "agent",
        content: r.answer + (r.provenance.length ? `\n\n依據:${r.provenance.map((p) => p.label).join("、")}` : ""),
        replyToId: row.id,
      })
      .returning();
    [agentReply] = await withNames([reply]);
  }
  return { message, agentReply };
}
