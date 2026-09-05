// E2E test for P3 repo-install: clone at pinned commit → supply-chain scan →
// deps with install-scripts DISABLED → run the server inside a `--network none`
// container → connect + list. Uses a local git repo fixture with a postinstall
// trap to prove scripts never execute.
// Run: npx tsx --env-file=.env.local worker/mcp-repo.test.mts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { employees, mcpServers, mcpTools } from "../db/schema";
import { installFromRepo, testServer } from "../lib/mcp-runtime";
import { supplyChainScan, cloneAtCommit, removeClone } from "../lib/mcp-repo";

const run = promisify(execFile);
const check = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) process.exitCode = 1;
};

const [admin] = await db
  .select({ id: employees.id })
  .from(employees)
  .where(eq(employees.email, "admin@coworker.local"));
if (!admin) throw new Error("admin missing");

const PWNED = "/tmp/COWORKER_MCP_PWNED";
await rm(PWNED, { force: true });

// ---- build a local git repo fixture ----------------------------------------
const repo = await mkdtemp(join(tmpdir(), "mcp-fixture-"));
await writeFile(
  join(repo, "package.json"),
  JSON.stringify(
    {
      name: "repo-mcp",
      version: "1.0.0",
      type: "module",
      main: "index.mjs",
      // postinstall trap: must NEVER run (install uses --ignore-scripts).
      scripts: { postinstall: `node -e "require('fs').writeFileSync('${PWNED}','x')"` },
      dependencies: { "@modelcontextprotocol/sdk": "^1.30" },
    },
    null,
    2,
  ),
);
await writeFile(
  join(repo, "index.mjs"),
  `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const s = new McpServer({ name: "repo-mcp", version: "1.0.0" });
s.registerTool("ping", { description: "Ping the server. Read-only, no side effects.", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "pong" }] }));
await s.connect(new StdioServerTransport());
`,
);
await run("git", ["-C", repo, "init", "-q"]);
await run("git", ["-C", repo, "config", "user.email", "t@t"]);
await run("git", ["-C", repo, "config", "user.name", "t"]);
await run("git", ["-C", repo, "add", "-A"]);
await run("git", ["-C", repo, "commit", "-q", "-m", "init"]);
const { stdout } = await run("git", ["-C", repo, "rev-parse", "HEAD"]);
const commit = stdout.trim();
const repoUrl = `file://${repo}`;
check("fixture commit resolved", /^[0-9a-f]{40}$/.test(commit), commit);

// ---- 1. clone at pinned commit ---------------------------------------------
{
  const bad = await cloneAtCommit(repoUrl, "not-a-hash");
  check("clone rejects non-hash commit", !bad.ok, bad);
  const good = await cloneAtCommit(repoUrl, commit);
  check("clone at commit ok", good.ok, good);
  if (good.ok) {
    const scan = await supplyChainScan(good.dir);
    check("scan flags postinstall script", scan.findings.some((f) => f.label.includes("postinstall")), scan.findings);
    check("scan resolves entry index.mjs", scan.entry === "index.mjs", scan.entry);
    await removeClone(repoUrl, commit);
  }
}

// ---- 2. full install → container-isolated connect --------------------------
let serverId = "";
{
  const res = await installFromRepo({
    name: "repo-fixture",
    repoUrl,
    commit,
    scope: "personal",
    ownerId: admin.id,
    createdBy: admin.id,
  });
  check("installFromRepo ok", res.ok, res);
  if (!res.ok) throw new Error("install failed: " + res.error);
  serverId = res.serverId;

  check(
    "postinstall trap did NOT run (--ignore-scripts)",
    !(await stat(PWNED).then(() => true).catch(() => false)),
  );
  check("supply-chain findings returned", res.scan.some((f) => f.label.includes("postinstall")), res.scan);

  const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
  check("registered as repo source", row.source === "repo", row.source);
  check("commit pinned on row", row.repoCommit === commit, row.repoCommit);
  check("runs via docker", row.command === "docker", row.command);
  check("egress denied (--network none)", (row.args as string[]).join(" ").includes("--network none"), row.args);
  check("runs under gVisor (runsc)", (row.args as string[]).includes("runsc"), row.args);

  const tools = await db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId));
  check("ping tool discovered via container", tools.some((t) => t.name === "ping"), tools.map((t) => t.name));
}

// ---- 3. testServer actually runs the container -----------------------------
{
  const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
  const listed = await testServer(row);
  check("containerized server connects + lists", listed.ok && listed.tools.some((t) => t.name === "ping"), listed);
}

// ---- cleanup ----------------------------------------------------------------
await db.delete(mcpServers).where(eq(mcpServers.id, serverId));
await removeClone(repoUrl, commit);
await rm(repo, { recursive: true, force: true });
await rm(PWNED, { force: true });
console.log("mcp-repo.test done");
process.exit(process.exitCode ?? 0);
