import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq, sql } from "drizzle-orm";
import { ArrowLeft, Users } from "lucide-react";
import { requireEmployee } from "@/lib/authz";
import { db } from "@/db";
import {
  conversations,
  departments,
  employees,
  projectMembers,
  todos,
} from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ROLE_LABEL: Record<string, string> = {
  admin: "管理員",
  manager: "主管",
  employee: "員工",
};

export default async function ManagerPage() {
  const user = await requireEmployee();
  if (user.role !== "manager" && user.role !== "admin") redirect("/");

  // Managers see their own department; admins see everyone.
  const [me] = await db
    .select({ departmentId: employees.departmentId })
    .from(employees)
    .where(eq(employees.id, user.id))
    .limit(1);

  const base = db
    .select({
      id: employees.id,
      name: employees.name,
      email: employees.email,
      role: employees.role,
      departmentName: departments.name,
      openTodos: sql<number>`(select count(*) from ${todos} t where t.employee_id = ${employees.id} and t.done = false)::int`,
      doneTodos: sql<number>`(select count(*) from ${todos} t where t.employee_id = ${employees.id} and t.done = true)::int`,
      projectCount: sql<number>`(select count(*) from ${projectMembers} pm where pm.employee_id = ${employees.id})::int`,
      lastActive: sql<Date | null>`(select max(c.updated_at) from ${conversations} c where c.employee_id = ${employees.id})`,
    })
    .from(employees)
    .leftJoin(departments, eq(employees.departmentId, departments.id))
    .orderBy(desc(employees.createdAt));

  const rows =
    user.role === "admin"
      ? await base
      : me?.departmentId
        ? await base.where(eq(employees.departmentId, me.departmentId))
        : [];

  const totalOpen = rows.reduce((s, r) => s + r.openTodos, 0);

  return (
    <main className="w-full mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> 回聊天
        </Link>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Users className="size-5" /> 團隊總覽
        </h1>
        <p className="text-muted-foreground ml-auto text-sm">
          {rows.length} 位成員 · {totalOpen} 件未完成待辦
        </p>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-10 text-center text-sm">
            {user.role === "manager"
              ? "你還沒被指派部門,請聯絡管理員。"
              : "還沒有員工。"}
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>成員</TableHead>
                <TableHead>部門</TableHead>
                <TableHead className="text-right">待辦(未完成/完成)</TableHead>
                <TableHead className="text-right">參與專案</TableHead>
                <TableHead className="text-right">最近使用</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <span className="bg-muted grid size-8 shrink-0 place-items-center rounded-full text-xs font-medium">
                        {r.name.slice(0, 1)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {r.name}{" "}
                          {r.role !== "employee" && (
                            <Badge variant="secondary" className="ml-1">
                              {ROLE_LABEL[r.role]}
                            </Badge>
                          )}
                        </p>
                        <p className="text-muted-foreground truncate text-xs">
                          {r.email}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.departmentName ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={
                        r.openTodos > 5 ? "font-medium text-amber-600" : ""
                      }
                    >
                      {r.openTodos}
                    </span>
                    <span className="text-muted-foreground"> / {r.doneTodos}</span>
                  </TableCell>
                  <TableCell className="text-right">{r.projectCount}</TableCell>
                  <TableCell className="text-muted-foreground text-right text-xs">
                    {r.lastActive
                      ? new Date(r.lastActive).toLocaleDateString("zh-TW", {
                          timeZone: "Asia/Taipei",
                        })
                      : "從未"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-muted-foreground mt-4 text-xs">
        主管看得到工作量統計,但看不到成員的對話內容(FR-C 隱私邊界)。
      </p>
    </main>
  );
}
