import { eq } from "drizzle-orm";
import { db } from "@/db";
import { departments, employees } from "@/db/schema";

// Principal identity + scope helpers, extracted so both delegation.ts and pep.ts
// can depend on it without a cycle (pep needs principalOf; delegation needs pep).

export const ROLE_RANK = { employee: 0, manager: 1, admin: 2 } as const;

export type Principal = {
  id: string;
  name: string;
  role: string;
  departmentId: string | null;
  deptName: string | null;
  active: boolean;
};

export async function principalOf(id: string): Promise<Principal | null> {
  const [r] = await db
    .select({
      id: employees.id,
      name: employees.name,
      role: employees.role,
      departmentId: employees.departmentId,
      deptName: departments.name,
      active: employees.active,
    })
    .from(employees)
    .leftJoin(departments, eq(employees.departmentId, departments.id))
    .where(eq(employees.id, id))
    .limit(1);
  return r ?? null;
}

// The scope grants a principal holds, as opaque strings — used for the audit
// trail and the permission-graph auditor. Mirrors tool-store visibility rules.
export function scopeGrants(p: Principal): string[] {
  const g = [`role:${p.role}`, `personal:${p.id}`, "org"];
  if (p.departmentId) g.push(`dept:${p.departmentId}`);
  return g;
}

// The effective role of a delegation chain = the LOWEST role in it. A low-priv
// caller can never borrow a high-priv callee's role.
export function effectiveRole(principals: Principal[]): string {
  let rank: number = ROLE_RANK.admin;
  for (const p of principals) rank = Math.min(rank, ROLE_RANK[p.role as keyof typeof ROLE_RANK] ?? 0);
  return (Object.keys(ROLE_RANK) as (keyof typeof ROLE_RANK)[]).find((k) => ROLE_RANK[k] === rank) ?? "employee";
}
