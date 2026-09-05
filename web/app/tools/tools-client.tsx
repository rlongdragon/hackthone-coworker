"use client";

import { useActionState, useEffect, useState } from "react";
import {
  Plus,
  Trash2,
  Wrench,
  Zap,
  ShieldAlert,
  KeyRound,
  User,
  Users,
  Building2,
} from "lucide-react";
import {
  createToolAction,
  deleteToolAction,
  deleteSecretAction,
  putSecretAction,
  type ToolFormState,
} from "@/lib/tool-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type Dept = { id: string; name: string };
type ToolItem = {
  id: string;
  name: string;
  description: string;
  kind: string;
  scope: string;
  departmentName: string;
  ownerId: string;
  sensitive: boolean;
};
type SecretItem = { id: string; name: string; scope: string; departmentName: string };

const SELECT_CLS =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const TEXTAREA_CLS =
  "w-full rounded-md border border-input bg-background p-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

const initial: ToolFormState = {};

const SCOPE_META: Record<
  string,
  { label: string; icon: typeof User }
> = {
  personal: { label: "個人", icon: User },
  department: { label: "部門", icon: Users },
  org: { label: "全公司", icon: Building2 },
};

function KindChip({ kind }: { kind: string }) {
  const skill = kind === "skill";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        skill
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
          : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
      }`}
    >
      {skill ? <Wrench className="size-3" /> : <Zap className="size-3" />}
      {skill ? "skill" : "action"}
    </span>
  );
}

export function ToolsClient({
  role,
  myDept,
  departments,
  tools,
  currentUserId,
  secrets,
}: {
  role: string;
  myDept: string | null;
  departments: Dept[];
  tools: ToolItem[];
  currentUserId: string;
  secrets: SecretItem[];
}) {
  const canManageSecrets = role === "admin" || role === "manager";
  const groups: { scope: string; items: ToolItem[] }[] = ["personal", "department", "org"]
    .map((scope) => ({ scope, items: tools.filter((t) => t.scope === scope) }))
    .filter((g) => g.items.length > 0);

  return (
    <Tabs defaultValue="tools">
      <TabsList>
        <TabsTrigger value="tools">工具({tools.length})</TabsTrigger>
        {canManageSecrets && (
          <TabsTrigger value="secrets">
            <KeyRound className="mr-1 size-3.5" /> 憑證庫({secrets.length})
          </TabsTrigger>
        )}
      </TabsList>

      <TabsContent value="tools" className="mt-4 space-y-6">
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-sm">
            AI 同事會依「說明」自動判斷何時呼叫這些工具。
          </p>
          <CreateToolDialog role={role} departments={departments} />
        </div>

        {groups.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-6">
            {groups.map((g) => {
              const Meta = SCOPE_META[g.scope];
              const Icon = Meta.icon;
              return (
                <section key={g.scope}>
                  <h2 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
                    <Icon className="size-3.5" /> {Meta.label}
                    <span className="text-muted-foreground/60">· {g.items.length}</span>
                  </h2>
                  <div className="divide-y rounded-xl border">
                    {g.items.map((t) => {
                      const canDelete =
                        t.scope === "personal"
                          ? t.ownerId === currentUserId
                          : t.scope === "org"
                            ? role === "admin"
                            : role === "manager" || role === "admin";
                      return (
                        <div
                          key={t.id}
                          className="flex items-center gap-3 p-3 hover:bg-muted/40"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <code className="text-sm font-semibold">{t.name}</code>
                              <KindChip kind={t.kind} />
                              {t.scope === "department" && (
                                <Badge variant="outline" className="text-xs font-normal">
                                  {t.departmentName}
                                </Badge>
                              )}
                              {t.sensitive && (
                                <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                                  <ShieldAlert className="size-3.5" /> 需確認
                                </span>
                              )}
                            </div>
                            <p className="text-muted-foreground mt-0.5 truncate text-sm">
                              {t.description}
                            </p>
                          </div>
                          {canDelete && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-muted-foreground hover:text-red-600"
                              aria-label={`刪除 ${t.name}`}
                              onClick={() => deleteToolAction(t.id)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </TabsContent>

      {canManageSecrets && (
        <TabsContent value="secrets" className="mt-4">
          <SecretsPanel role={role} departments={departments} secrets={secrets} />
        </TabsContent>
      )}
    </Tabs>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed p-10 text-center">
      <Wrench className="text-muted-foreground/50 mx-auto size-8" />
      <p className="text-muted-foreground mt-3 text-sm">
        還沒有工具。用右上角「新增工具」建立第一個共用腳本或整合。
      </p>
    </div>
  );
}

function CreateToolDialog({ role, departments }: { role: string; departments: Dept[] }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"skill" | "action">("skill");
  const [scope, setScope] = useState<"personal" | "department" | "org">("personal");
  const [state, action, pending] = useActionState(createToolAction, initial);

  useEffect(() => {
    if (state.ok) setOpen(false);
  }, [state.ok]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <Plus className="size-4" /> 新增工具
          </Button>
        }
      />
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新增工具</DialogTitle>
          <DialogDescription>
            skill = 在沙箱跑的腳本;action = 呼叫外部服務的整合(可挑一個憑證)。
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="name">名稱(snake_case)</Label>
              <Input id="name" name="name" placeholder="create_git_card" required />
            </div>
            <div>
              <Label htmlFor="kind">類型</Label>
              <select
                id="kind"
                name="kind"
                className={SELECT_CLS}
                value={kind}
                onChange={(e) => setKind(e.target.value as "skill" | "action")}
              >
                <option value="skill">skill(沙箱腳本)</option>
                <option value="action">action(外部整合)</option>
              </select>
            </div>
          </div>
          <div>
            <Label htmlFor="description">說明(AI 靠這句判斷何時用)</Label>
            <Input id="description" name="description" required />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="scope">範圍</Label>
              <select
                id="scope"
                name="scope"
                className={SELECT_CLS}
                value={scope}
                onChange={(e) => setScope(e.target.value as typeof scope)}
              >
                <option value="personal">個人</option>
                {(role === "manager" || role === "admin") && (
                  <option value="department">部門</option>
                )}
                {role === "admin" && <option value="org">全公司</option>}
              </select>
            </div>
            {scope === "department" && role === "admin" && (
              <div>
                <Label htmlFor="departmentId">部門</Label>
                <select id="departmentId" name="departmentId" className={SELECT_CLS}>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {kind === "skill" ? (
            <div className="space-y-3 rounded-lg bg-muted/40 p-3">
              <div>
                <Label htmlFor="lang">語言</Label>
                <select id="lang" name="lang" className={SELECT_CLS}>
                  <option value="bash">bash</option>
                  <option value="python">python</option>
                </select>
              </div>
              <div>
                <Label htmlFor="body">腳本(位置參數 $1 $2… 由 AI 傳入)</Label>
                <textarea
                  id="body"
                  name="body"
                  rows={6}
                  className={TEXTAREA_CLS}
                  placeholder={'#!/usr/bin/env bash\nfor n in "$@"; do echo "${n^^}"; done'}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-3 rounded-lg bg-muted/40 p-3">
              <div className="grid gap-3 sm:grid-cols-[7rem_1fr]">
                <div>
                  <Label htmlFor="method">Method</Label>
                  <select id="method" name="method" className={SELECT_CLS}>
                    {["POST", "GET", "PUT", "PATCH", "DELETE"].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="url">URL(可用 {"{{param}}"})</Label>
                  <Input
                    id="url"
                    name="url"
                    placeholder="https://git.example.com/repos/{{repo}}/issues"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="params">參數(一行一個,結尾 * = 必填)</Label>
                <textarea
                  id="params"
                  name="params"
                  rows={3}
                  className={TEXTAREA_CLS}
                  placeholder={"repo*\ntitle*\nbody"}
                />
              </div>
              <div>
                <Label htmlFor="headers">Headers(一行 Key: value,可用 {"{{secret}}"})</Label>
                <textarea
                  id="headers"
                  name="headers"
                  rows={2}
                  className={TEXTAREA_CLS}
                  placeholder={"Authorization: token {{secret}}\nContent-Type: application/json"}
                />
              </div>
              <div>
                <Label htmlFor="actionBody">Body 模板(可用 {"{{param}}"})</Label>
                <textarea
                  id="actionBody"
                  name="actionBody"
                  rows={3}
                  className={TEXTAREA_CLS}
                  placeholder={'{"title":"{{title}}","body":"{{body}}"}'}
                />
              </div>
              <div className="grid items-end gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="secretName">憑證名稱(選填,見憑證庫)</Label>
                  <Input id="secretName" name="secretName" placeholder="git_token" />
                </div>
                <label className="flex items-center gap-2 pb-2 text-sm">
                  <input type="checkbox" name="sensitive" className="size-4" />
                  敏感 — 執行前需在聊天確認(HITL)
                </label>
              </div>
            </div>
          )}

          {state.error && <p className="text-sm text-red-600">{state.error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={pending}>
              <Plus className="size-4" /> 新增
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SecretsPanel({
  role,
  departments,
  secrets,
}: {
  role: string;
  departments: Dept[];
  secrets: SecretItem[];
}) {
  const [scope, setScope] = useState<"department" | "org">("department");
  const [state, action, pending] = useActionState(putSecretAction, initial);
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    if (state.ok) setJustSaved(true);
  }, [state.ok]);

  return (
    <div className="space-y-5">
      <div className="rounded-xl border p-4">
        <div className="mb-1 flex items-center gap-2 text-sm font-medium">
          <KeyRound className="size-4" /> 新增憑證
        </div>
        <p className="text-muted-foreground mb-3 text-xs">
          給 action 工具用的密鑰,AES 加密存。值永遠不會顯示、不進 AI、不進日誌。
        </p>
        <form action={action} className="grid items-end gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="secret-name">名稱</Label>
            <Input id="secret-name" name="name" placeholder="git_token" required />
          </div>
          <div>
            <Label htmlFor="secret-value">值</Label>
            <Input id="secret-value" name="value" type="password" required />
          </div>
          <div>
            <Label htmlFor="secret-scope">範圍</Label>
            <select
              id="secret-scope"
              name="scope"
              className={SELECT_CLS}
              value={scope}
              onChange={(e) => setScope(e.target.value as typeof scope)}
            >
              <option value="department">部門</option>
              {role === "admin" && <option value="org">全公司</option>}
            </select>
          </div>
          {scope === "department" && role === "admin" && (
            <div>
              <Label htmlFor="secret-dept">部門</Label>
              <select id="secret-dept" name="departmentId" className={SELECT_CLS}>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="sm:col-span-2 flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              <Plus className="size-4" /> 儲存憑證
            </Button>
            {state.error && <span className="text-sm text-red-600">{state.error}</span>}
            {justSaved && !state.error && (
              <span className="text-sm text-emerald-600">已儲存。</span>
            )}
          </div>
        </form>
      </div>

      {secrets.length === 0 ? (
        <p className="text-muted-foreground text-sm">尚無憑證。</p>
      ) : (
        <div className="divide-y rounded-xl border">
          {secrets.map((s) => (
            <div key={s.id} className="flex items-center gap-3 p-3">
              <KeyRound className="text-muted-foreground size-4" />
              <code className="text-sm font-medium">{s.name}</code>
              <Badge variant="outline" className="text-xs font-normal">
                {s.scope === "department" ? `部門 · ${s.departmentName}` : "全公司"}
              </Badge>
              <span className="text-muted-foreground ml-auto font-mono text-xs">••••••••</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-red-600"
                aria-label={`刪除 ${s.name}`}
                onClick={() => deleteSecretAction(s.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
