"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Standalone manager dispatch. Same-department → todo now; cross-department →
// the assignee must accept (HITL) before it lands on their list.
export function DispatchForm({ projectId, members }: { projectId: string; members: { id: string; name: string }[] }) {
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!title.trim() || !assigneeId || busy) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, assigneeId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setErr(data?.error ?? "指派失敗");
        return;
      }
      setMsg(data.status === "assigned" ? "已建立待辦並通知負責人。" : "跨部門指派 — 等待對方同意後才會進入他的待辦。");
      setTitle("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="text-base">指派任務</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="任務內容"
          className="bg-background w-full rounded-md border px-2 py-1 text-sm"
          aria-label="任務內容"
        />
        <div className="flex gap-2">
          <select
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            className="bg-background flex-1 rounded-md border px-2 py-1 text-sm"
            aria-label="指派給"
          >
            <option value="">指派給…</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <Button size="sm" disabled={busy || !title.trim() || !assigneeId} onClick={submit} data-testid="dispatch-submit">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} 指派
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">跨部門指派需對方本人同意(HITL);待辦會標示「由你指派」。</p>
        {msg && <p className="text-sm text-emerald-700" data-testid="dispatch-msg">{msg}</p>}
        {err && <p className="text-destructive text-sm">{err}</p>}
      </CardContent>
    </Card>
  );
}
