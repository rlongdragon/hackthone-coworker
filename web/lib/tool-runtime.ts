import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { execInSandbox, writeFileInSandbox } from "@/lib/sandbox";
import {
  findVisibleTool,
  getSecret,
  type ActionSpec,
  type ToolRow,
} from "@/lib/tool-store";

const OUTPUT_CAP = 8_000;

// {{name}} substitution. In URL context values are percent-encoded; elsewhere raw.
function render(
  tpl: string,
  vars: Record<string, string>,
  opts: { urlEncode?: boolean } = {},
): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => {
    const v = vars[k] ?? "";
    return opts.urlEncode ? encodeURIComponent(v) : v;
  });
}

// Block cloud metadata + obvious loopback by hostname; private ranges are
// allowed on purpose (self-hosted internal APIs like a company Gitea).
function ssrfBlocked(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  if (h === "169.254.169.254" || h.endsWith(".metadata.internal")) return true;
  if (h === "metadata" || h === "metadata.google.internal") return true;
  return false;
}

// ---- skills (run in the employee's sandbox) --------------------------------

export async function runSkill(
  employeeId: string,
  name: string,
  args: string[],
  // agent-society: the delegation chain a sub-run acts on behalf of. Threaded
  // into resolution so a delegated skill is picked from the INTERSECTED set —
  // otherwise a callee-only name lookup could execute a personal skill the
  // caller was never allowed to invoke (scope-intersection bypass).
  onBehalfOf: string[] = [],
): Promise<{ ok: boolean; error?: string; exitCode?: number; stdout?: string; stderr?: string }> {
  const tool = await findVisibleTool(employeeId, name, "skill", onBehalfOf);
  if (!tool || !tool.body) return { ok: false, error: `skill not found or not visible: ${name}` };
  const ext = tool.lang === "python" ? "py" : "sh";
  const rel = `skills/${name}.${ext}`;
  const w = await writeFileInSandbox(employeeId, rel, tool.body);
  if (!w.ok) return { ok: false, error: w.error };
  const runner = tool.lang === "python" ? "python3" : "bash";
  // args are single-quoted to keep them one token each (no host shell involved;
  // this is the sandbox's bash).
  const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const r = await execInSandbox(employeeId, `${runner} ${rel} ${quoted}`, 120);
  await db.insert(auditLog).values({
    employeeId,
    action: "agent.tool.skill",
    detail: { name, scope: tool.scope, exitCode: r.exitCode },
  });
  return { ok: true, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

// ---- actions (server-side HTTP with a scoped secret) ------------------------

export async function executeAction(
  tool: ToolRow,
  args: Record<string, string>,
  actorId: string,
): Promise<{ ok: boolean; error?: string; status?: number; body?: string }> {
  const spec = tool.spec as ActionSpec | null;
  if (!spec?.url || !spec.method) return { ok: false, error: "invalid action spec" };
  for (const p of spec.params ?? []) {
    if (p.required && !args[p.name]) return { ok: false, error: `missing required param: ${p.name}` };
  }

  const vars: Record<string, string> = { ...args };
  if (spec.secretName) {
    const secret = await getSecret(tool.scope, tool.departmentId, spec.secretName);
    if (secret == null) return { ok: false, error: `secret not configured: ${spec.secretName}` };
    vars.secret = secret;
  }

  let url: URL;
  try {
    url = new URL(render(spec.url, vars, { urlEncode: true }));
  } catch {
    return { ok: false, error: "rendered URL is invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "only http/https allowed" };
  }
  if (ssrfBlocked(url)) return { ok: false, error: "target host blocked" };

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k] = render(v, vars);
  const body = spec.body ? render(spec.body, vars) : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      method: spec.method.toUpperCase(),
      headers,
      body: ["GET", "HEAD"].includes(spec.method.toUpperCase()) ? undefined : body,
      signal: controller.signal,
    });
    const text = (await res.text()).slice(0, OUTPUT_CAP);
    // Audit records the tool + status + rendered URL, never headers/secret/body.
    await db.insert(auditLog).values({
      employeeId: actorId,
      action: "agent.tool.action",
      detail: { name: tool.name, scope: tool.scope, url: url.origin + url.pathname, status: res.status },
    });
    return { ok: res.ok, status: res.status, body: text };
  } catch (e) {
    await db.insert(auditLog).values({
      employeeId: actorId,
      action: "agent.tool.action",
      detail: { name: tool.name, scope: tool.scope, error: "request failed" },
    });
    return { ok: false, error: `request failed: ${e instanceof Error ? e.message : "unknown"}` };
  } finally {
    clearTimeout(timer);
  }
}
