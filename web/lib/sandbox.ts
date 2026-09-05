import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const dockerExec = promisify(execFile);

// Per-employee sandbox: a long-lived container running the coworker-sandbox
// image under gVisor (--runtime=runsc), no network, non-root, resource-capped.
// /workspace is a named volume so installed packages and files survive
// restarts — this is what lets the agent "grow" (accumulate skills/scripts).
// Commands reach it via `docker exec`; files via `docker cp`. All docker
// invocations use execFile with argument arrays — nothing is interpolated
// into a host shell.

const IMAGE = process.env.SANDBOX_IMAGE ?? "coworker-sandbox:latest";
const RUNTIME = process.env.SANDBOX_RUNTIME ?? "runsc";
const IDLE_STOP_MS = 15 * 60 * 1000;
const EXEC_OUTPUT_CAP = 8_000; // chars of stdout/stderr handed back to the LLM
const MAX_TIMEOUT_S = 300;

const containerName = (employeeId: string) => `cw-sbx-${employeeId}`;
const volumeName = (employeeId: string) => `cw-ws-${employeeId}`;

// Reject only genuinely dangerous names — path separators, traversal, control
// chars, leading dash (arg injection into docker cp). Filenames are already
// basename'd + length-capped at upload, so arbitrary Unicode (incl. CJK) is fine.
export function isSafeFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..") &&
    !name.startsWith("-") &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(name)
  );
}

async function docker(args: string[], opts: { timeoutMs?: number } = {}) {
  return dockerExec("docker", args, {
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

// Serialize per-employee container creation so two parallel tool calls don't
// both `docker run` the same name.
const creating = new Map<string, Promise<void>>();
const lastUsed = new Map<string, number>();

export async function ensureSandbox(employeeId: string): Promise<void> {
  lastUsed.set(employeeId, Date.now());
  const pending = creating.get(employeeId);
  if (pending) return pending;
  const p = (async () => {
    const name = containerName(employeeId);
    try {
      const { stdout } = await docker(["inspect", "-f", "{{.State.Running}}", name]);
      if (stdout.trim() === "true") return;
      await docker(["start", name]);
      return;
    } catch {
      // container does not exist yet
    }
    await docker([
      "run", "-d",
      "--name", name,
      "--runtime", RUNTIME,
      "--network", "none",
      "--memory", "1g",
      "--cpus", "1",
      "--pids-limit", "256",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "-v", `${volumeName(employeeId)}:/workspace`,
      IMAGE,
      "sleep", "infinity",
    ], { timeoutMs: 60_000 });
  })().finally(() => creating.delete(employeeId));
  creating.set(employeeId, p);
  return p;
}

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
};

export async function execInSandbox(
  employeeId: string,
  command: string,
  timeoutSeconds = 60,
): Promise<ExecResult> {
  await ensureSandbox(employeeId);
  const t = Math.min(Math.max(1, Math.floor(timeoutSeconds)), MAX_TIMEOUT_S);
  const name = containerName(employeeId);
  try {
    const { stdout, stderr } = await docker(
      // `timeout` runs inside the container: killing the docker-exec client
      // from the host would leave the process running in the sandbox.
      ["exec", "-w", "/workspace", name, "timeout", `${t}s`, "bash", "-lc", command],
      { timeoutMs: (t + 10) * 1000 },
    );
    return shape(0, stdout, stderr, false);
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    const code = typeof err.code === "number" ? err.code : 1;
    return shape(code, err.stdout ?? "", err.stderr ?? "", code === 124 || Boolean(err.killed));
  }
}

function shape(exitCode: number, stdout: string, stderr: string, timedOut: boolean): ExecResult {
  const truncated = stdout.length > EXEC_OUTPUT_CAP || stderr.length > EXEC_OUTPUT_CAP;
  return {
    exitCode,
    stdout: stdout.slice(0, EXEC_OUTPUT_CAP),
    stderr: stderr.slice(0, EXEC_OUTPUT_CAP),
    truncated,
    timedOut,
  };
}

// Write text content to a file under /workspace without shell quoting issues:
// stream it over docker exec's stdin into `cat`.
export async function writeFileInSandbox(
  employeeId: string,
  relPath: string,
  content: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await ensureSandbox(employeeId);
  if (relPath.includes("..") || relPath.startsWith("/") || relPath.startsWith("-")) {
    return { ok: false, error: "path must be relative to /workspace, no '..'" };
  }
  return new Promise((resolve) => {
    const child = spawn("docker", [
      "exec", "-i", "-w", "/workspace", containerName(employeeId),
      "bash", "-c", 'mkdir -p "$(dirname "$0")" && cat > "$0"', relPath,
    ]);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.slice(0, 500) }),
    );
    child.on("error", (e) => resolve({ ok: false, error: String(e) }));
    child.stdin.write(content);
    child.stdin.end();
  });
}

// Host file -> /workspace/in/<destName> (project file handed to the agent).
export async function copyIntoSandbox(
  employeeId: string,
  hostPath: string,
  destName: string,
): Promise<void> {
  await ensureSandbox(employeeId);
  await docker(["cp", hostPath, `${containerName(employeeId)}:/workspace/in/${destName}`]);
}

// In-memory bytes -> /workspace/in/<destName>. For chat-composer attachments,
// which arrive as data URLs rather than files on disk. Caller must have
// validated destName with isSafeFileName.
export async function copyBytesIntoSandbox(
  employeeId: string,
  destName: string,
  bytes: Buffer,
): Promise<void> {
  await ensureSandbox(employeeId);
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "cw-in-"));
  try {
    const hp = join(dir, "blob");
    await writeFile(hp, bytes);
    await docker(["cp", hp, `${containerName(employeeId)}:/workspace/in/${destName}`]);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// /workspace/out/<srcName> -> host path (agent output collected back).
export async function copyOutOfSandbox(
  employeeId: string,
  srcName: string,
  hostPath: string,
): Promise<void> {
  await ensureSandbox(employeeId);
  await docker(["cp", `${containerName(employeeId)}:/workspace/out/${srcName}`, hostPath]);
}

// Stop containers idle for a while — the workspace volume keeps everything,
// next use just `docker start`s. Runs on an interval; guarded on globalThis
// because dev-mode HMR re-evaluates modules.
const g = globalThis as typeof globalThis & { __cwSbxReaper?: ReturnType<typeof setInterval> };
if (!g.__cwSbxReaper) {
  g.__cwSbxReaper = setInterval(async () => {
    try {
      const { stdout } = await docker(["ps", "--filter", "name=cw-sbx-", "--format", "{{.Names}}"]);
      const now = Date.now();
      for (const name of stdout.split("\n").filter(Boolean)) {
        const employeeId = name.slice("cw-sbx-".length);
        const t = lastUsed.get(employeeId) ?? 0; // unknown (server restarted) -> stop
        if (now - t > IDLE_STOP_MS) {
          await docker(["stop", "-t", "2", name]).catch(() => {});
          lastUsed.delete(employeeId);
        }
      }
    } catch {
      // docker unavailable — retry next tick
    }
  }, 5 * 60 * 1000);
  g.__cwSbxReaper.unref?.();
}
