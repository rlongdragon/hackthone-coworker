"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { runRedTeamAction } from "@/lib/agent-society-actions";

export function RunRedTeamButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-3">
      <Button
        disabled={pending}
        onClick={() =>
          start(async () => {
            setMsg(null);
            const r = await runRedTeamAction();
            setMsg(
              r.error
                ? `失敗:${r.error}`
                : `完成:跑了 ${r.ran} 個攻擊、偵測到 ${r.detected} 項、守住 ${r.defended} 項`,
            );
            router.refresh();
          })
        }
      >
        {pending ? "紅隊執行中…" : "立即執行紅隊"}
      </Button>
      {msg && <span className="text-muted-foreground text-sm">{msg}</span>}
    </div>
  );
}

// The leak scoreboard: our MEASURED governed leak-rate vs. the framework-default
// (prompt-only) counterfactual. Toggle flips which mode the big number shows.
export function LeakScoreboard(props: {
  crossScopeRequests: number;
  governedLeakRate: number; // measured, should be 0
  frameworkDefaultLeakRate: number; // counterfactual, 1
}) {
  const [governed, setGoverned] = useState(true);
  const rate = governed ? props.governedLeakRate : props.frameworkDefaultLeakRate;
  const pct = Math.round(rate * 100);
  return (
    <div className="rounded-lg border p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">跨部門委派洩漏率</span>
        <div className="flex gap-1">
          <button
            onClick={() => setGoverned(true)}
            className={`rounded px-2 py-0.5 text-xs ${governed ? "bg-foreground text-background" : "border"}`}
          >
            治理模式
          </button>
          <button
            onClick={() => setGoverned(false)}
            className={`rounded px-2 py-0.5 text-xs ${!governed ? "bg-foreground text-background" : "border"}`}
          >
            framework-default
          </button>
        </div>
      </div>
      <div className={`text-4xl font-bold ${governed ? "text-emerald-600" : "text-red-600"}`}>
        {pct}%
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {props.crossScopeRequests} 次跨範圍委派請求。治理模式下交集 PEP 在工具邊界擋下越權資料 →
        實測洩漏 {Math.round(props.governedLeakRate * 100)}%;prompt-only(framework-default)相同請求全數洩漏,
        文獻回報 prompt 級「別洩漏」失敗率約 35–51%。偵測為機率性 — 這裡做的是「持續偵測 + 縮小爆炸半徑」,非「解決注入」。
      </p>
    </div>
  );
}
