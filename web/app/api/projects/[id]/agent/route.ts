import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMembership } from "@/lib/project-store";
import { getTeamAgent } from "@/lib/team-agent";
import { asUuid } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

// The project's team-agent identity + permissions. Members only.
export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const projectId = asUuid((await ctx.params).id);
  if (!projectId) return new Response("Not found", { status: 404 });
  if (!(await getMembership(projectId, session.user.id))) return new Response("Not found", { status: 404 });
  const agent = await getTeamAgent(projectId);
  if (!agent) return new Response("Not found", { status: 404 });
  return NextResponse.json(agent);
}
