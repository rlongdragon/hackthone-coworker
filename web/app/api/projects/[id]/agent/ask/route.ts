import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMembership } from "@/lib/project-store";
import { teamAgentAsk } from "@/lib/team-agent";
import { asUuid } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

// Ask the team agent. Membership is the permission boundary; the agent only
// ever sees team-scoped data (board / files / meeting decisions).
export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const projectId = asUuid((await ctx.params).id);
  if (!projectId) return new Response("Not found", { status: 404 });
  if (!(await getMembership(projectId, session.user.id))) return new Response("Not found", { status: 404 });
  const body = (await req.json().catch(() => null)) as { question?: string } | null;
  const question = String(body?.question ?? "").trim();
  if (!question) return NextResponse.json({ error: "請輸入問題" }, { status: 400 });
  const r = await teamAgentAsk(projectId, session.user.id, question);
  return NextResponse.json(r);
}
