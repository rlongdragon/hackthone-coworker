import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/authz";
import { db } from "@/db";
import { departments } from "@/db/schema";
import { listVisibleServers, getServerTools } from "@/lib/mcp-store";
import type { ServerAudit } from "@/lib/mcp-audit";
import { McpClient, type McpServerView } from "./mcp-client";

export default async function McpAdminPage() {
  const user = await requireAdmin();

  const [servers, depts] = await Promise.all([
    listVisibleServers(user.id),
    db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .orderBy(asc(departments.name)),
  ]);

  const views: McpServerView[] = await Promise.all(
    servers
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(async (s) => {
        const tools = await getServerTools(s.id);
        const report = s.auditReport as (ServerAudit & {
          supplyChain?: { severity: string; label: string }[];
        }) | null;
        return {
          id: s.id,
          name: s.name,
          scope: s.scope,
          transport: s.transport,
          endpoint: s.transport === "http" ? (s.url ?? "") : `${s.command ?? ""} ${(s.args ?? []).join(" ")}`.trim(),
          source: s.source,
          repoUrl: s.repoUrl,
          repoCommit: s.repoCommit,
          enabled: s.enabled,
          healthStatus: s.healthStatus,
          lastAuditAt: s.lastAuditAt ? s.lastAuditAt.toISOString() : null,
          auditSummary: report?.summary ?? null,
          overallRisk: report?.overallRisk ?? null,
          supplyChain: report?.supplyChain ?? [],
          tools: tools
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => ({
              name: t.name,
              description: t.description,
              policy: t.policy,
              risk: t.risk,
              flags: (t.flags as string[] | null) ?? [],
              enabled: t.enabled,
            })),
        };
      }),
  );

  return (
    <main className="w-full mx-auto max-w-5xl p-6">
      <div className="mb-2 flex items-center gap-3">
        <Link
          href="/admin"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> 後台
        </Link>
      </div>
      <h1 className="text-2xl font-semibold">MCP 外部工具</h1>
      <p className="text-muted-foreground mt-1 mb-6 text-sm">
        接入外部 MCP server。新增後自動連線 + 投毒審核,逐工具設定「自動 / 需審批 / 封鎖」,確認後才啟用。
        描述在核准後被變更會自動停用該工具(rug-pull 防護)。
      </p>
      <McpClient
        servers={views}
        departments={depts}
        canDept={user.role === "manager" || user.role === "admin"}
      />
    </main>
  );
}
