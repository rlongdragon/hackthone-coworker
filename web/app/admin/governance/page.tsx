import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/authz";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  auditPermissionGraph,
  delegationScoreboard,
  listDelegations,
  listFindings,
  principalGraph,
  resolveDelegationChains,
} from "@/lib/red-team";
import { pepEnforced } from "@/lib/tool-store";
import {
  DelegationChain,
  FindingActions,
  LeakScoreboard,
  RunRedTeamButton,
} from "./governance-client";

const sevVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  high: "destructive",
  medium: "default",
  low: "secondary",
};

export default async function GovernancePage() {
  await requireAdmin();
  const [delegations, findings, graph, scoreboard, principals] = await Promise.all([
    listDelegations(100),
    listFindings(100),
    auditPermissionGraph(),
    delegationScoreboard(),
    principalGraph(),
  ]);
  const chains = await resolveDelegationChains(delegations);

  return (
    <main className="mx-auto w-full max-w-5xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/admin"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> 管理後台
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">治理 · 自我紅隊</h1>
        <Badge variant={pepEnforced() ? "default" : "destructive"} className="ml-auto">
          PEP {pepEnforced() ? "強制中" : "關閉(framework-default)"}
        </Badge>
      </div>

      <p className="text-muted-foreground mb-4 text-sm">
        依公司 RBAC 推導權限、在<strong>模型之外</strong>的工具邊界強制跨代理資訊流控制;一支紅隊代理持續攻擊自家在線代理,
        藍隊自動收緊(隔離中毒記憶、封鎖高風險工具)。宣稱僅限:org-RBAC 推導且<em>被強制</em>的跨代理資訊流 +
        活體社會 + 閉環自我紅隊之「組合」;延伸 AgentLeak / SoK(2512.06914)/ CaMeL(2503.18813)/ AgentPoison,非發明。
      </p>

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <LeakScoreboard
          crossScopeRequests={scoreboard.crossScopeRequests}
          governedLeakRate={scoreboard.governedLeakRate}
          frameworkDefaultLeakRate={scoreboard.frameworkDefaultLeakRate}
        />
        <div className="rounded-lg border p-4">
          <div className="mb-2 text-sm font-medium">自我紅隊</div>
          <div className="text-muted-foreground mb-3 text-xs">
            共 {findings.length} 筆發現 · 偵測到{" "}
            {findings.filter((f) => f.status === "detected").length} 項 · 已隔離記憶{" "}
            {findings.filter((f) => f.memoryIsolated).length} 列
          </div>
          <RunRedTeamButton />
        </div>
      </div>

      <Tabs defaultValue="delegations">
        <TabsList>
          <TabsTrigger value="delegations">委派紀錄</TabsTrigger>
          <TabsTrigger value="redteam">紅隊發現</TabsTrigger>
          <TabsTrigger value="graph">權限圖</TabsTrigger>
        </TabsList>

        {/* who asked whom, under what effective scope, what the intersection dropped */}
        <TabsContent value="delegations" className="mt-4">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2">時間</th>
                  <th className="p-2">委派鏈(每跳可用工具數,−交集移除)</th>
                  <th className="p-2">跨部門</th>
                  <th className="p-2">有效角色</th>
                  <th className="p-2">可用工具</th>
                  <th className="p-2">被交集移除</th>
                </tr>
              </thead>
              <tbody>
                {delegations.length === 0 && (
                  <tr>
                    <td className="text-muted-foreground p-3" colSpan={6}>
                      尚無委派紀錄。
                    </td>
                  </tr>
                )}
                {delegations.map((d) => (
                  <tr key={d.id} className="border-t align-top">
                    <td className="text-muted-foreground p-2 whitespace-nowrap">
                      {new Date(d.createdAt).toLocaleString("zh-TW")}
                    </td>
                    <td className="p-2">
                      {chains[d.id]?.length ? (
                        <DelegationChain hops={chains[d.id]} />
                      ) : (
                        <>
                          {d.detail?.callerName ?? "?"} → {d.detail?.calleeName ?? "?"}
                        </>
                      )}
                    </td>
                    <td className="p-2">{d.detail?.crossDept ? "是" : "—"}</td>
                    <td className="p-2">{d.detail?.effectiveRole ?? "—"}</td>
                    <td className="p-2">{(d.detail?.exposedTools ?? []).join("、") || "—"}</td>
                    <td className="p-2">
                      {(d.detail?.droppedTools ?? []).length ? (
                        <span className="text-red-600">
                          {(d.detail?.droppedTools ?? []).join("、")}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="redteam" className="mt-4">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2">時間</th>
                  <th className="p-2">攻擊</th>
                  <th className="p-2">對象</th>
                  <th className="p-2">嚴重度</th>
                  <th className="p-2">結果</th>
                  <th className="p-2">處置</th>
                  <th className="p-2">說明</th>
                  <th className="p-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {findings.length === 0 && (
                  <tr>
                    <td className="text-muted-foreground p-3" colSpan={8}>
                      尚無紅隊發現 — 按「立即執行紅隊」開跑。
                    </td>
                  </tr>
                )}
                {findings.map((f) => (
                  <tr key={f.id} className="border-t align-top">
                    <td className="text-muted-foreground p-2 whitespace-nowrap">
                      {new Date(f.createdAt).toLocaleString("zh-TW")}
                    </td>
                    <td className="p-2 font-mono text-xs">{f.template}</td>
                    <td className="p-2">{f.targetName ?? "org"}</td>
                    <td className="p-2">
                      <Badge variant={sevVariant[f.severity] ?? "secondary"}>{f.severity}</Badge>
                    </td>
                    <td className="p-2">
                      <Badge variant={f.status === "detected" ? "destructive" : "secondary"}>
                        {f.status}
                      </Badge>
                    </td>
                    <td className="p-2 text-xs">
                      {f.actionTaken}
                      {f.memoryIsolated ? " · 已隔離" : ""}
                    </td>
                    <td className="text-muted-foreground p-2">{f.summary}</td>
                    <td className="p-2">
                      <FindingActions
                        id={f.id}
                        template={f.template}
                        status={f.status}
                        actionTaken={f.actionTaken}
                        hasTarget={!!f.targetId}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="graph" className="mt-4 space-y-4">
          {graph.findings.length > 0 && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 dark:bg-red-950/20">
              <div className="mb-1 text-sm font-medium text-red-700 dark:text-red-400">
                過度授權 {graph.findings.length} 項
              </div>
              <ul className="text-sm">
                {graph.findings.map((g, i) => (
                  <li key={i}>
                    {g.employeeName}（{g.role}）→ <span className="font-mono">{g.toolName}</span>（
                    {g.scope}):{g.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2">代理(員工)</th>
                  <th className="p-2">角色</th>
                  <th className="p-2">權限授予(scope grants)</th>
                </tr>
              </thead>
              <tbody>
                {principals.map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="p-2">{p.name}</td>
                    <td className="p-2">{p.role}</td>
                    <td className="p-2 font-mono text-xs">{p.grants.join("  ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </main>
  );
}
