import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { dispatchTask } from "@/lib/dispatch";
import { asUuid } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

// Standalone manager dispatch: POST {title, assigneeId}. Same rule as
// meeting-item confirm (membership + cross-dept consent) via lib/dispatch.
export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const projectId = asUuid((await ctx.params).id);
  if (!projectId) return new Response("Not found", { status: 404 });
  const body = (await req.json().catch(() => null)) as { title?: string; assigneeId?: string } | null;
  const assigneeId = asUuid(body?.assigneeId);
  if (!assigneeId) return NextResponse.json({ error: "請選擇負責人" }, { status: 400 });
  const r = await dispatchTask({ actorId: session.user.id, projectId, assigneeId, title: String(body?.title ?? "") });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error.includes("成員") ? 404 : 400 });
  return NextResponse.json(r, { status: 201 });
}
