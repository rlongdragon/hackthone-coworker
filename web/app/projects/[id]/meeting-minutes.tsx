"use client";

import { useRef, useState } from "react";
import { FileAudio, Loader2, Mic, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type MeetingTaskDto = {
  title: string;
  assignee?: string;
  needsConfirm: boolean;
  assigneeId?: string;
  assigneeName?: string;
  todoId?: string;
  pendingId?: string;
  status?: "unconfirmed" | "assigned" | "pending_consent";
};
export type MeetingRecordDto = {
  id: string;
  createdByName: string | null;
  createdAt: string;
  source: "audio" | "text" | "telegram";
  transcript: string;
  decisions: string[];
  tasks: MeetingTaskDto[];
  tainted: boolean;
  asr?: { mock?: boolean };
  truncated?: boolean;
  analysedChars?: number;
};
type Member = { id: string; name: string };

// Pick a default assignee for an extracted task from the model's name hint
// (untrusted) — only ever a MEMBER of this project, never free text.
function guessAssignee(hint: string | undefined, members: Member[]): string {
  if (typeof hint !== "string" || !hint) return ""; // extraction output is untrusted
  const h = hint.trim();
  const m = members.find((x) => x.name.includes(h) || h.includes(x.name.split(/[\s(（]/)[0]));
  return m?.id ?? "";
}

export function MeetingMinutes({
  projectId,
  members,
  initial,
  canEdit,
  asrEnabled,
}: {
  projectId: string;
  members: Member[];
  initial: MeetingRecordDto[];
  canEdit: boolean;
  asrEnabled: boolean;
}) {
  const [records, setRecords] = useState<MeetingRecordDto[]>(initial);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // per record: index → { checked, assigneeId }
  const [sel, setSel] = useState<Record<string, Record<number, { checked: boolean; assigneeId: string }>>>({});

  function selFor(r: MeetingRecordDto) {
    return (
      sel[r.id] ??
      Object.fromEntries(
        r.tasks.map((t, i) => [i, { checked: t.status === "unconfirmed" || !t.status, assigneeId: t.assigneeId ?? guessAssignee(t.assignee, members) }]),
      )
    );
  }

  async function submit() {
    const file = fileRef.current?.files?.[0];
    if (!text.trim() && !file) {
      setError("請貼上逐字稿,或上傳會議音檔。");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const fd = new FormData();
      if (text.trim()) fd.append("transcript", text);
      if (file) fd.append("file", file);
      const res = await fetch(`/api/projects/${projectId}/meetings`, { method: "POST", body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "處理失敗,請再試一次。");
        return;
      }
      setRecords((cur) => [data as MeetingRecordDto, ...cur]);
      setText("");
      setFileName(null);
      if (fileRef.current) fileRef.current.value = "";
      setNotice(`已抽取 ${(data as MeetingRecordDto).decisions.length} 項決議、${(data as MeetingRecordDto).tasks.length} 項行動項目 — 全部待你確認。`);
    } catch {
      setError("處理失敗,請再試一次。");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(r: MeetingRecordDto) {
    const s = selFor(r);
    const items = Object.entries(s)
      .filter(([, v]) => v.checked && v.assigneeId)
      .map(([i, v]) => ({ index: Number(i), assigneeId: v.assigneeId }));
    if (!items.length) {
      setError("請勾選要指派的項目並選擇負責人。");
      return;
    }
    setConfirming(r.id);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/meetings/${r.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "指派失敗。");
        return;
      }
      const updated = data.record as MeetingRecordDto;
      setRecords((cur) => cur.map((x) => (x.id === updated.id ? updated : x)));
      const results = data.results as { status: string; error?: string }[];
      const assigned = results.filter((x) => x.status === "assigned").length;
      const pend = results.filter((x) => x.status === "pending_consent").length;
      const skipped = results.filter((x) => x.status === "skipped");
      if (!assigned && !pend) {
        setError(skipped[0]?.error ?? "沒有任何項目被指派(可能已處理或無權指派)。");
      } else {
        setNotice(
          `${assigned ? `已建立 ${assigned} 項待辦並通知負責人` : ""}${assigned && pend ? ";" : ""}${pend ? `${pend} 項跨部門,等待對方同意` : ""}` +
            (skipped.length ? `;${skipped.length} 項略過(${skipped[0]?.error ?? "已處理"})` : "") + "。",
        );
      }
    } finally {
      setConfirming(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mic className="size-4" /> 會議記錄 {records.length}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canEdit && (
          <div className="space-y-2 rounded-lg border p-3">
            <textarea
              name="transcript"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="貼上會議逐字稿 / 筆記(或改上傳音檔,交給自架 ASR 轉文字)…"
              className="bg-background min-h-24 w-full rounded-md border p-2 text-sm"
            />
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg"
                hidden
                onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
              />
              <Button type="button" size="sm" variant="outline" disabled={busy || !asrEnabled} onClick={() => fileRef.current?.click()} title={asrEnabled ? "" : "未設定 ASR 服務"}>
                <FileAudio className="size-3.5" /> {fileName ?? "上傳音檔"}
              </Button>
              <Button type="button" size="sm" disabled={busy} onClick={submit} data-testid="meeting-submit">
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} 轉錄並抽取決議
              </Button>
              <span className="text-muted-foreground text-xs">內容視為不可信資料;抽出的項目需人工確認後才成為任務。</span>
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            {notice && <p className="text-sm text-emerald-700">{notice}</p>}
          </div>
        )}

        {records.length === 0 && <p className="text-muted-foreground text-sm">還沒有會議記錄。</p>}

        {records.map((r) => {
          const s = selFor(r);
          const hasUnconfirmed = r.tasks.some((t) => (t.status ?? "unconfirmed") === "unconfirmed");
          return (
            <div key={r.id} className="rounded-lg border p-3" data-testid="meeting-record">
              <div className="text-muted-foreground mb-2 flex flex-wrap items-center gap-2 text-xs">
                <span>{r.createdByName ?? "?"}</span>
                <span>·</span>
                <span>{new Date(r.createdAt).toLocaleString("zh-TW")}</span>
                <Badge variant="outline">{r.source === "audio" ? "音檔 → ASR" : r.source === "telegram" ? "Telegram 群組摘要" : "逐字稿"}</Badge>
                {r.tainted && <Badge variant="secondary">不可信來源</Badge>}
                {r.asr?.mock && <Badge variant="destructive">ASR 模型未就緒(示意輸出)</Badge>}
                {r.truncated && <Badge variant="outline">僅分析前 {r.analysedChars ?? 40000} 字</Badge>}
              </div>
              <details className="mb-2">
                <summary className="cursor-pointer text-sm">逐字稿({r.transcript.length} 字)</summary>
                <pre className="bg-muted/40 mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded p-2 text-xs">{r.transcript}</pre>
              </details>
              <div className="mb-2">
                <div className="text-sm font-medium">決議 {r.decisions.length}</div>
                {r.decisions.length ? (
                  <ul className="list-disc pl-5 text-sm">{r.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
                ) : (
                  <p className="text-muted-foreground text-xs">無</p>
                )}
              </div>
              <div>
                <div className="text-sm font-medium">行動項目 {r.tasks.length}</div>
                {r.tasks.length === 0 && <p className="text-muted-foreground text-xs">無</p>}
                {r.tasks.length > 0 && (
                  <table className="mt-1 w-full text-sm">
                    <tbody>
                      {r.tasks.map((t, i) => {
                        const st = t.status ?? "unconfirmed";
                        const row = s[i];
                        return (
                          <tr key={i} className="border-t align-top">
                            <td className="w-6 py-1">
                              {st === "unconfirmed" && canEdit && (
                                <input
                                  type="checkbox"
                                  checked={row?.checked ?? false}
                                  onChange={(e) => setSel((cur) => ({ ...cur, [r.id]: { ...s, [i]: { ...(row ?? { assigneeId: "" }), checked: e.target.checked } } }))}
                                  aria-label={`選取 ${t.title}`}
                                />
                              )}
                            </td>
                            <td className="py-1">{t.title}</td>
                            <td className="py-1">
                              {st === "unconfirmed" && canEdit ? (
                                <select
                                  className="bg-background rounded border px-1 py-0.5 text-xs"
                                  value={row?.assigneeId ?? ""}
                                  onChange={(e) => setSel((cur) => ({ ...cur, [r.id]: { ...s, [i]: { ...(row ?? { checked: true }), assigneeId: e.target.value } } }))}
                                  aria-label={`負責人 ${t.title}`}
                                >
                                  <option value="">選擇負責人</option>
                                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                                </select>
                              ) : (
                                <span className="text-xs">{t.assigneeName ?? "—"}</span>
                              )}
                            </td>
                            <td className="py-1 text-right">
                              {st === "assigned" && <Badge variant="secondary">已建待辦</Badge>}
                              {st === "pending_consent" && <Badge variant="outline">等待對方同意(跨部門)</Badge>}
                              {st === "unconfirmed" && <Badge variant="destructive">需確認</Badge>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {hasUnconfirmed && canEdit && (
                  <Button size="sm" className="mt-2" disabled={confirming === r.id} onClick={() => confirm(r)} data-testid="meeting-confirm">
                    {confirming === r.id ? <Loader2 className="size-3.5 animate-spin" /> : null} 確認並指派
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
