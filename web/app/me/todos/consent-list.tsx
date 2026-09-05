"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export type ConsentItem = { id: string; kind: "dispatch" | "ask"; title: string; fromName: string; projectName: string | null; expiresAt: string };

// Cross-department dispatch OR cross-department agent query waiting for MY
// decision (I am the requester of the pending action, so only I can
// approve/reject it). Approving an `ask` runs the scoped sub-run now — the
// ledger row is written only after consent.
export function ConsentList({ items }: { items: ConsentItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  if (items.length === 0) return null;
  const decide = (id: string, decision: "approve" | "reject") =>
    start(async () => {
      const res = await fetch(`/api/approvals/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) });
      const d = await res.json().catch(() => null);
      setMsg(d?.message ?? (res.ok ? "完成" : "失敗"));
      router.refresh();
    });
  return (
    <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/20" data-testid="consent-list">
      <div className="mb-2 text-sm font-medium">跨部門請求待你同意 {items.length}</div>
      <ul className="space-y-2">
        {items.map((it) => (
          <li key={it.id} className="flex flex-wrap items-center gap-2 text-sm" data-consent-id={it.id} data-consent-kind={it.kind}>
            <span>
              <b>{it.fromName}</b> {it.kind === "ask" ? "想問你的代理:" : "想指派給你:"}「{it.title}」
              {it.projectName ? <span className="text-muted-foreground">({it.projectName})</span> : null}
            </span>
            <span className="ml-auto flex gap-1">
              <Button size="sm" disabled={pending} onClick={() => decide(it.id, "approve")} data-action="consent-approve">接受</Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => decide(it.id, "reject")} data-action="consent-reject">拒絕</Button>
            </span>
          </li>
        ))}
      </ul>
      {msg && <p className="text-muted-foreground mt-2 text-xs">{msg}</p>}
    </div>
  );
}
