import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMembership } from "@/lib/project-store";
import { getOrCreateProjectChannel, listMessages, postMessage } from "@/lib/channel-store";
import { asUuid } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

async function gate(ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.id) return { err: new Response("Unauthorized", { status: 401 }) };
  const projectId = asUuid((await ctx.params).id);
  if (!projectId) return { err: new Response("Not found", { status: 404 }) };
  if (!(await getMembership(projectId, session.user.id))) return { err: new Response("Not found", { status: 404 }) };
  return { userId: session.user.id, projectId };
}

export async function GET(req: Request, ctx: Ctx) {
  const g = await gate(ctx);
  if ("err" in g) return g.err;
  const ch = await getOrCreateProjectChannel(g.projectId, g.userId);
  const after = new URL(req.url).searchParams.get("after");
  const afterDate = after ? new Date(after) : undefined;
  const msgs = await listMessages(ch.id, afterDate && !isNaN(afterDate.getTime()) ? { after: afterDate } : { limit: 50 });
  return NextResponse.json({ channelId: ch.id, messages: msgs });
}

export async function POST(req: Request, ctx: Ctx) {
  const g = await gate(ctx);
  if ("err" in g) return g.err;
  const body = (await req.json().catch(() => null)) as { content?: string } | null;
  const content = String(body?.content ?? "").trim();
  if (!content) return NextResponse.json({ error: "訊息不能是空的" }, { status: 400 });
  const ch = await getOrCreateProjectChannel(g.projectId, g.userId);
  const r = await postMessage({ channelId: ch.id, projectId: g.projectId, authorId: g.userId, content });
  return NextResponse.json(r, { status: 201 });
}
