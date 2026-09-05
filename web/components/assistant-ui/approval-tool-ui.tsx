"use client";

import { useEffect, useState } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { CheckCircle2, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type ApprovalResult = {
  needsApproval?: boolean;
  approvalId?: string;
  summary?: string;
  expiresAt?: string;
};

type Outcome = { ok: boolean; message: string } | null;

function ApprovalCard({ result }: { result: ApprovalResult | undefined }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [checking, setChecking] = useState(true);

  // History reload: local state is gone but the DB knows whether this action
  // was already resolved — never show live buttons for a settled action.
  const approvalId = result?.approvalId;
  useEffect(() => {
    if (!approvalId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/approvals/${approvalId}`);
        if (!res.ok) return; // leave buttons; POST will surface the truth
        const data = await res.json();
        if (cancelled || data.status === "pending") return;
        const map: Record<string, Outcome> = {
          approved: (data.result as Outcome) ?? { ok: true, message: "已執行" },
          failed: (data.result as Outcome) ?? { ok: false, message: "執行失敗" },
          rejected: { ok: false, message: "已拒絕,未執行任何變更" },
          expired: { ok: false, message: "已過期,請重新請 AI 發起" },
          executing: { ok: false, message: "處理中…請稍後重新整理" },
        };
        setOutcome(map[data.status] ?? { ok: false, message: "已處理過" });
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [approvalId]);

  if (!result?.needsApproval || !result.approvalId) return null;

  async function decide(decision: "approve" | "reject") {
    if (busy || outcome) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/approvals/${result!.approvalId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (res.status === 401) {
        setOutcome({ ok: false, message: "登入已過期,請重新登入後再試" });
        return;
      }
      if (!res.ok) {
        setOutcome({ ok: false, message: `伺服器拒絕(${res.status}),請再試一次` });
        return;
      }
      const data = await res.json().catch(() => null);
      setOutcome(data ?? { ok: false, message: "伺服器錯誤,請再試一次" });
    } catch {
      setOutcome({ ok: false, message: "連線失敗,請再試一次" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="my-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
      <p className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-200">
        <ShieldAlert className="size-4" /> 需要你的確認
      </p>
      <p className="mt-1">{result.summary}</p>
      {outcome ? (
        <p
          className={`mt-2 flex items-center gap-1.5 font-medium ${
            outcome.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"
          }`}
        >
          {outcome.ok ? (
            <CheckCircle2 className="size-4" />
          ) : (
            <XCircle className="size-4" />
          )}
          {outcome.message}
        </p>
      ) : checking ? (
        <p className="text-muted-foreground mt-2 flex items-center gap-1.5 text-sm">
          <Loader2 className="size-3.5 animate-spin" /> 檢查狀態…
        </p>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => decide("approve")}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : "確認執行"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => decide("reject")}
          >
            拒絕
          </Button>
        </div>
      )}
      <p className="text-muted-foreground mt-2 text-xs">
        執行時會以你目前的登入身份重新驗證權限,並記入審計日誌。
      </p>
    </div>
  );
}

export const AssignDepartmentToolUI = makeAssistantToolUI<
  Record<string, unknown>,
  ApprovalResult
>({
  toolName: "assignDepartment",
  display: "standalone", // render outside the collapsed tool group
  render: ({ result }) => <ApprovalCard result={result} />,
});

export const SetEmployeeRoleToolUI = makeAssistantToolUI<
  Record<string, unknown>,
  ApprovalResult
>({
  toolName: "setEmployeeRole",
  display: "standalone", // render outside the collapsed tool group
  render: ({ result }) => <ApprovalCard result={result} />,
});
