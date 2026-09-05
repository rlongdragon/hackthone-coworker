import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { inArray } from "drizzle-orm";
import { requireEmployee } from "@/lib/authz";
import { db } from "@/db";
import { employees } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { listQueriesAboutMe } from "@/lib/pep";
import { getMyNotifications, unreadCount } from "@/lib/notifications";
import { MarkAllReadButton } from "./ledger-client";

const SCOPE_ZH: Record<string, string> = {
  project: "專案進度",
  team: "團隊事務",
  private: "私人資訊",
  sensitive: "敏感資訊",
};

export default async function LedgerPage() {
  const me = await requireEmployee();
  const [rows, notifs, unread] = await Promise.all([
    listQueriesAboutMe(me.id, { includeDenied: true, limit: 100 }),
    getMyNotifications(me.id, { limit: 30 }),
    unreadCount(me.id),
  ]);

  const actorIds = [...new Set(rows.map((r) => r.actorId).filter(Boolean))] as string[];
  const actors = actorIds.length
    ? await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, actorIds))
    : [];
  const nameOf = new Map(actors.map((a) => [a.id, a.name]));

  const today = rows.filter((r) => {
    const d = new Date(r.createdAt);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  });
  const allowedToday = today.filter((r) => r.allowed).length;
  const deniedToday = today.filter((r) => !r.allowed).length;

  return (
    <main className="mx-auto w-full max-w-3xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link href="/" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="size-4" /> 回聊天
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">關於我的查詢紀錄</h1>
        <div className="ml-auto flex items-center gap-2">
          {/* GDPR-style dump of the subject's OWN ledger (route is session-scoped) */}
          <a
            href="/api/me/ledger/export"
            download
            data-testid="ledger-export"
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            匯出 JSON
          </a>
          <MarkAllReadButton unread={unread} />
        </div>
      </div>

      {/* the world-first line: today, who queried me, allowed AND denied */}
      <div className="mb-6 rounded-lg border p-4">
        <div className="text-sm font-medium">今天有 {today.length} 筆關於你的查詢</div>
        <div className="mt-2 flex gap-4 text-sm">
          <span className="text-emerald-600">✅ 允許 {allowedToday}</span>
          <span className="text-red-600">⛔ 拒絕 {deniedToday}</span>
        </div>
        <p className="text-muted-foreground mt-2 text-xs">
          誰的代理查了關於你的什麼、被允許或被拒絕,你都看得到 —— 包含<strong>被拒絕</strong>的查詢。
          沒有任何現行產品或法規對職場代理揭露「被拒絕」的查詢;這是本產品的獨有能力。
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="p-2">時間</th>
              <th className="p-2">誰的代理</th>
              <th className="p-2">範圍</th>
              <th className="p-2">結果</th>
              <th className="p-2">目的</th>
              <th className="p-2">被擋欄位</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="text-muted-foreground p-3" colSpan={6}>
                  目前沒有關於你的跨代理查詢。
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t align-top">
                <td className="text-muted-foreground p-2 whitespace-nowrap">
                  {new Date(r.createdAt).toLocaleString("zh-TW")}
                </td>
                <td className="p-2">{nameOf.get(r.actorId ?? "") ?? "?"}</td>
                <td className="p-2">{SCOPE_ZH[r.scope ?? ""] ?? r.scope}</td>
                <td className="p-2">
                  <Badge variant={r.allowed ? "secondary" : "destructive"}>
                    {r.allowed ? "允許" : "拒絕"}
                  </Badge>
                </td>
                <td className="text-muted-foreground p-2">{r.purpose ?? "—"}</td>
                <td className="p-2">
                  {(r.deniedFields ?? []).length ? (
                    <span className="text-red-600">{(r.deniedFields ?? []).join("、")}</span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {notifs.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-medium">通知</h2>
          <ul className="space-y-1">
            {notifs.map((n) => (
              <li
                key={n.id}
                className={`rounded border p-2 text-sm ${n.readAt ? "text-muted-foreground" : "bg-muted/40"}`}
              >
                {n.type === "query_denied" ? "⛔" : n.type === "query_allowed" ? "✅" : "🔔"}{" "}
                {SCOPE_ZH[n.scope ?? ""] ?? n.scope} · {n.purpose ?? ""}{" "}
                <span className="text-muted-foreground text-xs">
                  {new Date(n.createdAt).toLocaleString("zh-TW")}
                  {n.readAt ? "" : " · 未讀"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
