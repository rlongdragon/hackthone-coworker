"use client";

import { useActionState } from "react";
import { Plus, UserPlus } from "lucide-react";
import {
  addMember,
  addProjectTodo,
  createProject,
  type FormState,
} from "@/lib/project-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function CreateProjectForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(
    createProject,
    undefined,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">建立專案</CardTitle>
        <CardDescription>建立後你會成為專案負責人,可再邀請成員。</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="p-name">名稱</Label>
            <Input id="p-name" name="name" required className="w-56" />
          </div>
          <div className="min-w-64 flex-1 space-y-1.5">
            <Label htmlFor="p-desc">說明(選填)</Label>
            <Input id="p-desc" name="description" className="w-full" />
          </div>
          <Button type="submit" disabled={pending}>
            <Plus className="size-4" /> {pending ? "建立中…" : "建立"}
          </Button>
        </form>
        {state?.error && (
          <p className="text-destructive mt-2 text-sm">{state.error}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function AddMemberForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    addMember,
    undefined,
  );
  return (
    <form action={action} className="flex items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Label htmlFor="m-email" className="text-xs">
          用 email 加成員
        </Label>
        <Input
          id="m-email"
          name="email"
          type="email"
          required
          placeholder="colleague@company.com"
          className="h-8 w-full"
        />
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        <UserPlus className="size-3.5" /> 加入
      </Button>
      {state?.error && (
        <p className="text-destructive self-center text-xs">{state.error}</p>
      )}
    </form>
  );
}

export function AddTodoForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    addProjectTodo,
    undefined,
  );
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="min-w-56 flex-1 space-y-1.5">
        <Label htmlFor="t-title" className="text-xs">
          新增待辦
        </Label>
        <Input
          id="t-title"
          name="title"
          required
          placeholder="要做什麼?"
          className="h-8"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="t-due" className="text-xs">
          截止(選填)
        </Label>
        <Input id="t-due" name="due" type="date" className="h-8 w-36" />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        <Plus className="size-3.5" /> 新增
      </Button>
      {state?.error && (
        <p className="text-destructive self-center text-xs">{state.error}</p>
      )}
    </form>
  );
}
