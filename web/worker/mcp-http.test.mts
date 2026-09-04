// E2E test for the HTTP (Streamable) import path: stand up a real http MCP
// server, connect over StreamableHTTP, audit, register, enable, run a tool.
// Run: npx tsx --env-file=.env.local worker/mcp-http.test.mts
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { employees, mcpServers } from "../db/schema";
import { listMcpTools, openMcp } from "../lib/mcp-client";
import { auditMcpTools } from "../lib/mcp-audit";
import {
  activeAgentTools,
  createServer,
  deleteServer,
  getServerTools,
  setServerEnabled,
} from "../lib/mcp-store";
import { auditServer, testServer } from "../lib/mcp-runtime";
import { resolveAgentTool, runMcpToolGuarded } from "../lib/mcp-exec";

const check = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) process.exitCode = 1;
};

const [admin] = await db
  .select({ id: employees.id })
  .from(employees)
  .where(eq(employees.email, "admin@coworker.local"));
if (!admin) throw new Error("admin missing");

const PORT = 39557;
const URL = `http://127.0.0.1:${PORT}/mcp`;

// ---- start the http MCP server ---------------------------------------------
const child = spawn("npx", ["tsx", "worker/mcp-http-test-server.mts"], {
  env: { ...process.env, MCP_HTTP_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.env.MCP_DEBUG && console.error("server:", String(d)));
// Readiness = an actual successful MCP connection (more reliable than scraping
// the child's stdout, which can buffer).
let up = false;
for (let i = 0; i < 150 && !up; i++) {
  try {
    const probe = await openMcp({ transport: "http", url: URL });
    await probe.close();
    up = true;
  } catch {
    await sleep(200);
  }
}
check("http server up", up);

let serverId = "";
try {
  // ---- 1. raw connect + list over http -------------------------------------
  {
    const s = await openMcp({ transport: "http", url: URL });
    const tools = await listMcpTools(s.client);
    await s.close();
    check("http connect+list finds 2 tools", tools.length === 2, tools.map((t) => t.name));
    check("http_echo present", tools.some((t) => t.name === "http_echo"));

    const audit = await auditMcpTools(tools);
    const byName = new Map(audit.tools.map((t) => [t.name, t]));
    // Transport test: assert only verdict-INDEPENDENT invariants. The exact
    // auto-vs-hitl call for http_echo is the LLM auditor's (nondeterministic and
    // covered in mcp.test); here we only require it produced a usable, non-blocked
    // classification. create_ticket has NO readOnlyHint → deterministic floor
    // guarantees it is never auto, regardless of the LLM.
    check("http_echo classified (not blocked)", byName.get("http_echo")?.policy !== "blocked", byName.get("http_echo"));
    check("create_ticket → not auto (deterministic)", byName.get("create_ticket")?.policy !== "auto", byName.get("create_ticket"));
  }

  // ---- 2. register (http) → audit → persist --------------------------------
  {
    const created = await createServer({
      name: "http test mcp",
      scope: "personal",
      ownerId: admin.id,
      transport: "http",
      url: URL,
      createdBy: admin.id,
    });
    check("createServer(http) ok", "id" in created, created);
    if (!("id" in created)) throw new Error("createServer failed");
    serverId = created.id;

    const res = await auditServer(serverId);
    check("auditServer(http) ok", res.ok, res);
    const rows = await getServerTools(serverId);
    check("2 http tools persisted", rows.length === 2, rows.map((r) => r.name));
    check("http tools pinned with descHash", rows.every((r) => !!r.descHash), rows.map((r) => r.descHash));

    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    check("health ok after audit", row.healthStatus === "ok", row.healthStatus);
  }

  // ---- 3. enable → agent visibility → run over http ------------------------
  {
    await setServerEnabled(serverId, true);
    const active = await activeAgentTools(admin.id);
    const names = active.filter((t) => t.serverId === serverId).map((t) => t.toolName);
    check("enabled http server exposes http_echo", names.includes("http_echo"), names);

    const t = await resolveAgentTool(admin.id, serverId, "http_echo");
    check("resolve http_echo", !!t);
    if (t) {
      const r = await runMcpToolGuarded(t, { text: "ping" });
      check("http tool runs ok", r.ok, r.text);
      check("http output framed + correct", r.text.includes("http-echo: ping") && r.text.includes("<mcp-result"), r.text);
    }
  }

  // ---- 4. testServer over http records health ------------------------------
  {
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    const listed = await testServer(row);
    check("testServer(http) lists tools", listed.ok && listed.tools.length === 2, listed);
  }
} finally {
  if (serverId) await deleteServer(serverId);
  child.kill("SIGKILL");
}

console.log("mcp-http.test done");
process.exit(process.exitCode ?? 0);
