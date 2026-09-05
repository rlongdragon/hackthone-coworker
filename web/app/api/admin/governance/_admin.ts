import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { employees } from "@/db/schema";

// Admin gate for JSON routes. requireAdmin() redirects (fine for pages, wrong
// for an API); here a non-admin gets a plain 401/403. Role is read fresh from
// the DB, never trusted from the JWT — same posture as lib/authz.
export async function requireAdminApi(): Promise<{ id: string } | Response> {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const [row] = await db
    .select({ role: employees.role, active: employees.active })
    .from(employees)
    .where(eq(employees.id, session.user.id))
    .limit(1);
  if (!row || !row.active) return new Response("Unauthorized", { status: 401 });
  if (row.role !== "admin") return new Response("Forbidden", { status: 403 });
  return { id: session.user.id };
}
