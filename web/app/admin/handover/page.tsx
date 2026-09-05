import Link from "next/link";
import { eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { requireEmployee } from "@/lib/authz";
import { db } from "@/db";
import { employees, projects } from "@/db/schema";
import { listHandovers } from "@/lib/handover-store";
import { questionStats } from "@/lib/handover-gaps";
import { HandoverClient } from "./handover-client";

export default async function HandoverPage() {
  const user = await requireEmployee();
  if (user.role !== "admin" && user.role !== "manager") redirect("/");

  const [people, projectRows, rows] = await Promise.all([
    db
      .select({
        id: employees.id,
        name: employees.name,
        email: employees.email,
        active: employees.active,
      })
      .from(employees)
      .orderBy(employees.name),
    db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.status, "active")),
    listHandovers(),
  ]);
  const qStats = await questionStats(rows.map((h) => h.id));

  return (
    <main className="w-full mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/admin"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> 回管理面板
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">交接傳承</h1>
      </div>
      <HandoverClient
        me={{ id: user.id, role: user.role }}
        people={people}
        projects={projectRows}
        handovers={rows.map((h) => ({
          id: h.id,
          fromName: h.fromName,
          toName: h.toName,
          createdByName: h.createdByName,
          createdBy: h.createdBy,
          fromEmployeeId: h.fromEmployeeId,
          toEmployeeId: h.toEmployeeId,
          scope: h.scope,
          status: h.status,
          error: h.error,
          createdAt: h.createdAt.toISOString(),
          custodial: h.custodial,
          parentHandoverId: h.parentHandoverId,
          gapScore: h.gapScore,
          gapTopics: (
            (h.gapReport as { gaps?: { topic: string }[] } | null)?.gaps ?? []
          ).map((g) => g.topic),
          openQuestions: qStats.get(h.id)?.open ?? 0,
          answeredQuestions: qStats.get(h.id)?.answered ?? 0,
        }))}
      />
    </main>
  );
}
