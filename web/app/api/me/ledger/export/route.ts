import { eq, inArray } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { employees } from "@/db/schema";
import { listQueriesAboutMe } from "@/lib/pep";
import { getMyNotifications } from "@/lib/notifications";

// GDPR-style dump of the SUBJECT's own A2A query ledger. Scoped strictly to the
// signed-in employee: the subject id comes from the session, never from the
// request, so one user can never pull another's rows.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });

  const [me] = await db
    .select({ id: employees.id, name: employees.name, email: employees.email, active: employees.active })
    .from(employees)
    .where(eq(employees.id, session.user.id))
    .limit(1);
  if (!me || !me.active) return new Response("Unauthorized", { status: 401 });

  const [rows, notifs] = await Promise.all([
    listQueriesAboutMe(me.id, { includeDenied: true, limit: 100_000 }),
    getMyNotifications(me.id, { limit: 100_000 }),
  ]);

  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
  const actors = actorIds.length
    ? await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, actorIds))
    : [];
  const nameOf = new Map(actors.map((a) => [a.id, a.name]));

  const exportedAt = new Date();
  const payload = {
    note:
      "這是你本人的跨代理(A2A)查詢紀錄:誰的代理曾查詢關於你的資訊、範圍、目的、以及是否被允許或拒絕(含被拒絕的查詢)。僅包含以你為主體的資料,不含其他人的紀錄。",
    subject: { id: me.id, name: me.name, email: me.email },
    exportedAt: exportedAt.toISOString(),
    queriesAboutMe: rows.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      actorName: r.actorId ? (nameOf.get(r.actorId) ?? null) : null,
      scope: r.scope,
      allowed: r.allowed === true,
      deniedFields: r.deniedFields ?? [],
      purpose: r.purpose,
      createdAt: new Date(r.createdAt).toISOString(),
    })),
    notifications: notifs.map((n) => ({
      id: n.id,
      type: n.type,
      actorId: n.actorId,
      scope: n.scope,
      purpose: n.purpose,
      auditId: n.auditId,
      readAt: n.readAt ? new Date(n.readAt).toISOString() : null,
      createdAt: new Date(n.createdAt).toISOString(),
    })),
  };

  const date = exportedAt.toISOString().slice(0, 10);
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="ledger-${date}.json"`,
      "cache-control": "no-store",
    },
  });
}
