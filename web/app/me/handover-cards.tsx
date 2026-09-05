"use client";

import { useState, useTransition } from "react";
import { ArrowRightLeft, MessageCircleQuestion } from "lucide-react";
import {
  answerQuestionAction,
  approveHandoverAction,
  askPredecessorAction,
  rejectHandoverAction,
  submitFollowupAction,
} from "@/lib/handover-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type ApprovableRow = { id: string; toName: string; scope: string };
export type ReceivedRow = {
  id: string;
  fromName: string;
  completedAt: string | null;
  summary: string | null;
  graceUntil: string | null;
  followupDone: boolean;
  custodial: boolean;
};
export type QuestionRow = {
  id: string;
  question: string;
  kind: string; // gap (缺口分析產生) | successor (接手者追問)
  toName: string;
};

const FOLLOWUP_DAYS = 30;

// A's side: handovers waiting for their personal sign-off.
export function HandoverApprovalCard({ rows }: { rows: ApprovableRow[] }) {
  const [msg, setMsg] = useState("");
  const [pending, startTransition] = useTransition();
  // Keep rendering after the last row is handled so the outcome message
  // ("交接完成…") doesn't vanish with the card.
  if (rows.length === 0 && !msg) return null;
  const act = (fn: (id: string) => Promise<{ ok: boolean; message: string }>, id: string) =>
    startTransition(async () => setMsg((await fn(id)).message));
  return (
    <Card className="border-amber-400/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ArrowRightLeft className="size-4" /> 待你核可的交接
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {rows.map((h) => (
          <div key={h.id} className="flex flex-wrap items-center gap-2">
            <span>
              把你的工作脈絡交接給 <b>{h.toName}</b>(
              {h.scope === "all" ? "全部" : "指定專案"})
            </span>
            <Button size="sm" disabled={pending} onClick={() => act(approveHandoverAction, h.id)}>
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
          </div>
        ))}
        {msg && <p>{msg}</p>}
      </CardContent>
    </Card>
  );
}

// A's side (v2-A/C): interview & follow-up questions awaiting their answer.
// Answers become memories and flow to the successor automatically.
export function HandoverInterviewCard({ rows }: { rows: QuestionRow[] }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [pending, startTransition] = useTransition();
  // Same as the approval card: the "已記錄" feedback must survive answering
  // the final question.
  if (rows.length === 0 && !msg) return null;
  const send = (id: string, text: string) =>
    startTransition(async () => setMsg((await answerQuestionAction(id, text)).message));
  return (
    <Card className="border-sky-400/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageCircleQuestion className="size-4" /> 交接訪談 — 只有你答得出來的{" "}
          {rows.length} 題
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {rows.length > 0 && (
          <p className="text-muted-foreground text-xs">
            AI 比對了你的進行中工作與已留下的記憶,找出接手者(
            {[...new Set(rows.map((r) => r.toName))].join("、")}
            )會需要、但目前沒人知道的事。答一題,組織就少一個知識黑洞;答案會自動進入交接包。
          </p>
        )}
        {rows.map((q) => (
          <div key={q.id} className="space-y-1.5">
            <p>
              {q.kind === "successor" && (
                <span className="text-amber-600 mr-1 text-xs font-medium">[接手者追問]</span>
              )}
              {q.question}
            </p>
            <div className="flex items-start gap-2">
              <textarea
                className="border-input bg-background min-h-16 flex-1 rounded-md border p-2 text-sm"
                placeholder="流程、窗口、帳號、眉角…寫給接手的人看"
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              />
              <div className="flex shrink-0 flex-col gap-1.5">
                <Button
                  size="sm"
                  disabled={pending || !(answers[q.id] ?? "").trim()}
                  onClick={() => send(q.id, answers[q.id] ?? "")}
                >
                  送出
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => send(q.id, "")}
                >
                  略過
                </Button>
              </div>
            </div>
          </div>
        ))}
        {msg && <p>{msg}</p>}
      </CardContent>
    </Card>
  );
}

// B's side: completed handovers received — position report, ask-the-
// predecessor channel (v2-C), and the 30-day follow-up (v2-F).
export function HandoverReceivedCard({ rows }: { rows: ReceivedRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [question, setQuestion] = useState<Record<string, string>>({});
  const [followup, setFollowup] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [pending, startTransition] = useTransition();
  if (rows.length === 0) return null;
  const ask = (id: string) =>
    startTransition(async () => {
      const r = await askPredecessorAction(id, question[id] ?? "");
      setMsg(r.message);
      if (r.ok) setQuestion({ ...question, [id]: "" });
    });
  const sendFollowup = (id: string) =>
    startTransition(async () =>
      setMsg((await submitFollowupAction(id, followup[id] ?? "")).message),
    );
  const followupDue = (h: ReceivedRow) =>
    !h.followupDone &&
    h.completedAt !== null &&
    Date.now() - new Date(h.completedAt).getTime() > FOLLOWUP_DAYS * 86400_000;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ArrowRightLeft className="size-4" /> 你接收的交接
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {rows.map((h) => (
          <div key={h.id} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span>
                來自 <b>{h.fromName}</b> 的交接
                {h.completedAt ? `(${h.completedAt.slice(0, 10)})` : ""}
                {h.custodial ? " — 職位暫存,由你暫管" : ""}
              </span>
              {h.summary && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setOpen(open === h.id ? null : h.id)}
                >
                  {open === h.id ? "收合報告" : "看職位現況報告"}
                </Button>
              )}
            </div>
            {open === h.id && h.summary && (
              <pre className="bg-muted max-h-96 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
                {h.summary}
              </pre>
            )}
            <div className="flex items-center gap-2">
              <input
                className="border-input bg-background h-8 flex-1 rounded-md border px-2 text-sm"
                placeholder={`記憶跟報告都答不了?直接問 ${h.fromName},回覆會自動進你的交接記憶`}
                value={question[h.id] ?? ""}
                onChange={(e) => setQuestion({ ...question, [h.id]: e.target.value })}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !(question[h.id] ?? "").trim()}
                onClick={() => ask(h.id)}
              >
                問前任
              </Button>
            </div>
            {h.graceUntil && (
              <p className="text-muted-foreground text-xs">
                追問寬限期至 {h.graceUntil.slice(0, 10)};之後仍可提問,但前任不一定回。
              </p>
            )}
            {followupDue(h) && (
              <div className="rounded-md border border-dashed p-3">
                <p className="mb-1.5 font-medium">交接滿月回顧</p>
                <p className="text-muted-foreground mb-2 text-xs">
                  接手一個月了 — 還有哪裡卡?一行一個,會轉成問題請 {h.fromName} 補答;都順利就直接送出。
                </p>
                <textarea
                  className="border-input bg-background min-h-16 w-full rounded-md border p-2 text-sm"
                  value={followup[h.id] ?? ""}
                  onChange={(e) => setFollowup({ ...followup, [h.id]: e.target.value })}
                />
                <Button
                  size="sm"
                  className="mt-2"
                  disabled={pending}
                  onClick={() => sendFollowup(h.id)}
                >
                  送出回顧
                </Button>
              </div>
            )}
          </div>
        ))}
        <p className="text-muted-foreground text-xs">
          交接的記憶已進入你的 AI 同事 — 直接問「上一任卡在哪、下一步做什麼」即可;AI
          答不了時也會替你把問題送給前任。
        </p>
        {msg && <p>{msg}</p>}
      </CardContent>
    </Card>
  );
}
