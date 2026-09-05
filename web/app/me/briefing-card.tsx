"use client";

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function BriefingCard() {
  const [briefing, setBriefing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/briefing", { method: "POST" });
      if (res.status === 429) {
        setError("剛剛才生成過,稍等一下再試。");
        return;
      }
      if (!res.ok) {
        setError("生成失敗,請再試一次。");
        return;
      }
      const data = await res.json();
      // model sometimes ignores the no-markdown instruction — strip bold marks
      setBriefing(String(data.briefing).replace(/\*\*/g, ""));
    } catch {
      setError("生成失敗,請再試一次。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-primary/20 bg-primary/[0.03]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4" /> AI 每日簡報
          <Button
            size="sm"
            variant={briefing ? "outline" : "default"}
            className="ml-auto"
            onClick={generate}
            disabled={busy}
          >
            {busy ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> 生成中…
              </>
            ) : briefing ? (
              "重新生成"
            ) : (
              "生成今日簡報"
            )}
          </Button>
        </CardTitle>
      </CardHeader>
      {(briefing || error) && (
        <CardContent>
          {error && <p className="text-destructive text-sm">{error}</p>}
          {briefing && (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{briefing}</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
