"use client";

import { useActionState, useState } from "react";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import {
  createDepartment,
  createEmployee,
  deleteDepartment,
  resetEmployeePassword,
  updateEmployee,
  type CreateEmployeeState,
  type ResetPasswordState,
} from "@/lib/admin-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Dept = { id: string; name: string };

// Styled native select — reliable inside server-action forms.
const SELECT_CLS =
  "h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

function TempPasswordNotice({
  email,
  password,
}: {
  email?: string;
  password: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
      <p className="font-medium text-amber-800 dark:text-amber-200">
        臨時密碼(只顯示一次,請交給員工):
      </p>
      <div className="mt-1 flex items-center gap-2">
        {email && <span className="text-muted-foreground">{email} →</span>}
        <code className="rounded bg-background px-2 py-0.5 font-mono">
          {password}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            navigator.clipboard?.writeText(password);
            setCopied(true);
          }}
        >
          <Copy className="size-3.5" /> {copied ? "已複製" : "複製"}
        </Button>
      </div>
    </div>
  );
}

export function CreateEmployeeForm({ departments }: { departments: Dept[] }) {
  const [state, action, pending] = useActionState<CreateEmployeeState, FormData>(
    createEmployee,
    undefined,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">新增員工帳號</CardTitle>
        <CardDescription>
          公司發放帳號;建立後會產生一組臨時密碼,員工首次登入須變更。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form action={action} className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-email">Email</Label>
            <Input
              id="new-email"
              name="email"
              type="email"
              required
              placeholder="new@company.com"
              className="w-56"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-name">姓名</Label>
            <Input id="new-name" name="name" required className="w-36" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-role">角色</Label>
            <select id="new-role" name="role" className={SELECT_CLS} defaultValue="employee">
              <option value="employee">員工</option>
              <option value="manager">主管</option>
              <option value="admin">管理員</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-dept">部門</Label>
            <select id="new-dept" name="departmentId" className={SELECT_CLS} defaultValue="">
              <option value="">(未指定)</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={pending}>
            <Plus className="size-4" /> {pending ? "建立中…" : "建立帳號"}
          </Button>
        </form>
        {state && "error" in state && (
          <p className="text-destructive text-sm">{state.error}</p>
        )}
        {state && "ok" in state && (
          <TempPasswordNotice email={state.email} password={state.tempPassword} />
        )}
      </CardContent>
    </Card>
  );
}

export function EmployeeRowEditor({
  employeeId,
  role,
  departmentId,
  departments,
}: {
  employeeId: string;
  role: string;
  departmentId: string | null;
  departments: Dept[];
}) {
  const [dirty, setDirty] = useState(false);
  return (
    <form
      action={async (fd) => {
        await updateEmployee(fd);
        setDirty(false);
      }}
      className="flex items-center gap-2"
    >
      <input type="hidden" name="employeeId" value={employeeId} />
      <select
        name="role"
        defaultValue={role}
        className={SELECT_CLS}
        onChange={() => setDirty(true)}
      >
        <option value="employee">員工</option>
        <option value="manager">主管</option>
        <option value="admin">管理員</option>
      </select>
      <select
        name="departmentId"
        defaultValue={departmentId ?? ""}
        className={SELECT_CLS}
        onChange={() => setDirty(true)}
      >
        <option value="">(未指定)</option>
        {departments.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
      {dirty && (
        <Button type="submit" size="sm" variant="outline">
          儲存
        </Button>
      )}
    </form>
  );
}

export function ResetPasswordButton({
  employeeId,
  name,
}: {
  employeeId: string;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ResetPasswordState, FormData>(
    resetEmployeePassword,
    undefined,
  );

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <KeyRound className="size-3.5" /> 重設密碼
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重設 {name} 的密碼</DialogTitle>
            <DialogDescription>
              會產生新的臨時密碼並強制對方下次登入時變更。
            </DialogDescription>
          </DialogHeader>
          {state && "ok" in state ? (
            <TempPasswordNotice password={state.tempPassword} />
          ) : (
            <form action={action} className="space-y-3">
              <input type="hidden" name="employeeId" value={employeeId} />
              {state && "error" in state && (
                <p className="text-destructive text-sm">{state.error}</p>
              )}
              <Button type="submit" disabled={pending} variant="destructive">
                {pending ? "重設中…" : "確認重設"}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function DepartmentPanel({
  departments,
}: {
  departments: { id: string; name: string; memberCount: number }[];
}) {
  const [state, action, pending] = useActionState(createDepartment, undefined);

  return (
    <div className="space-y-4">
      <form action={action} className="flex items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="dept-name">新部門名稱</Label>
          <Input id="dept-name" name="name" required className="w-56" />
        </div>
        <Button type="submit" disabled={pending}>
          <Plus className="size-4" /> 建立部門
        </Button>
      </form>
      {state?.error && <p className="text-destructive text-sm">{state.error}</p>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {departments.length === 0 && (
          <p className="text-muted-foreground text-sm">
            尚無部門。建立第一個部門後即可指派員工。
          </p>
        )}
        {departments.map((d) => (
          <Card key={d.id}>
            <CardContent className="flex items-center justify-between py-4">
              <div>
                <p className="font-medium">{d.name}</p>
                <Badge variant="secondary" className="mt-1">
                  {d.memberCount} 位成員
                </Badge>
              </div>
              <form action={deleteDepartment}>
                <input type="hidden" name="departmentId" value={d.id} />
                <Button
                  type="submit"
                  variant="ghost"
                  size="sm"
                  disabled={d.memberCount > 0}
                  title={d.memberCount > 0 ? "還有成員,不能刪除" : "刪除部門"}
                >
                  <Trash2 className="size-4" />
                </Button>
              </form>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
