"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, employees } from "@/db/schema";
import { requireAdmin } from "@/lib/authz";
import type { Policy } from "@/lib/mcp-audit";
import {
  canManageScope,
  createServer,
  deleteServer,
  getServer,
  setServerEnabled,
  setToolPolicy,
  type Scope,
} from "@/lib/mcp-store";
import { auditServer, installFromRepo } from "@/lib/mcp-runtime";

export type McpFormState = { error?: string; ok?: boolean; serverId?: string };

async function actorDept(employeeId: string): Promise<string | null> {
  const [e] = await db
    .select({ departmentId: employees.departmentId })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);
  return e?.departmentId ?? null;
}

// "Key: value" lines → record.
function parsePairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// Register a server, then immediately connect + audit it. The server is created
// DISABLED — the admin reviews the report and confirms before it goes live.
export async function createMcpServerAction(
  _prev: McpFormState,
  form: FormData,
): Promise<McpFormState> {
  const user = await requireAdmin();
  const scope = String(form.get("scope") ?? "org") as Scope;
  if (!canManageScope(scope, user.role)) {
    return { error: "你的角色不能在這個範圍安裝 MCP" };
  }
  const transport = String(form.get("transport") ?? "http") as "stdio" | "http";
  const name = String(form.get("name") ?? "").trim();
  const departmentId = scope === "department" ? await actorDept(user.id) : null;

  const argsRaw = String(form.get("args") ?? "").trim();
  const args = argsRaw ? argsRaw.split(/\s+/) : [];
  const env = parsePairs(String(form.get("env") ?? ""));
  const headers = parsePairs(String(form.get("headers") ?? ""));

  const created = await createServer({
    name,
    scope,
    ownerId: user.id,
    departmentId,
    transport,
    url: transport === "http" ? String(form.get("url") ?? "").trim() : null,
    command: transport === "stdio" ? String(form.get("command") ?? "").trim() : null,
    args: transport === "stdio" ? args : null,
    env: Object.keys(env).length ? env : undefined,
    headers: Object.keys(headers).length ? headers : undefined,
    createdBy: user.id,
  });
  if ("error" in created) return { error: created.error };

  await db.insert(auditLog).values({
    employeeId: user.id,
    action: "mcp.server.create",
    detail: { serverId: created.id, name, scope, transport },
  });

  const res = await auditServer(created.id);
  revalidatePath("/admin/mcp");
  if (!res.ok) {
    return {
      ok: true,
      serverId: created.id,
      error: `已建立,但連線/審核失敗:${res.error}`,
    };
  }
  return { ok: true, serverId: created.id };
}

// P3: install from a pinned GitHub commit. Clones, supply-chain scans, installs
// deps with scripts off, runs inside a --network none container, then audits.
export async function installMcpFromRepoAction(
  _prev: McpFormState,
  form: FormData,
): Promise<McpFormState> {
  const user = await requireAdmin();
  const scope = String(form.get("scope") ?? "org") as Scope;
  if (!canManageScope(scope, user.role)) {
    return { error: "你的角色不能在這個範圍安裝 MCP" };
  }
  const name = String(form.get("name") ?? "").trim();
  const repoUrl = String(form.get("repoUrl") ?? "").trim();
  const commit = String(form.get("commit") ?? "").trim();
  if (!name || !repoUrl || !commit) return { error: "名稱、repo URL、commit 皆必填" };
  const departmentId = scope === "department" ? await actorDept(user.id) : null;

  const res = await installFromRepo({
    name,
    repoUrl,
    commit,
    scope,
    ownerId: user.id,
    departmentId,
    createdBy: user.id,
  });
  if (!res.ok) return { error: res.error };
  await db.insert(auditLog).values({
    employeeId: user.id,
    action: "mcp.server.install_repo",
    detail: { serverId: res.serverId, repoUrl, commit, scope },
  });
  revalidatePath("/admin/mcp");
  return { ok: true, serverId: res.serverId };
}

export async function reauditMcpServerAction(serverId: string): Promise<McpFormState> {
  await requireAdmin();
  const server = await getServer(serverId);
  if (!server) return { error: "找不到 server" };
  const res = await auditServer(serverId);
  revalidatePath("/admin/mcp");
  return res.ok ? { ok: true } : { error: res.error };
}

export async function setMcpToolPolicyAction(
  serverId: string,
  toolName: string,
  policy: Policy,
): Promise<void> {
  await requireAdmin();
  if (!["auto", "hitl", "blocked"].includes(policy)) return;
  await setToolPolicy(serverId, toolName, policy);
  revalidatePath("/admin/mcp");
}

export async function setMcpServerEnabledAction(
  serverId: string,
  enabled: boolean,
): Promise<void> {
  const user = await requireAdmin();
  await setServerEnabled(serverId, enabled);
  await db.insert(auditLog).values({
    employeeId: user.id,
    action: enabled ? "mcp.server.enable" : "mcp.server.disable",
    detail: { serverId },
  });
  revalidatePath("/admin/mcp");
}

export async function deleteMcpServerAction(serverId: string): Promise<void> {
  const user = await requireAdmin();
  await deleteServer(serverId);
  await db.insert(auditLog).values({
    employeeId: user.id,
    action: "mcp.server.delete",
    detail: { serverId },
  });
  revalidatePath("/admin/mcp");
}
