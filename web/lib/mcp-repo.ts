import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { McpConnectSpec } from "@/lib/mcp-client";

const run = promisify(execFile);

// P3: install an MCP server from a GitHub repo. The security posture, in order
// of what we actually rely on:
//   1. RUN isolation — the server runs inside a locked-down container with
//      `--network none` (egress deny), read-only mount, dropped caps. This is
//      the real control: a poisoned server cannot phone home or touch the host.
//   2. Pinned commit — we clone an exact commit, never a floating branch, so a
//      later force-push cannot change what was approved (source rug-pull).
//   3. Supply-chain scan — deterministic triage that raises obvious red flags
//      (install scripts, eval/child_process, secret reads). NOT a proof of
//      safety: a determined backdoor passes it. It informs the human, nothing more.
// Build (dependency install) runs with network but with install scripts
// DISABLED; the untrusted code only ever executes later, with no network.

const REPO_ROOT = process.env.MCP_REPO_DIR ?? "/tmp/coworker-mcp";
const IMAGE = process.env.SANDBOX_IMAGE ?? "coworker-sandbox:latest";
const RUNTIME = process.env.SANDBOX_RUNTIME ?? "runsc";

const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
// https for public/self-hosted git; file:// for an on-box mirror (admin-only
// action, resolves locally — no SSRF surface beyond the FS the app already has).
const REPO_URL_RE = /^(https:\/\/[\w.-]+\/[\w./-]+?(\.git)?|file:\/\/\/[\w./-]+?(\.git)?)$/;

export type ScanFinding = { severity: "high" | "medium" | "low"; label: string };
export type RepoScan = {
  findings: ScanFinding[];
  entry: string | null; // resolved server entry (relative to clone dir)
  hasLockfile: boolean;
};

function cloneDirFor(repoUrl: string, commit: string): string {
  const h = createHash("sha256").update(`${repoUrl}@${commit}`).digest("hex").slice(0, 16);
  return join(REPO_ROOT, h);
}

// Clone an exact commit with no history and no code execution (git checkout runs
// no repo code). Uses execFile with an argv array — nothing hits a host shell.
export async function cloneAtCommit(
  repoUrl: string,
  commit: string,
): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  if (!REPO_URL_RE.test(repoUrl)) return { ok: false, error: "只允許 https 或 file:// 的 repo URL" };
  // No path traversal in a file:// mirror path.
  if (repoUrl.includes("..")) return { ok: false, error: "repo URL 不得含 .." };
  if (!COMMIT_RE.test(commit)) return { ok: false, error: "必須釘死 commit hash(7–40 hex)" };
  const dir = cloneDirFor(repoUrl, commit);
  await rm(dir, { recursive: true, force: true });
  try {
    await run("git", ["init", "-q", dir], { timeout: 30_000 });
    await run("git", ["-C", dir, "remote", "add", "origin", repoUrl], { timeout: 10_000 });
    // Fetch just the pinned commit where the server allows it; fall back to a
    // shallow fetch of the default branch then checkout the commit.
    try {
      await run("git", ["-C", dir, "fetch", "--depth", "1", "-q", "origin", commit], {
        timeout: 120_000,
      });
      await run("git", ["-C", dir, "checkout", "-q", "FETCH_HEAD"], { timeout: 30_000 });
    } catch {
      await run("git", ["-C", dir, "fetch", "--depth", "50", "-q", "origin"], {
        timeout: 120_000,
      });
      await run("git", ["-C", dir, "checkout", "-q", commit], { timeout: 30_000 });
    }
    return { ok: true, dir };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    return { ok: false, error: `clone 失敗:${e instanceof Error ? e.message : String(e)}` };
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

// Walk a small number of source files looking for obvious danger signals. Bounded
// so a huge repo can't stall the scan.
async function grepSources(dir: string): Promise<ScanFinding[]> {
  const findings: ScanFinding[] = [];
  const seen = new Set<string>();
  const patterns: [RegExp, ScanFinding][] = [
    [/child_process|execSync|spawnSync/, { severity: "high", label: "原始碼使用 child_process(可執行任意指令)" }],
    [/\beval\s*\(|new Function\s*\(/, { severity: "high", label: "原始碼使用 eval / new Function" }],
    [/~\/\.(ssh|aws|gnupg)|id_rsa|\/etc\/passwd/, { severity: "high", label: "原始碼讀取憑證/系統敏感路徑" }],
    [/process\.env\b[\s\S]{0,40}(fetch|http|post|axios)/i, { severity: "medium", label: "原始碼疑似外送環境變數" }],
    [/atob\(|Buffer\.from\([^,]+,\s*['"]base64/, { severity: "low", label: "原始碼含 base64 解碼(可能混淆)" }],
  ];
  let scanned = 0;
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 4 || scanned > 200) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (/\.(js|mjs|cjs|ts|mts)$/.test(e.name)) {
        scanned++;
        let src = "";
        try {
          src = await readFile(full, "utf8");
        } catch {
          continue;
        }
        for (const [re, finding] of patterns) {
          if (re.test(src) && !seen.has(finding.label)) {
            seen.add(finding.label);
            findings.push(finding);
          }
        }
      }
    }
  };
  await walk(dir, 0);
  return findings;
}

export async function supplyChainScan(dir: string): Promise<RepoScan> {
  const findings: ScanFinding[] = [];
  const pkg = await readJson(join(dir, "package.json"));
  const scripts = (pkg?.scripts as Record<string, string> | undefined) ?? {};
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    if (scripts[hook]) {
      findings.push({
        severity: "high",
        label: `package.json 有 ${hook} script:「${scripts[hook].slice(0, 80)}」`,
      });
    }
  }
  const depCount =
    Object.keys((pkg?.dependencies as object) ?? {}).length +
    Object.keys((pkg?.devDependencies as object) ?? {}).length;
  if (depCount > 40) {
    findings.push({ severity: "low", label: `依賴數偏多(${depCount})` });
  }
  const hasLockfile =
    (await stat(join(dir, "package-lock.json")).then(() => true).catch(() => false)) ||
    (await stat(join(dir, "pnpm-lock.yaml")).then(() => true).catch(() => false)) ||
    (await stat(join(dir, "yarn.lock")).then(() => true).catch(() => false));
  if (!hasLockfile) {
    findings.push({ severity: "medium", label: "沒有 lockfile(依賴版本不可重現)" });
  }

  findings.push(...(await grepSources(dir)));

  // Resolve the server entry: package.json "bin"/"main", else common paths.
  let entry: string | null = null;
  const bin = pkg?.bin;
  if (typeof bin === "string") entry = bin;
  else if (bin && typeof bin === "object") entry = Object.values(bin as Record<string, string>)[0] ?? null;
  if (!entry && typeof pkg?.main === "string") entry = pkg.main as string;
  if (!entry) {
    for (const cand of ["dist/index.js", "build/index.js", "index.js", "src/index.js"]) {
      if (await stat(join(dir, cand)).then(() => true).catch(() => false)) {
        entry = cand;
        break;
      }
    }
  }
  return { findings, entry, hasLockfile };
}

// Install dependencies with install scripts DISABLED and network on. The repo's
// own code never runs here — only the package manager. Returns false if there's
// nothing to install (no package.json), which is fine for a zero-dep server.
export async function prepareDeps(
  dir: string,
): Promise<{ ok: boolean; error?: string }> {
  const pkg = await readJson(join(dir, "package.json"));
  if (!pkg) return { ok: true };
  const hasDeps =
    Object.keys((pkg.dependencies as object) ?? {}).length > 0 ||
    Object.keys((pkg.devDependencies as object) ?? {}).length > 0;
  if (!hasDeps) return { ok: true };
  try {
    const lock = await stat(join(dir, "package-lock.json")).then(() => true).catch(() => false);
    const args = lock
      ? ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]
      : ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
    await run("npm", args, { cwd: dir, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `依賴安裝失敗:${e instanceof Error ? e.message : String(e)}` };
  }
}

// Connect spec that runs the cloned server INSIDE an isolated container:
// no network (egress deny), read-only source mount, dropped caps, resource caps.
// The MCP stdio channel is carried over `docker run -i`.
// Note: no secrets are injected into the container by design — with `--network
// none` the server cannot reach any external API, so auth tokens would be inert.
// A repo server that genuinely needs outbound credentials is the wrong fit for
// this isolated path; use the http/stdio "connect existing server" flow instead.
export function containerRunSpec(dir: string, entry: string): McpConnectSpec {
  return {
    transport: "stdio",
    command: "docker",
    args: [
      "run",
      "--rm",
      "-i",
      "--runtime",
      RUNTIME,
      "--network",
      "none",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--pids-limit",
      "128",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "-v",
      `${dir}:/srv:ro`,
      "-w",
      "/srv",
      IMAGE,
      "node",
      `/srv/${entry}`,
    ],
  };
}

export async function removeClone(repoUrl: string, commit: string): Promise<void> {
  await rm(cloneDirFor(repoUrl, commit), { recursive: true, force: true });
}
