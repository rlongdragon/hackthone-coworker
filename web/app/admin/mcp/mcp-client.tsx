"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import {
  Plus,
  Trash2,
  Plug,
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
  Power,
  AlertTriangle,
} from "lucide-react";
import {
  createMcpServerAction,
  deleteMcpServerAction,
  installMcpFromRepoAction,
  reauditMcpServerAction,
  setMcpServerEnabledAction,
  setMcpToolPolicyAction,
  type McpFormState,
} from "@/lib/mcp-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type McpToolView = {
  name: string;
  description: string;
  policy: "auto" | "hitl" | "blocked";
  risk: "low" | "medium" | "high";
  flags: string[];
  enabled: boolean;
};

export type McpServerView = {
  id: string;
  name: string;
  scope: string;
  transport: string;
  endpoint: string;
  source: string;
  repoUrl: string | null;
  repoCommit: string | null;
  enabled: boolean;
  healthStatus: string;
  lastAuditAt: string | null;
  auditSummary: string | null;
  overallRisk: "low" | "medium" | "high" | null;
  supplyChain: { severity: string; label: string }[];
  tools: McpToolView[];
};

type Dept = { id: string; name: string };

const RISK_STYLE: Record<string, string> = {
  low: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  medium: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  high: "bg-red-500/10 text-red-600 border-red-500/20",
};
const POLICY_LABEL: Record<string, string> = {
  auto: "自動執行",
  hitl: "需審批",
  blocked: "封鎖",
};
const RISK_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };

export function McpClient({
  servers,
  departments,
  canDept,
}: {
  servers: McpServerView[];
  departments: Dept[];
  canDept: boolean;
}) {
  return (
    <div className="space-y-6">
      <AddServerDialog canDept={canDept} departments={departments} />
      {servers.length === 0 ? (
        <p className="text-muted-foreground text-sm">尚未接入任何 MCP server。</p>
      ) : (
        servers.map((s) => <ServerCard key={s.id} server={s} />)
      )}
    </div>
  );
}

function ScopeField({
  scope,
  setScope,
  canDept,
}: {
  scope: "personal" | "department" | "org";
  setScope: (v: "personal" | "department" | "org") => void;
  canDept: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label>可見範圍</Label>
      <Select value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="org">全公司</SelectItem>
          {canDept && <SelectItem value="department">我的部門</SelectItem>}
          <SelectItem value="personal">僅自己</SelectItem>
        </SelectContent>
      </Select>
      <input type="hidden" name="scope" value={scope} />
    </div>
  );
}

function AddServerDialog({ canDept, departments }: { canDept: boolean; departments: Dept[] }) {
  void departments;
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <Plus className="size-4" /> 新增 MCP server
          </Button>
        }
      />
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>接入外部 MCP server</DialogTitle>
          <DialogDescription>
            建立後會自動連線並做投毒審核,server 預設停用,審過再啟用。
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="manual">
          <TabsList className="mb-3">
            <TabsTrigger value="manual">連線既有 server</TabsTrigger>
            <TabsTrigger value="repo">從 GitHub repo 安裝</TabsTrigger>
          </TabsList>
          <TabsContent value="manual">
            <ManualForm canDept={canDept} onDone={() => setOpen(false)} />
          </TabsContent>
          <TabsContent value="repo">
            <RepoForm canDept={canDept} onDone={() => setOpen(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function ManualForm({ canDept, onDone }: { canDept: boolean; onDone: () => void }) {
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [scope, setScope] = useState<"personal" | "department" | "org">("org");
  const [state, action, pending] = useActionState<McpFormState, FormData>(
    createMcpServerAction,
    {},
  );
  useEffect(() => {
    if (state.ok && !state.error) onDone();
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <form action={action} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="mcp-name">名稱</Label>
            <Input id="mcp-name" name="name" required placeholder="github-mcp" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>可見範圍</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="org">全公司</SelectItem>
                  {canDept && <SelectItem value="department">我的部門</SelectItem>}
                  <SelectItem value="personal">僅自己</SelectItem>
                </SelectContent>
              </Select>
              <input type="hidden" name="scope" value={scope} />
            </div>
            <div className="space-y-1.5">
              <Label>連線方式</Label>
              <Select value={transport} onValueChange={(v) => setTransport(v as typeof transport)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP (Streamable)</SelectItem>
                  <SelectItem value="stdio">stdio (本機指令)</SelectItem>
                </SelectContent>
              </Select>
              <input type="hidden" name="transport" value={transport} />
            </div>
          </div>

          {transport === "http" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-url">Server URL</Label>
                <Input id="mcp-url" name="url" placeholder="http://localhost:3333/mcp" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-headers">認證 headers(選填,每行 Key: value,加密儲存)</Label>
                <textarea
                  id="mcp-headers"
                  name="headers"
                  rows={2}
                  className="border-input bg-transparent w-full rounded-md border px-3 py-2 text-sm"
                  placeholder="Authorization: Bearer xxx"
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-command">指令</Label>
                <Input id="mcp-command" name="command" placeholder="npx" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-args">參數(空白分隔)</Label>
                <Input id="mcp-args" name="args" placeholder="-y @modelcontextprotocol/server-filesystem /data" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-env">環境變數(選填,每行 KEY: value,加密儲存)</Label>
                <textarea
                  id="mcp-env"
                  name="env"
                  rows={2}
                  className="border-input bg-transparent w-full rounded-md border px-3 py-2 text-sm"
                  placeholder="GITHUB_TOKEN: ghp_xxx"
                />
              </div>
            </>
          )}

          {state.error && (
            <p className="text-sm text-red-600">{state.error}</p>
          )}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "連線審核中…" : "建立並審核"}
          </Button>
    </form>
  );
}

function RepoForm({ canDept, onDone }: { canDept: boolean; onDone: () => void }) {
  const [scope, setScope] = useState<"personal" | "department" | "org">("org");
  const [state, action, pending] = useActionState<McpFormState, FormData>(
    installMcpFromRepoAction,
    {},
  );
  useEffect(() => {
    if (state.ok && !state.error) onDone();
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <form action={action} className="space-y-4">
      <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
        會 clone 你指定的 commit、做供應鏈掃描,再<strong>在 <code>--network none</code> 隔離容器內</strong>執行(禁止對外連線)。安裝依賴時停用 install script。
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="repo-name">名稱</Label>
        <Input id="repo-name" name="name" required placeholder="my-internal-mcp" />
      </div>
      <ScopeField scope={scope} setScope={setScope} canDept={canDept} />
      <div className="space-y-1.5">
        <Label htmlFor="repo-url">GitHub repo URL</Label>
        <Input id="repo-url" name="repoUrl" required placeholder="https://github.com/org/mcp-server" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="repo-commit">Commit hash(必須釘死,不吃分支)</Label>
        <Input id="repo-commit" name="commit" required placeholder="a1b2c3d…" />
      </div>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "clone / 掃描 / 隔離啟動中…" : "clone 並審核"}
      </Button>
    </form>
  );
}

function ServerCard({ server }: { server: McpServerView }) {
  const [pending, start] = useTransition();
  const hasHigh = server.tools.some((t) => t.risk === "high" && t.policy !== "blocked");

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Plug className="size-4" />
              <span className="font-medium">{server.name}</span>
              <ScopeBadge scope={server.scope} />
              <HealthBadge status={server.healthStatus} />
              {server.enabled ? (
                <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">已啟用</Badge>
              ) : (
                <Badge variant="outline">未啟用</Badge>
              )}
            </div>
            <p className="text-muted-foreground mt-1 font-mono text-xs">{server.endpoint}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => start(async () => void (await reauditMcpServerAction(server.id)))}
              title="重新審核"
            >
              <RefreshCw className="size-4" />
            </Button>
            <Button
              variant={server.enabled ? "outline" : "default"}
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => void (await setMcpServerEnabledAction(server.id, !server.enabled)))
              }
            >
              <Power className="size-4" /> {server.enabled ? "停用" : "啟用"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => {
                if (confirm(`刪除「${server.name}」?`))
                  start(async () => void (await deleteMcpServerAction(server.id)));
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>

        {server.auditSummary && (
          <div className="mt-2 flex items-center gap-2 text-sm">
            {server.overallRisk === "high" ? (
              <ShieldAlert className="size-4 text-red-600" />
            ) : (
              <ShieldCheck className="size-4 text-emerald-600" />
            )}
            <span>{server.auditSummary}</span>
            {server.overallRisk && (
              <Badge className={RISK_STYLE[server.overallRisk]}>
                風險 {RISK_LABEL[server.overallRisk]}
              </Badge>
            )}
          </div>
        )}
        {server.source === "repo" && (
          <p className="text-muted-foreground mt-1 font-mono text-xs">
            repo: {server.repoUrl} @ {server.repoCommit?.slice(0, 10)}
          </p>
        )}
        {server.supplyChain.length > 0 && (
          <div className="mt-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs">
            <p className="mb-1 font-medium text-amber-700">供應鏈掃描</p>
            <ul className="space-y-0.5">
              {server.supplyChain.map((f, i) => (
                <li key={i} className="flex items-center gap-1 text-amber-700">
                  <AlertTriangle className="size-3 shrink-0" />
                  <span className="font-mono">[{f.severity}]</span> {f.label}
                </li>
              ))}
            </ul>
          </div>
        )}
        {server.enabled && hasHigh && (
          <div className="mt-2 flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">
            <AlertTriangle className="size-4" /> 有高風險工具未封鎖,已對外開放 — 請確認。
          </div>
        )}
      </CardHeader>

      <CardContent>
        {server.tools.length === 0 ? (
          <p className="text-muted-foreground text-sm">尚無工具(可能連線失敗,試試重新審核)。</p>
        ) : (
          <div className="divide-border divide-y">
            {server.tools.map((t) => (
              <ToolRow key={t.name} serverId={server.id} tool={t} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ToolRow({ serverId, tool }: { serverId: string; tool: McpToolView }) {
  const [pending, start] = useTransition();
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">{tool.name}</span>
          <Badge className={RISK_STYLE[tool.risk]}>{RISK_LABEL[tool.risk]}</Badge>
          {!tool.enabled && <Badge variant="outline">已停用</Badge>}
        </div>
        <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{tool.description}</p>
        {tool.flags.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {tool.flags.map((f, i) => (
              <li key={i} className="flex items-center gap-1 text-xs text-red-600">
                <AlertTriangle className="size-3 shrink-0" /> {f}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="shrink-0">
        <Select
          value={tool.policy}
          onValueChange={(v) =>
            start(async () => void (await setMcpToolPolicyAction(serverId, tool.name, v as McpToolView["policy"])))
          }
          disabled={pending}
        >
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{POLICY_LABEL.auto}</SelectItem>
            <SelectItem value="hitl">{POLICY_LABEL.hitl}</SelectItem>
            <SelectItem value="blocked">{POLICY_LABEL.blocked}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function ScopeBadge({ scope }: { scope: string }) {
  const label = scope === "org" ? "全公司" : scope === "department" ? "部門" : "個人";
  return <Badge variant="outline">{label}</Badge>;
}

function HealthBadge({ status }: { status: string }) {
  if (status === "ok")
    return <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">連線正常</Badge>;
  if (status === "down") return <Badge className="bg-red-500/10 text-red-600 border-red-500/20">連線異常</Badge>;
  return <Badge variant="outline">未檢查</Badge>;
}
