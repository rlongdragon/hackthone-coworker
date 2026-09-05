"use client";

import { useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Identity = {
  projectName: string;
  permissions: string[];
  memberCount: number;
  meetingCount: number;
  decisionCount: number;
};
type Prov = { type: string; ref: string; label: string };

export function TeamAgent({ projectId, identity }: { projectId: string; identity: Identity }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [prov, setProv] = useState<Prov[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    if (!q.trim() || busy) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/agent/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "詢問失敗");
        return;
      }
      setAnswer(data.answer);
      setProv(data.provenance ?? []);
    } catch {
      setError("詢問失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="size-4" /> 團隊代理
          <Badge variant="secondary" className="ml-auto">scope=team</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-muted-foreground text-xs">
          「{identity.projectName}」的專屬代理:只看團隊自己產出的資料(看板、檔案、{identity.meetingCount} 場會議 / {identity.decisionCount} 項決議),不碰任何成員的私人記憶;沒有工具,只回答不行動。
        </p>
        <div className="flex flex-wrap gap-1">
          {identity.permissions.map((p) => (
            <span key={p} className="bg-muted rounded px-1.5 py-0.5 font-mono text-[10px]">{p}</span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
            placeholder="問團隊代理:上次會議決議了什麼?"
            className="bg-background flex-1 rounded-md border px-2 py-1 text-sm"
            aria-label="問團隊代理"
          />
          <Button size="sm" disabled={busy || !q.trim()} onClick={ask} data-testid="team-agent-ask">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : "問"}
          </Button>
        </div>
        {error && <p className="text-destructive text-sm">{error}</p>}
        {answer && (
          <div className="rounded-md border p-2 text-sm" data-testid="team-agent-answer">
            <p className="whitespace-pre-wrap">{answer}</p>
            {prov.length > 0 && (
              <p className="text-muted-foreground mt-2 text-xs">依據:{prov.map((p) => p.label).join("、")}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
