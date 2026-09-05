import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/authz";
import { db } from "@/db";
import { auditLog, departments, employees } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CreateEmployeeForm,
  DepartmentPanel,
  EmployeeRowEditor,
  ResetPasswordButton,
} from "./admin-client";

const ROLE_LABEL: Record<string, string> = {
  admin: "管理員",
  manager: "主管",
  employee: "員工",
};

export default async function AdminPage() {
  await requireAdmin();

  const [emps, depts, audits] = await Promise.all([
    db
      .select({
        id: employees.id,
        email: employees.email,
        name: employees.name,
        role: employees.role,
        departmentId: employees.departmentId,
        mustChangePassword: employees.mustChangePassword,
        createdAt: employees.createdAt,
        departmentName: departments.name,
      })
      .from(employees)
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .orderBy(desc(employees.createdAt)),
    db
      .select({
        id: departments.id,
        name: departments.name,
        // Literal qualification on purpose: drizzle renders interpolated
        // columns unqualified in join-less queries, and the subquery's inner
        // scope then captures "id" (employees.id) — counting zero forever.
        memberCount: sql<number>`(select count(*) from employees where employees.department_id = departments.id)::int`,
      })
      .from(departments)
      .orderBy(departments.name),
    db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        detail: auditLog.detail,
        createdAt: auditLog.createdAt,
        actorName: employees.name,
      })
      .from(auditLog)
      .leftJoin(employees, eq(auditLog.employeeId, employees.id))
      .orderBy(desc(auditLog.createdAt))
      .limit(50),
  ]);

  const deptOptions = depts.map((d) => ({ id: d.id, name: d.name }));

  return (
    <main className="w-full mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> 回聊天
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">管理後台</h1>
        <Link
          href="/admin/handover"
          className="text-muted-foreground hover:text-foreground ml-auto text-sm underline"
        >
          交接傳承 →
        </Link>
        <Link
          href="/admin/mcp"
          className="text-muted-foreground hover:text-foreground text-sm underline"
        >
          MCP 外部工具 →
        </Link>
      </div>

      <Tabs defaultValue="employees">
        <TabsList>
          <TabsTrigger value="employees">員工帳號</TabsTrigger>
          <TabsTrigger value="departments">部門</TabsTrigger>
          <TabsTrigger value="audit">審計日誌</TabsTrigger>
        </TabsList>

        <TabsContent value="employees" className="mt-4 space-y-6">
          <CreateEmployeeForm departments={deptOptions} />

          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>姓名</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>角色 / 部門</TableHead>
                  <TableHead>狀態</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {emps.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-medium">{e.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {e.email}
                    </TableCell>
                    <TableCell>
                      <EmployeeRowEditor
                        employeeId={e.id}
                        role={e.role}
                        departmentId={e.departmentId}
                        departments={deptOptions}
                      />
                    </TableCell>
                    <TableCell>
                      {e.mustChangePassword ? (
                        <Badge variant="outline" className="text-amber-600">
                          待改密碼
                        </Badge>
                      ) : (
                        <Badge variant="secondary">正常</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <ResetPasswordButton employeeId={e.id} name={e.name} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="departments" className="mt-4">
          <DepartmentPanel departments={depts} />
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>時間</TableHead>
                  <TableHead>操作者</TableHead>
                  <TableHead>動作</TableHead>
                  <TableHead>細節</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audits.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="text-muted-foreground text-center"
                    >
                      尚無紀錄
                    </TableCell>
                  </TableRow>
                )}
                {audits.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                      {a.createdAt.toLocaleString("zh-TW", {
                        timeZone: "Asia/Taipei",
                      })}
                    </TableCell>
                    <TableCell>{a.actorName ?? "—"}</TableCell>
                    <TableCell>
                      <code className="text-xs">{a.action}</code>
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-md truncate text-xs">
                      {a.detail ? JSON.stringify(a.detail) : ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>
      <p className="text-muted-foreground mt-6 text-xs">
        角色說明:{Object.entries(ROLE_LABEL).map(([k, v]) => `${v} (${k})`).join("、")}
        。新帳號會取得臨時密碼,首次登入須改密碼。
      </p>
    </main>
  );
}
