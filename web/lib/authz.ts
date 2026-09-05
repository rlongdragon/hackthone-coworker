import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { employees } from "@/db/schema";

export type SessionUser = {
  id: string;
  role: string;
  name: string;
  email: string;
};

// Require a signed-in employee. Role and the password-change gate are read
// fresh from the DB on every call — never trusted from the JWT, so demotions
// and forced password changes apply immediately.
export async function requireEmployee(opts?: {
  skipPasswordGate?: boolean;
}): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const [row] = await db
    .select({
      role: employees.role,
      name: employees.name,
      email: employees.email,
      mustChangePassword: employees.mustChangePassword,
      active: employees.active,
    })
    .from(employees)
    .where(eq(employees.id, session.user.id))
    .limit(1);
  if (!row) redirect("/login"); // account removed while session cookie lives
  if (!row.active) redirect("/login"); // deactivated while cookie lives

  if (row.mustChangePassword && !opts?.skipPasswordGate) {
    redirect("/me/password");
  }

  return {
    id: session.user.id,
    role: row.role,
    name: row.name,
    email: row.email,
  };
}

// Require admin role (DB-fresh); non-admins are sent home.
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireEmployee();
  if (user.role !== "admin") redirect("/");
  return user;
}
