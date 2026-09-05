"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, employees, tools, toolSecrets } from "@/db/schema";
import { requireEmployee } from "@/lib/authz";
import {
  canPublishAt,
  createTool,
  putSecret,
  type ActionSpec,
} from "@/lib/tool-store";

export type ToolFormState = { error?: string; ok?: boolean };

async function actorDept(employeeId: string): Promise<string | null> {
  const [e] = await db
    .select({ departmentId: employees.departmentId })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);
  return e?.departmentId ?? null;
}

// Parse "Key: value" lines into a record.
function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// Parse params: one per line, "name" or "name*" (trailing * = required).
function parseParams(raw: string): ActionSpec["params"] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ name: l.replace(/\*$/, ""), required: l.endsWith("*") }));
}

export async function createToolAction(
  _prev: ToolFormState,
  form: FormData,
): Promise<ToolFormState> {
  const user = await requireEmployee();
  const scope = String(form.get("scope") ?? "personal") as
    | "personal"
    | "department"
    | "org";
  if (!canPublishAt(scope, user.role)) {
    return { error: "你的角色不能發佈到這個範圍" };
  }
  const kind = String(form.get("kind") ?? "skill") as "skill" | "action";
  const name = String(form.get("name") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  if (!description) return { error: "請填說明" };

  let departmentId: string | null = null;
  if (scope === "department") {
    departmentId =
      user.role === "admin"
        ? String(form.get("departmentId") ?? "") || null
        : await actorDept(user.id); // managers publish only to their own dept
    if (!departmentId) return { error: "找不到部門" };
  }

  let lang: string | null = null;
  let body: string | null = null;
  let spec: ActionSpec | null = null;
  if (kind === "skill") {
    lang = String(form.get("lang") ?? "bash") === "python" ? "python" : "bash";
    body = String(form.get("body") ?? "");
    if (!body.trim()) return { error: "請填腳本內容" };
  } else {
    const url = String(form.get("url") ?? "").trim();
    if (!url) return { error: "請填 URL" };
    spec = {
      method: String(form.get("method") ?? "POST"),
      url,
      headers: parseHeaders(String(form.get("headers") ?? "")),
      body: String(form.get("actionBody") ?? "") || undefined,
      params: parseParams(String(form.get("params") ?? "")),
      secretName: String(form.get("secretName") ?? "").trim() || undefined,
      sensitive: form.get("sensitive") === "on",
    };
  }

  const res = await createTool({
    name,
    description,
    kind,
    scope,
    ownerId: user.id,
    departmentId,
    lang,
    body,
    spec,
  });
  if ("error" in res) return { error: res.error };
  await db.insert(auditLog).values({
    employeeId: user.id,
    action: "tool.create",
    detail: { toolId: res.id, name, kind, scope },
  });
  revalidatePath("/tools");
  return { ok: true };
}

export async function deleteToolAction(id: string): Promise<ToolFormState> {
  const user = await requireEmployee();
  const [t] = await db.select().from(tools).where(eq(tools.id, id)).limit(1);
  if (!t) return { error: "找不到工具" };
  // Personal: owner only. Department/org: role must be allowed to publish there.
  const allowed =
    t.scope === "personal"
      ? t.ownerId === user.id
      : canPublishAt(t.scope, user.role);
  if (!allowed) return { error: "權限不足" };
  await db.delete(tools).where(eq(tools.id, id));
  await db.insert(auditLog).values({
    employeeId: user.id,
    action: "tool.delete",
    detail: { toolId: id, name: t.name, scope: t.scope },
  });
  revalidatePath("/tools");
  return { ok: true };
}

export async function putSecretAction(
  _prev: ToolFormState,
  form: FormData,
): Promise<ToolFormState> {
  const user = await requireEmployee();
  const scope = String(form.get("scope") ?? "department") as
    | "department"
    | "org";
  if (!canPublishAt(scope, user.role)) return { error: "權限不足" };
  const name = String(form.get("name") ?? "").trim();
  const value = String(form.get("value") ?? "");
  if (!name || !value) return { error: "請填名稱與值" };
  let departmentId: string | null = null;
  if (scope === "department") {
    departmentId =
      user.role === "admin"
        ? String(form.get("departmentId") ?? "") || null
        : await actorDept(user.id);
    if (!departmentId) return { error: "找不到部門" };
  }
  await putSecret({ scope, departmentId, name, value, createdBy: user.id });
  await db.insert(auditLog).values({
    employeeId: user.id,
    action: "tool.secret.put",
    detail: { name, scope }, // value never logged
  });
  revalidatePath("/tools");
  return { ok: true };
}

export async function deleteSecretAction(id: string): Promise<ToolFormState> {
  const user = await requireEmployee();
  const [s] = await db
    .select()
    .from(toolSecrets)
    .where(eq(toolSecrets.id, id))
    .limit(1);
  if (!s) return { error: "找不到憑證" };
  if (!canPublishAt(s.scope, user.role)) return { error: "權限不足" };
  await db.delete(toolSecrets).where(eq(toolSecrets.id, id));
  await db.insert(auditLog).values({
    employeeId: user.id,
    action: "tool.secret.delete",
    detail: { name: s.name, scope: s.scope },
  });
  revalidatePath("/tools");
  return { ok: true };
}
