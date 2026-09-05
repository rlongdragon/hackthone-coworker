import { tool, jsonSchema, type ToolSet } from "ai";
import { db } from "@/db";
import { eq } from "drizzle-orm";
import { mcpServers } from "@/db/schema";
import { createPendingAction } from "@/lib/approval-store";
import { auditMcpTools, type ServerAudit } from "@/lib/mcp-audit";
import { listMcpTools, openMcp } from "@/lib/mcp-client";
import { runMcpToolGuarded } from "@/lib/mcp-exec";
import {
  cloneAtCommit,
  containerRunSpec,
  prepareDeps,
  supplyChainScan,
  type ScanFinding,
} from "@/lib/mcp-repo";
import {
  activeAgentTools,
  buildConnectSpec,
  createServer,
  getServer,
  recordHealth,
  saveAuditAndTools,
  type AgentMcpTool,
  type McpServerRow,
  type Scope,
} from "@/lib/mcp-store";

// Connect to a server and list its advertised tools. Records health either way.
export async function testServer(
  server: McpServerRow,
): Promise<
  | { ok: true; tools: Awaited<ReturnType<typeof listMcpTools>> }
  | { ok: false; error: string }
> {
  const spec = await buildConnectSpec(server);
  let session;
  try {
    session = await openMcp(spec);
  } catch (e) {
    await recordHealth(server.id, false);
    return { ok: false, error: `連線失敗:${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const tools = await listMcpTools(session.client);
    await recordHealth(server.id, true);
    return { ok: true, tools };
  } catch (e) {
    await recordHealth(server.id, false);
    return { ok: false, error: `列出工具失敗:${e instanceof Error ? e.message : String(e)}` };
  } finally {
    await session.close();
  }
}

// Full audit pass: connect → list → two-layer audit → persist report + pinned
// per-tool policies/hashes. Server stays disabled; the human confirms in the UI.
export async function auditServer(
  serverId: string,
): Promise<{ ok: true; audit: ServerAudit } | { ok: false; error: string }> {
  const server = await getServer(serverId);
  if (!server) return { ok: false, error: "server not found" };
  const listed = await testServer(server);
  if (!listed.ok) return listed;
  const audit = await auditMcpTools(listed.tools);
  await saveAuditAndTools(serverId, audit, listed.tools);
  return { ok: true, audit };
}

export type RepoInstallInput = {
  name: string;
  repoUrl: string;
  commit: string;
  scope: Scope;
  ownerId: string;
  departmentId?: string | null;
  createdBy: string;
};

// P3: install an MCP server from a pinned GitHub commit. Clone → supply-chain
// scan → install deps (scripts off) → register as a stdio server that runs
// inside a `--network none` container → connect + audit tools. The server is
// created DISABLED; the admin reviews scan + tool audit before enabling.
export async function installFromRepo(
  input: RepoInstallInput,
): Promise<{ ok: true; serverId: string; scan: ScanFinding[]; audit: ServerAudit } | { ok: false; error: string }> {
  const cloned = await cloneAtCommit(input.repoUrl, input.commit);
  if (!cloned.ok) return { ok: false, error: cloned.error };

  const scan = await supplyChainScan(cloned.dir);
  if (!scan.entry) {
    return { ok: false, error: "找不到 server 進入點(package.json bin/main 或 index.js)" };
  }
  const deps = await prepareDeps(cloned.dir);
  if (!deps.ok) return { ok: false, error: deps.error ?? "依賴安裝失敗" };

  const spec = containerRunSpec(cloned.dir, scan.entry);
  if (spec.transport !== "stdio") return { ok: false, error: "internal: bad spec" };

  const created = await createServer({
    name: input.name,
    scope: input.scope,
    ownerId: input.ownerId,
    departmentId: input.departmentId ?? null,
    transport: "stdio",
    command: spec.command,
    args: spec.args,
    source: "repo",
    repoUrl: input.repoUrl,
    repoCommit: input.commit,
    createdBy: input.createdBy,
  });
  if ("error" in created) return { ok: false, error: created.error };

  const res = await auditServer(created.id);
  // Merge the supply-chain findings into the stored report so the UI shows both.
  const base: ServerAudit = res.ok
    ? res.audit
    : { summary: `連線/審核失敗:${res.error}`, overallRisk: "high", tools: [] };
  const merged = { ...base, supplyChain: scan.findings };
  await db
    .update(mcpServers)
    .set({ auditReport: merged, updatedAt: new Date() })
    .where(eq(mcpServers.id, created.id));

  return { ok: true, serverId: created.id, scan: scan.findings, audit: base };
}

// Build the MCP portion of the agent's tool-set for this employee. Each tool:
//   - auto    → runs immediately (rug-pull guarded)
//   - hitl    → parks a pending action the user must approve
//   - blocked → never reaches here (filtered in activeAgentTools)
// Returns an empty set (never throws) if MCP is unavailable — must not block chat.
export async function makeMcpTools(employeeId: string): Promise<ToolSet> {
  let active: AgentMcpTool[];
  try {
    active = await activeAgentTools(employeeId);
  } catch (e) {
    console.warn("mcp activeAgentTools failed:", e instanceof Error ? e.message : e);
    return {};
  }
  const set: ToolSet = {};
  for (const t of active) {
    const schema = (t.inputSchema as object) ?? { type: "object", properties: {} };
    set[t.qualifiedName] = tool({
      description: `[MCP:${t.serverName}] ${t.description}`.slice(0, 1024),
      inputSchema: jsonSchema(schema),
      execute: async (rawArgs) => {
        const args = (rawArgs ?? {}) as Record<string, unknown>;
        if (t.policy === "hitl") {
          const p = await createPendingAction(employeeId, "mcp.tool", {
            serverId: t.serverId,
            toolName: t.toolName,
            args,
          });
          return {
            needsApproval: true,
            approvalId: p.id,
            summary: `執行 MCP 工具「${t.serverName} · ${t.toolName}」`,
            expiresAt: p.expiresAt.toISOString(),
            note: "Tell the user to press the confirm button shown in the chat.",
          };
        }
        return runMcpToolGuarded(t, args);
      },
    });
  }
  return set;
}
