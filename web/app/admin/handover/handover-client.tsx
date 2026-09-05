"use client";

import { useState, useTransition } from "react";
import {
  analyzeGapsAction,
  approveHandoverAction,
  createHandoverAction,
  deactivateEmployeeAction,
  reactivateEmployeeAction,
  rejectHandoverAction,
} from "@/lib/handover-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Person = { id: string; name: string; email: string; active: boolean };
type Project = { id: string; name: string };
type Row = {
  id: string;
  fromName: string;
  toName: string;
  createdByName: string;
  createdBy: string;
  fromEmployeeId: string;
  toEmployeeId: string;
  scope: string;
  status: string;
  error: string | null;
  createdAt: string;
  custodial: boolean;
  parentHandoverId: string | null;
  gapScore: number | null;
  gapTopics: string[];
  openQuestions: number;
  answeredQuestions: number;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待核可",
  running: "執行中",
  completed: "已完成",
  rejected: "已拒絕",
  failed: "失敗(已回滾)",
};

const INCLUDE_ITEMS = [
  ["memories", "工作記憶"],
  ["skills", "沙箱技能"],
  ["cards", "看板卡片"],
  ["todos", "待辦"],
  ["events", "未來行事曆"],
] as const;

export function HandoverClient({
  me,
  people,
  projects,
  handovers,
}: {
  me: { id: string; role: string };
  people: Person[];
  projects: Project[];
  handovers: Row[];
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [scope, setScope] = useState<"all" | "project">("all");
  const [projectId, setProjectId] = useState("");
  const [include, setInclude] = useState<Record<string, boolean>>({
    memories: true,
    skills: true,
    cards: true,
    todos: true,
    events: false,
  });
  const [custodial, setCustodial] = useState(false);
  // v2-D second stage: set from a completed custodial row's 二次交接 button.
  const [parentId, setParentId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = () =>
    startTransition(async () => {
      const r = await createHandoverAction({
        fromEmployeeId: from,
        toEmployeeId: to,
        scope,
        projectId: scope === "project" ? projectId : null,
        include,
        custodial: parentId ? false : custodial,
        parentHandoverId: parentId,
      });
      setMsg(r.message);
      if (r.ok) setParentId(null);
    });

  const startRehandover = (h: Row) => {
    setParentId(h.id);
    setFrom(h.toEmployeeId); // custodian hands the package on
    setTo("");
    setScope("all");
    setCustodial(false);
    setMsg(`二次交接:把「${h.fromName}」的暫存包從暫管人 ${h.toName} 轉給正式接手者`);
  };

  const act = (fn: (id: string) => Promise<{ ok: boolean; message: string }>, id: string) =>
    startTransition(async () => {
      const r = await fn(id);
      setMsg(r.message);
    });

  const sel = "border-input bg-background h-9 rounded-md border px-2 text-sm";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">發起交接</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <select className={sel} value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">交出者…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.active ? "" : "(已停用)"}
                </option>
              ))}
            </select>
            <span>→</span>
            <select className={sel} value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">接手者…</option>
              {people
                .filter((p) => p.active && p.id !== from)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <select
              className={sel}
              value={scope}
              onChange={(e) => setScope(e.target.value as "all" | "project")}
            >
              <option value="all">全部</option>
              <option value="project">指定專案</option>
            </select>
            {scope === "project" && (
              <select
                className={sel}
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">選專案…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="flex flex-wrap gap-4">
            {INCLUDE_ITEMS.map(([key, label]) => (
              <label key={key} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="accent-primary size-4"
                  checked={include[key] ?? false}
                  onChange={(e) => setInclude({ ...include, [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
          </div>
          {!parentId && (
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="accent-primary size-4"
                checked={custodial}
                onChange={(e) => setCustodial(e.target.checked)}
              />
              職位暫存(還沒找到繼任者 — 接手者只是暫管人,正式接手者到職後可一鍵二次交接)
            </label>
          )}
          {parentId && (
            <p className="rounded-md border border-dashed px-3 py-2 text-xs">
              二次交接模式:交出者已鎖定為暫管人,只會轉移原暫存包(保留原離任者出處)。
              <button className="ml-2 underline" onClick={() => setParentId(null)}>
                取消
              </button>
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            個人偏好記憶與對話原文永不轉移。發起後由交出者本人核可;交出者已停用時,由另一位管理員核可(發起人不能自批)。
            建立時會自動跑「知識缺口分析」:比對交出者的活躍工作面與記憶覆蓋,產生訪談題送交出者在「今日總覽」作答。
          </p>
          <Button size="sm" disabled={pending || !from || !to} onClick={submit}>
            {parentId ? "建立二次交接" : "建立交接"}
          </Button>
          {msg && <p className="text-sm">{msg}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">交接紀錄</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>交出 → 接手</TableHead>
                <TableHead>範圍</TableHead>
                <TableHead>發起人</TableHead>
                <TableHead>狀態</TableHead>
                <TableHead>知識覆蓋</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {handovers.map((h) => {
                const canApprove =
                  h.status === "pending" &&
                  h.createdBy !== me.id &&
                  (h.fromEmployeeId === me.id || me.role === "admin");
                return (
                  <TableRow key={h.id}>
                    <TableCell>
                      {h.fromName} → {h.toName}
                      {h.custodial && (
                        <Badge variant="outline" className="ml-2">
                          職位暫存
                        </Badge>
                      )}
                      {h.parentHandoverId && (
                        <Badge variant="outline" className="ml-2">
                          二次交接
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{h.scope === "all" ? "全部" : "專案"}</TableCell>
                    <TableCell>{h.createdByName}</TableCell>
                    <TableCell>
                      <Badge variant={h.status === "completed" ? "default" : "outline"}>
                        {STATUS_LABEL[h.status] ?? h.status}
                      </Badge>
                      {h.error && (
                        <span className="text-destructive ml-2 text-xs">{h.error}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {h.gapScore == null ? (
                        <span className="text-muted-foreground">未分析</span>
                      ) : (
                        <details>
                          <summary className="cursor-pointer">
                            覆蓋 {h.gapScore}%
                            {h.openQuestions > 0 && `,${h.openQuestions} 題待答`}
                            {h.answeredQuestions > 0 && `,${h.answeredQuestions} 題已答`}
                          </summary>
                          {h.gapTopics.length > 0 ? (
                            <ul className="text-muted-foreground mt-1 list-disc pl-4">
                              {h.gapTopics.map((t) => (
                                <li key={t}>{t}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-muted-foreground mt-1">無明顯缺口</p>
                          )}
                        </details>
                      )}
                    </TableCell>
                    <TableCell className="space-x-2 whitespace-nowrap">
                      {canApprove && (
                        <>
                          <Button
                            size="sm"
                            disabled={pending}
                            onClick={() => act(approveHandoverAction, h.id)}
                          >
                            核可並執行
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={() => act(rejectHandoverAction, h.id)}
                          >
                            拒絕
                          </Button>
                        </>
                      )}
                      {(h.status === "pending" || h.status === "completed") && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => act(analyzeGapsAction, h.id)}
                        >
                          {h.gapScore == null ? "缺口分析" : "重新分析"}
                        </Button>
                      )}
                      {h.status === "completed" && h.custodial && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => startRehandover(h)}
                        >
                          二次交接
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {handovers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    還沒有交接紀錄。
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {me.role === "admin" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">帳號封存(離職)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground text-xs">
              停用後不可登入、AI 停止運作;sandbox 容器回收、技能 volume 保留供交接。
            </p>
            <ul className="space-y-1.5">
              {people.map((p) => (
                <li key={p.id} className="flex items-center gap-3">
                  <span className={p.active ? "" : "text-muted-foreground line-through"}>
                    {p.name}({p.email})
                  </span>
                  {p.id !== me.id &&
                    (p.active ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => act(deactivateEmployeeAction, p.id)}
                      >
                        停用
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => act(reactivateEmployeeAction, p.id)}
                      >
                        恢復
                      </Button>
                    ))}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
