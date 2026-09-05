import { NextResponse } from "next/server";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { getServer, getServerTools, setToolPolicy } from "@/lib/mcp-store";
import { asUuid } from "@/lib/validate";
import { requireAdminApi } from "../_admin";

// POST /api/admin/governance/tighten-tool  {serverId, toolName, policy}
// Manual blue-team actuator for one MCP tool: clamp it to hitl or blocked.
// Widening (→ auto) is deliberately NOT offered here — re-enabling goes through
// the MCP admin re-audit path so the rug-pull pin is refreshed.
export async function POST(req: Request) {
  const gate = await requireAdminApi();
  if (gate instanceof Response) return gate;
  const body = (await req.json().catch(() => null)) as
    | { serverId?: unknown; toolName?: unknown; policy?: unknown }
    | null;
  const serverId = asUuid(body?.serverId);
  const toolName = typeof body?.toolName === "string" ? body.toolName : "";
  const policy = body?.policy;
  if (!serverId || !/^[A-Za-z0-9_-]{1,64}$/.test(toolName)) {
    return new Response("Bad request", { status: 400 });
  }
  if (policy !== "blocked" && policy !== "hitl") {
    return new Response("policy must be 'blocked' or 'hitl'", { status: 400 });
  }
  const server = await getServer(serverId);
  if (!server) return new Response("Not found", { status: 404 });
  const tool = (await getServerTools(serverId)).find((t) => t.name === toolName);
  if (!tool) return new Response("Not found", { status: 404 });

  await setToolPolicy(serverId, toolName, policy);
  await db.insert(auditLog).values({
    employeeId: gate.id,
    action: "redteam.tighten_tool",
    detail: { serverId, toolName, from: tool.policy, to: policy },
  });
  return NextResponse.json({ ok: true, serverId, toolName, from: tool.policy, to: policy });
}
