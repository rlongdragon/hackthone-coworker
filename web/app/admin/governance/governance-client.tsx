"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  rerunFindingAction,
  runRedTeamAction,
  tightenFindingAction,
} from "@/lib/agent-society-actions";

// Per-finding closed loop: 收緊/封鎖 applies the matching blue-team actuator,
// 再跑一次 re-fires just this template at the same target and shows the fresh
// status inline (after a tighten it should read `defended`).
const TIGHTEN_LABEL: Record<string, string> = {
  mcp_drift: "封鎖",
  over_privilege: "收緊",
  memory_timebomb: "隔離",
};
const DONE_ACTIONS = new Set(["tool_blocked", "tool_disabled", "memory_quarantined"]);

export function FindingActions(props: {
  id: string;
  template: string;
  status: string;
  actionTaken: string;
  hasTarget: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [tightened, setTightened] = useState(DONE_ACTIONS.has(props.actionTaken));
  const tightenLabel = TIGHTEN_LABEL[props.template];
  const canTighten = !!tightenLabel && props.status === "detected" && !tightened;
  return (
    <div className="flex flex-col gap-1" data-finding-actions={props.id}>
      <div className="flex gap-1">
        {tightenLabel && (
          <Button
            size="xs"
            variant={canTighten ? "destructive" : "outline"}
            disabled={pending || !canTighten}
            data-action="tighten"
            onClick={() =>
              start(async () => {
                setMsg(null);
                const r = await tightenFindingAction(props.id);
                if (r.ok) {
                  setTightened(true);
                  setMsg(`已${tightenLabel}:${r.applied.join("、")}(${r.actionTaken})`);
                } else {
                  setMsg(`失敗:${r.error}`);
                }
                router.refresh();
              })
            }
          >
            {tightened ? `已${tightenLabel}` : tightenLabel}
          </Button>
        )}
        {props.hasTarget && (
          <Button
            size="xs"
            variant="outline"
            disabled={pending}
            data-action="rerun"
            onClick={() =>
              start(async () => {
                setMsg(null);
                const r = await rerunFindingAction(props.id);
                setMsg(r.ok ? `重跑結果:${r.status}(${r.actionTaken})` : `失敗:${r.error}`);
                router.refresh();
              })
            }
          >
            {pending ? "…" : "再跑一次"}
          </Button>
        )}
      </div>
      {msg && (
        <span className="text-muted-foreground text-xs" data-finding-msg={props.id}>
          {msg}
        </span>
      )}
    </div>
  );
}

// A → B → C chips: name + tools usable at that hop, and (−n) what the
// intersection dropped. Origin shows its own current tool count.
export function DelegationChain(props: {
  hops: { id: string; name: string; exposed: number | null; dropped: number | null }[];
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-delegation-chain>
      {props.hops.map((h, i) => (
        <span key={`${h.id}-${i}`} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-muted-foreground">→</span>}
          <span
            className={`bg-muted inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs ${
              (h.dropped ?? 0) > 0 ? "ring-1 ring-red-400" : ""
            }`}
            title={i === 0 ? "起點:目前自身可見工具數" : "此跳交集後可用工具數(−交集移除數)"}
          >
            {h.name}
            {h.exposed !== null && (
              <span className="text-muted-foreground">
                ({h.exposed} tools{h.dropped !== null && h.dropped > 0 ? `, −${h.dropped}` : ""})
              </span>
            )}
          </span>
        </span>
      ))}
    </span>
  );
}

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
