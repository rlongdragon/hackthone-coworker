import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { departments, employees, tools, toolSecrets } from "@/db/schema";

// ---- types ------------------------------------------------------------------

export type ActionParam = { name: string; required?: boolean; description?: string };
export type ActionSpec = {
  method: string;
  url: string; // may contain {{param}} / {{secret}}
  headers?: Record<string, string>;
  body?: string;
  params?: ActionParam[];
  secretName?: string; // resolved within the tool's scope
  sensitive?: boolean; // sensitive -> HITL approval before it runs
};

export type ToolRow = typeof tools.$inferSelect;

// ---- visibility -------------------------------------------------------------

async function departmentOf(employeeId: string): Promise<string | null> {
  const [e] = await db
    .select({ departmentId: employees.departmentId })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);
  return e?.departmentId ?? null;
}

// The raw visibility set for ONE principal: their own personal tools + their
// department's + org-wide. Department tools only when they are actually in it.
async function visibleForOne(employeeId: string): Promise<ToolRow[]> {
  const deptId = await departmentOf(employeeId);
  const scopeClauses = [
    and(eq(tools.scope, "personal"), eq(tools.ownerId, employeeId)),
    eq(tools.scope, "org"),
    deptId ? and(eq(tools.scope, "department"), eq(tools.departmentId, deptId)) : undefined,
  ].filter(Boolean);
  return db
    .select()
    .from(tools)
    // Deterministic order so a by-name `.find()` (e.g. same name at two scopes)
    // is stable rather than DB-order-dependent.
    .where(and(eq(tools.enabled, true), or(...scopeClauses)))
    .orderBy(tools.scope, tools.id);
}

// Tools available for a (possibly delegated) run. `onBehalfOf` is the delegation
// chain of PRIOR principals a sub-run acts on behalf of. The effective set is
// the INTERSECTION over {employeeId, ...onBehalfOf}: a tool is usable only if
// EVERY principal in the chain could use it on their own. This is the single
// novel enforcement point — computed here at the PEP, never via the prompt — and
// it is monotonic: appending a principal can only remove tools, so a delegation
// chain can only attenuate authority, never widen it (macaroon-style caveats).
// agent-society: when PEP enforcement is toggled off (framework-default mode,
// for the contrast demo) the chain is ignored and the callee runs at full scope.
export async function listVisibleTools(
  employeeId: string,
  onBehalfOf: string[] = [],
): Promise<ToolRow[]> {
  const own = await visibleForOne(employeeId);
  if (onBehalfOf.length === 0 || !pepEnforced()) return own;
  const priorSets = await Promise.all([...new Set(onBehalfOf)].map(visibleForOne));
  const allow = priorSets.map((s) => new Set(s.map((t) => t.id)));
  return own.filter((t) => allow.every((a) => a.has(t.id)));
}

// PEP enforcement switch. Default ON, and FORCED on in production — the "off"
// (framework-default / prompt-only) mode exists only for the confused-deputy
// contrast demo, so a single misconfigured env var can never silently disable
// the whole cross-agent control on a real deployment.
export function pepEnforced(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  return process.env.AGENT_SOCIETY_ENFORCE !== "0";
}

// Resolve a tool by name *and* re-check the caller may see it — never trust the
// model to only call visible tools. `onBehalfOf` threads the delegation chain so
// a sub-run resolves under caller ∩ callee. Returns null if not visible.
export async function findVisibleTool(
  employeeId: string,
  name: string,
  kind?: "skill" | "action",
  onBehalfOf: string[] = [],
): Promise<ToolRow | null> {
  const visible = await listVisibleTools(employeeId, onBehalfOf);
  return (
    visible.find((t) => t.name === name && (!kind || t.kind === kind)) ?? null
  );
}

export async function findVisibleToolById(
  employeeId: string,
  id: string,
  onBehalfOf: string[] = [],
): Promise<ToolRow | null> {
  const visible = await listVisibleTools(employeeId, onBehalfOf);
  return visible.find((t) => t.id === id) ?? null;
}

// ---- management CRUD --------------------------------------------------------

// Who may publish at a given scope: personal=anyone(own), department=manager/admin,
// org=admin. Enforced by callers with the actor's role.
export function canPublishAt(scope: string, role: string): boolean {
  if (scope === "personal") return true;
  if (scope === "department") return role === "manager" || role === "admin";
  if (scope === "org") return role === "admin";
  return false;
}

export async function createTool(input: {
  name: string;
  description: string;
  kind: "skill" | "action";
  scope: "personal" | "department" | "org";
  ownerId: string;
  departmentId?: string | null;
  lang?: string | null;
  body?: string | null;
  spec?: ActionSpec | null;
}): Promise<{ id: string } | { error: string }> {
  if (!/^[a-z][a-z0-9_]{1,48}$/.test(input.name)) {
    return { error: "name must be snake_case (a-z0-9_), 2–49 chars" };
  }
  if (input.scope === "department" && !input.departmentId) {
    return { error: "department scope needs a departmentId" };
  }
  // Name must be unique within its visibility bucket.
  const clash = await db
    .select({ id: tools.id })
    .from(tools)
    .where(
      and(
        eq(tools.name, input.name),
        eq(tools.scope, input.scope),
        input.scope === "personal"
          ? eq(tools.ownerId, input.ownerId)
          : input.scope === "department"
            ? eq(tools.departmentId, input.departmentId!)
            : undefined,
      ),
    )
    .limit(1);
  if (clash.length) return { error: `a tool named ${input.name} already exists in this scope` };

  const [row] = await db
    .insert(tools)
    .values({
      name: input.name,
      description: input.description,
      kind: input.kind,
      scope: input.scope,
      ownerId: input.ownerId,
      departmentId: input.departmentId ?? null,
      lang: input.lang ?? null,
      body: input.body ?? null,
      spec: input.spec ?? null,
    })
    .returning({ id: tools.id });
  return { id: row.id };
}

// ---- secret encryption (AES-256-GCM) ----------------------------------------

function key(): Buffer {
  const secret = process.env.TOOL_SECRET_KEY || process.env.AUTH_SECRET;
  if (!secret) throw new Error("TOOL_SECRET_KEY or AUTH_SECRET must be set");
  return createHash("sha256").update(secret).digest(); // 32 bytes
}

export async function putSecret(input: {
  scope: "personal" | "department" | "org";
  departmentId?: string | null;
  name: string;
  value: string;
  createdBy: string;
}): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  await db.insert(toolSecrets).values({
    scope: input.scope,
    departmentId: input.departmentId ?? null,
    name: input.name,
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    createdBy: input.createdBy,
  });
}

// Decrypt a secret for an action tool. Matched by name within the tool's scope
// bucket. Returns null if missing.
export async function getSecret(
  scope: string,
  departmentId: string | null,
  name: string,
): Promise<string | null> {
  const rows = await db
    .select()
    .from(toolSecrets)
    .where(and(eq(toolSecrets.scope, scope as ToolRow["scope"]), eq(toolSecrets.name, name)));
  const row = rows.find(
    (r) => scope !== "department" || r.departmentId === departmentId,
  );
  if (!row) return null;
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(row.iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export { inArray };
