"use client";

import { useState } from "react";
import { Inbox, Loader2, Mail, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Account = { fromAddress: string; username: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; lastSyncAt: string | null; disabled: boolean } | null;
type Item = { id: string; subject: string; from: string; snippet: string; decisions: string[]; tasks: { title: string }[]; createdAt: string };

export function MailClient({ initialAccount, initialInbox }: { initialAccount: Account; initialInbox: Item[] }) {
  const [account, setAccount] = useState<Account>(initialAccount);
  const [inbox, setInbox] = useState<Item[]>(initialInbox);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // connect form
  const [f, setF] = useState({ fromAddress: "", username: "", password: "", imapHost: "", imapPort: "993", imapSecure: true, smtpHost: "", smtpPort: "587", smtpSecure: false });
  // compose
  const [c, setC] = useState({ to: "", subject: "", text: "" });
  const [pending, setPending] = useState<{ id: string; to: string; subject: string } | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  async function call(body: Record<string, unknown>) {
    const res = await fetch("/api/me/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? "失敗");
    return data;
  }
  async function reload() {
    const res = await fetch("/api/me/mail");
    if (res.ok) {
      const d = await res.json();
      setAccount(d.account);
      setInbox(d.inbox);
    }
  }
  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key); setErr(null); setNotice(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : "失敗"); } finally { setBusy(null); }
  }

  return (
    <div className="space-y-4">
      {!account && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Mail className="size-4" /> 連接我的信箱(IMAP / SMTP 自驗)</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <p className="text-muted-foreground text-xs">用你自己的信箱帳密連接;密碼 AES-256-GCM 加密存放、不進模型。收信會存成你的<strong>私人</strong>協作事件(標不可信);<strong>寄信一律要你按確認</strong>。</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {([["fromAddress", "寄件地址"], ["username", "帳號"], ["password", "密碼"], ["imapHost", "IMAP 主機"], ["imapPort", "IMAP 埠"], ["smtpHost", "SMTP 主機"], ["smtpPort", "SMTP 埠"]] as const).map(([k, label]) => (
                <label key={k} className="text-xs">
                  {label}
                  <input
                    type={k === "password" ? "password" : "text"}
                    value={f[k] as string}
                    onChange={(e) => setF({ ...f, [k]: e.target.value })}
                    className="bg-background mt-0.5 w-full rounded-md border px-2 py-1 text-sm"
                    aria-label={label}
                  />
                </label>
              ))}
              <label className="text-xs"><input type="checkbox" checked={f.imapSecure} onChange={(e) => setF({ ...f, imapSecure: e.target.checked })} /> IMAP TLS</label>
              <label className="text-xs"><input type="checkbox" checked={f.smtpSecure} onChange={(e) => setF({ ...f, smtpSecure: e.target.checked })} /> SMTP TLS(465)</label>
            </div>
            <Button size="sm" disabled={busy === "connect"} data-testid="mail-connect" onClick={() => run("connect", async () => {
              await call({ op: "connect", ...f, imapPort: Number(f.imapPort), smtpPort: Number(f.smtpPort) });
              await reload();
              setNotice("信箱已連接(IMAP 登入驗證通過)。");
            })}>
              {busy === "connect" ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />} 驗證並連接
            </Button>
          </CardContent>
        </Card>
      )}

      {account && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Inbox className="size-4" /> 收件匣 · {account.fromAddress}
                <Badge variant="secondary">private</Badge>
                <div className="ml-auto flex gap-1">
                  <Button size="sm" variant="outline" disabled={busy === "sync"} data-testid="mail-sync" onClick={() => run("sync", async () => {
                    const r = await call({ op: "sync" });
                    await reload();
                    setNotice(`收信完成:新增 ${r.fetched} 封(已抽取決議/行動項目)。`);
                  })}>
                    {busy === "sync" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} 收信
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run("disconnect", async () => { await call({ op: "disconnect" }); await reload(); })}>中斷</Button>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {inbox.length === 0 ? <p className="text-muted-foreground text-sm">還沒有收到信,按「收信」。</p> : (
                <ul className="space-y-2" data-testid="mail-inbox">
                  {inbox.map((m) => (
                    <li key={m.id} className="rounded border p-2 text-sm">
                      <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{m.subject}</span><span className="text-muted-foreground text-xs">{m.from}</span><Badge variant="outline">不可信來源</Badge></div>
                      <p className="text-muted-foreground mt-1 text-xs whitespace-pre-wrap">{m.snippet}</p>
                      {(m.decisions.length > 0 || m.tasks.length > 0) && (
                        <p className="mt-1 text-xs">抽取:{m.decisions.length} 決議 · {m.tasks.length} 行動項目(需確認)</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Send className="size-4" /> 寫信(寄出前必須你確認)</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <input value={c.to} onChange={(e) => setC({ ...c, to: e.target.value })} placeholder="收件人" aria-label="收件人" className="bg-background w-full rounded-md border px-2 py-1 text-sm" />
              <input value={c.subject} onChange={(e) => setC({ ...c, subject: e.target.value })} placeholder="主旨" aria-label="主旨" className="bg-background w-full rounded-md border px-2 py-1 text-sm" />
              <textarea value={c.text} onChange={(e) => setC({ ...c, text: e.target.value })} placeholder="內容" aria-label="內容" className="bg-background min-h-20 w-full rounded-md border px-2 py-1 text-sm" />
              {!pending ? (
                <Button size="sm" disabled={busy === "compose" || !c.to || !c.subject} data-testid="mail-compose" onClick={() => run("compose", async () => {
                  const r = await call({ op: "compose", ...c });
                  setPending({ id: r.approvalId, to: c.to, subject: c.subject });
                  setSent(null);
                  setNotice("已送審:請按「確認寄出」才會真的寄出(HITL)。");
                })}>
                  {busy === "compose" ? <Loader2 className="size-3.5 animate-spin" /> : null} 送審
                </Button>
              ) : (
                <div className="flex items-center gap-2 rounded border p-2 text-sm">
                  <span>待確認:寄給 <b>{pending.to}</b>「{pending.subject}」</span>
                  <Button size="sm" data-testid="mail-approve" disabled={busy === "approve"} onClick={() => run("approve", async () => {
                    const res = await fetch(`/api/approvals/${pending.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }) });
                    const d = await res.json().catch(() => null);
                    if (!res.ok || !d?.ok) throw new Error(d?.message ?? "寄出失敗");
                    setSent(d.message);
                    setPending(null);
                    setC({ to: "", subject: "", text: "" });
                  })}>確認寄出</Button>
                  <Button size="sm" variant="ghost" onClick={() => run("reject", async () => {
                    await fetch(`/api/approvals/${pending.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "reject" }) });
                    setPending(null);
                    setNotice("已取消,未寄出。");
                  })}>取消</Button>
                </div>
              )}
              {sent && <p className="text-sm text-emerald-700" data-testid="mail-sent">✅ {sent}</p>}
            </CardContent>
          </Card>
        </>
      )}
      {notice && <p className="text-sm text-emerald-700" data-testid="mail-notice">{notice}</p>}
      {err && <p className="text-destructive text-sm" data-testid="mail-error">{err}</p>}
    </div>
  );
}
