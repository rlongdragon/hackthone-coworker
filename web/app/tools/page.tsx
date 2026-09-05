import Link from "next/link";
import { asc, eq, inArray } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { requireEmployee } from "@/lib/authz";
import { listVisibleTools } from "@/lib/tool-store";
import { db } from "@/db";
import { departments, employees, toolSecrets } from "@/db/schema";
import { ToolsClient } from "./tools-client";

export default async function ToolsPage() {
  const user = await requireEmployee();
  const [me] = await db
    .select({ departmentId: employees.departmentId })
    .from(employees)
    .where(eq(employees.id, user.id))
    .limit(1);
  const myDept = me?.departmentId ?? null;

  const [visible, depts] = await Promise.all([
    listVisibleTools(user.id),
    db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .orderBy(asc(departments.name)),
  ]);

  // Secrets the user may manage (never the ciphertext): admin sees all, manager
  // sees their department's.
  let secrets: { id: string; name: string; scope: string; departmentId: string | null }[] = [];
  if (user.role === "admin") {
    secrets = await db
      .select({
        id: toolSecrets.id,
        name: toolSecrets.name,
        scope: toolSecrets.scope,
        departmentId: toolSecrets.departmentId,
      })
      .from(toolSecrets);
  } else if (user.role === "manager" && myDept) {
    secrets = await db
      .select({
        id: toolSecrets.id,
        name: toolSecrets.name,
        scope: toolSecrets.scope,
        departmentId: toolSecrets.departmentId,
      })
      .from(toolSecrets)
      .where(inArray(toolSecrets.departmentId, [myDept]));
  }

  const deptName = (id: string | null) =>
    id ? (depts.find((d) => d.id === id)?.name ?? "—") : "—";

  return (
    <main className="w-full mx-auto max-w-5xl p-6">
      <div className="mb-2 flex items-center gap-3">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> 回聊天
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">工具庫</h1>
      </div>
      <p className="text-muted-foreground mb-6 text-sm">
        共用腳本與整合工具。發佈到個人/部門/全公司,同範圍的 AI 同事都能呼叫。
      </p>

      <ToolsClient
        role={user.role}
        myDept={myDept}
        departments={depts}
        tools={visible.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          kind: t.kind,
          scope: t.scope,
          departmentName: deptName(t.departmentId),
          ownerId: t.ownerId,
          sensitive:
            t.kind === "action" &&
            Boolean((t.spec as { sensitive?: boolean } | null)?.sensitive),
        }))}
        currentUserId={user.id}
        secrets={secrets.map((s) => ({
          id: s.id,
          name: s.name,
          scope: s.scope,
          departmentName: deptName(s.departmentId),
        }))}
      />
    </main>
  );
}
