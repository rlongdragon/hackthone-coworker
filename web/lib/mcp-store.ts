import { and, eq, or } from "drizzle-orm";
import { db } from "@/db";
import { departments, employees, mcpServers, mcpTools } from "@/db/schema";
import { getSecret, putSecret } from "@/lib/tool-store";
import {
  type McpConnectSpec,
  type McpToolDef,
  toolSurfaceHash,
} from "@/lib/mcp-client";
import type { Policy, ServerAudit } from "@/lib/mcp-audit";

export type McpServerRow = typeof mcpServers.$inferSelect;
export type McpToolRow = typeof mcpTools.$inferSelect;
export type Scope = "personal" | "department" | "org";

async function departmentOf(employeeId: string): Promise<string | null> {
  const [e] = await db
    .select({ departmentId: employees.departmentId })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);
  return e?.departmentId ?? null;
}

// Same visibility model as the tool library: own personal + department (if a
// member) + org-wide. Returns servers in any enabled state (admin display);
// the agent path filters enabled itself.
export async function listVisibleServers(employeeId: string): Promise<McpServerRow[]> {
  const deptId = await departmentOf(employeeId);
  const clauses = [
    and(eq(mcpServers.scope, "personal"), eq(mcpServers.ownerId, employeeId)),
    eq(mcpServers.scope, "org"),
    deptId
      ? and(eq(mcpServers.scope, "department"), eq(mcpServers.departmentId, deptId))
      : undefined,
  ].filter(Boolean);
  return db.select().from(mcpServers).where(or(...clauses));
}

export async function getServer(id: string): Promise<McpServerRow | null> {
  const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
  return row ?? null;
}

export async function getVisibleServer(
  employeeId: string,
  id: string,
): Promise<McpServerRow | null> {
  const visible = await listVisibleServers(employeeId);
  return visible.find((s) => s.id === id) ?? null;
}

export function canManageScope(scope: string, role: string): boolean {
  if (scope === "personal") return true;
  if (scope === "department") return role === "manager" || role === "admin";
  if (scope === "org") return role === "admin";
  return false;
}

export type CreateServerInput = {
  name: string;
  scope: Scope;
  ownerId: string;
  departmentId?: string | null;
  transport: "stdio" | "http";
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
  source?: "manual" | "repo";
  repoUrl?: string | null;
  repoCommit?: string | null;
  // secrets: stdio env vars and/or http headers, stored encrypted, never on the row
  env?: Record<string, string>;
  headers?: Record<string, string>;
  createdBy: string;
};

export async function createServer(
  input: CreateServerInput,
): Promise<{ id: string } | { error: string }> {
  if (!input.name.trim()) return { error: "name required" };
  if (input.scope === "department" && !input.departmentId) {
    return { error: "department scope needs a departmentId" };
  }
  if (input.transport === "http" && !input.url) return { error: "http transport needs url" };
  if (input.transport === "stdio" && !input.command) {
    return { error: "stdio transport needs command" };
  }
  const [row] = await db
    .insert(mcpServers)
    .values({
      name: input.name.trim(),
      scope: input.scope,
      ownerId: input.ownerId,
      departmentId: input.departmentId ?? null,
      transport: input.transport,
      url: input.url ?? null,
      command: input.command ?? null,
      args: input.args ?? null,
      source: input.source ?? "manual",
      repoUrl: input.repoUrl ?? null,
      repoCommit: input.repoCommit ?? null,
      enabled: false,
      createdBy: input.createdBy,
    })
    .returning({ id: mcpServers.id });

  if (input.env || input.headers) {
    await putSecret({
      scope: input.scope,
      departmentId: input.departmentId ?? null,
      name: `mcp/${row.id}`,
      value: JSON.stringify({ env: input.env ?? {}, headers: input.headers ?? {} }),
      createdBy: input.createdBy,
    });
  }
  return { id: row.id };
}

export async function deleteServer(id: string): Promise<void> {
  await db.delete(mcpServers).where(eq(mcpServers.id, id));
}

export async function setServerEnabled(id: string, enabled: boolean): Promise<void> {
  await db
    .update(mcpServers)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(mcpServers.id, id));
}

// Resolve a server row + its encrypted secrets into a concrete connect spec.
export async function buildConnectSpec(server: McpServerRow): Promise<McpConnectSpec> {
  let env: Record<string, string> = {};
  let headers: Record<string, string> = {};
  const raw = await getSecret(server.scope, server.departmentId, `mcp/${server.id}`);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as {
        env?: Record<string, string>;
        headers?: Record<string, string>;
      };
      env = parsed.env ?? {};
      headers = parsed.headers ?? {};
    } catch {
      // corrupt secret blob — connect without it
    }
  }
  if (server.transport === "http") {
    return { transport: "http", url: server.url ?? "", headers };
  }
  return {
    transport: "stdio",
    command: server.command ?? "",
    args: server.args ?? [],
    env,
  };
}

// Persist an audit result: store the report on the server row and upsert each
// tool with its suggested policy + rug-pull hash pin.
export async function saveAuditAndTools(
  serverId: string,
  audit: ServerAudit,
  toolDefs: McpToolDef[],
): Promise<void> {
  await db
    .update(mcpServers)
    .set({ auditReport: audit, lastAuditAt: new Date(), updatedAt: new Date() })
    .where(eq(mcpServers.id, serverId));

  const byName = new Map(audit.tools.map((t) => [t.name, t]));
  const seen = new Set<string>();
  for (const def of toolDefs) {
    // A tool NAME is server-supplied and flows into the agent's ToolSet key and
    // the untrusted-output wrapper. Reject anything but a safe identifier so it
    // can't break out of either — a hostile name is dropped, not stored.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(def.name)) continue;
    const a = byName.get(def.name);
    const hash = toolSurfaceHash(def.description, def.inputSchema);
    seen.add(def.name);
    await db
      .insert(mcpTools)
      .values({
        serverId,
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
        policy: a?.policy ?? "hitl",
        risk: a?.risk ?? "medium",
        flags: a?.flags ?? [],
        descHash: hash,
        enabled: true,
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [mcpTools.serverId, mcpTools.name],
        set: {
          description: def.description,
          inputSchema: def.inputSchema,
          policy: a?.policy ?? "hitl",
          risk: a?.risk ?? "medium",
          flags: a?.flags ?? [],
          descHash: hash,
          // Re-audit is an admin-initiated re-confirmation, so it re-enables a
          // tool that a prior rug-pull/vanish auto-disabled (the new hash is the
          // freshly approved surface). This is the recovery path.
          enabled: true,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        },
      });
  }
  // Tools that vanished from the server: disable, don't delete (keep history).
  const existing = await db
    .select()
    .from(mcpTools)
    .where(eq(mcpTools.serverId, serverId));
  for (const row of existing) {
    if (!seen.has(row.name) && row.enabled) {
      await db
        .update(mcpTools)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(mcpTools.id, row.id));
    }
  }
}

export async function getServerTools(serverId: string): Promise<McpToolRow[]> {
  return db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId));
}

export async function setToolPolicy(
  serverId: string,
  toolName: string,
  policy: Policy,
): Promise<void> {
  await db
    .update(mcpTools)
    .set({ policy, updatedAt: new Date() })
    .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)));
}

export async function recordHealth(serverId: string, ok: boolean): Promise<void> {
  if (ok) {
    await db
      .update(mcpServers)
      .set({ healthStatus: "ok", lastCheckAt: new Date(), failCount: 0 })
      .where(eq(mcpServers.id, serverId));
    return;
  }
  const server = await getServer(serverId);
  const fails = (server?.failCount ?? 0) + 1;
  // Circuit breaker: auto-disable after repeated failures so a dead/slow server
  // never keeps dragging the agent turn down.
  const trip = fails >= 3;
  await db
    .update(mcpServers)
    .set({
      healthStatus: "down",
      lastCheckAt: new Date(),
      failCount: fails,
      ...(trip ? { enabled: false } : {}),
    })
    .where(eq(mcpServers.id, serverId));
}

export type AgentMcpTool = {
  serverId: string;
  serverName: string;
  toolName: string;
  qualifiedName: string; // mcp__<server>__<tool>
  description: string;
  inputSchema: unknown;
  policy: Policy;
  descHash: string;
  spec: McpConnectSpec;
};

// Everything the agent may draw from MCP this turn: enabled+visible servers,
// their enabled, non-blocked tools, with the connect spec resolved. Sorted so
// name-collisions across servers are deterministic.
export async function activeAgentTools(employeeId: string): Promise<AgentMcpTool[]> {
  const servers = (await listVisibleServers(employeeId)).filter((s) => s.enabled);
  const out: AgentMcpTool[] = [];
  for (const s of servers) {
    const [tools, spec] = await Promise.all([
      getServerTools(s.id),
      buildConnectSpec(s),
    ]);
    for (const t of tools) {
      if (!t.enabled || t.policy === "blocked") continue;
      out.push({
        serverId: s.id,
        serverName: s.name,
        toolName: t.name,
        // Include a server-id fragment so two servers whose names slug to the
        // same value can't shadow each other's tools in the ToolSet.
        qualifiedName: `mcp_${slug(s.name)}_${s.id.slice(0, 8)}__${t.name}`,
        description: t.description,
        inputSchema: t.inputSchema,
        policy: t.policy,
        descHash: t.descHash,
        spec,
      });
    }
  }
  return out;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "srv";
}
