import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { employees, pendingActions } from "@/db/schema";
import { resolvePendingAction } from "@/lib/approval-store";
import { asUuid } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

// Card state on (re)load: the client's local state dies with the page, the DB
// row is the truth about whether this action was already resolved.
export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const id = asUuid((await ctx.params).id);
  if (!id) return new Response("Not found", { status: 404 });
  const [row] = await db
    .select({
      status: pendingActions.status,
      result: pendingActions.result,
      expiresAt: pendingActions.expiresAt,
    })
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.id, id),
        eq(pendingActions.requesterId, session.user.id),
      ),
    )
    .limit(1);
  if (!row) return new Response("Not found", { status: 404 });
  const status =
    row.status === "pending" && row.expiresAt < new Date()
      ? "expired"
      : row.status;
  return NextResponse.json({ status, result: row.result });
}

export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const id = asUuid((await ctx.params).id);
  if (!id) return new Response("Not found", { status: 404 });

  const body = await req.json().catch(() => null);
  const decision = body?.decision;
  if (decision !== "approve" && decision !== "reject") {
    return new Response("Bad decision", { status: 400 });
  }

  // Role read fresh from DB at execution time.
  const [me] = await db
    .select({ role: employees.role })
    .from(employees)
    .where(eq(employees.id, session.user.id))
    .limit(1);
  if (!me) return new Response("Unauthorized", { status: 401 });

  const result = await resolvePendingAction(id, session.user.id, me.role, decision);
  return NextResponse.json(result);
}
