import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Thin wrapper over the official MCP SDK. Two transports:
//   - http  : StreamableHTTP to a URL (self-hosted server / gateway)
//   - stdio : spawn a local command (argv array, NEVER a shell string) with
//             install scripts already disabled upstream; env is an explicit
//             allow-map so the child never inherits the host's secrets.
// Connections are short-lived: opened for a task (test/audit/one agent turn)
// and closed in a finally. Nothing here is cached across turns — a stale
// child process is a worse failure mode than a reconnect.

export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: unknown; // JSON Schema object from the server
  annotations?: Record<string, unknown>;
};

export type McpConnectSpec =
  | { transport: "http"; url: string; headers?: Record<string, string> }
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;

// True for cloud-metadata / link-local addresses (the SSRF target we block).
// Loopback / RFC-1918 are deliberately NOT blocked: self-hosted internal MCP
// servers live there and the action is admin-gated.
function isMetadataOrLinkLocal(ip: string): boolean {
  // Normalise IPv6-mapped IPv4 (::ffff:169.254.169.254 → 169.254.169.254).
  const v4mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const addr = v4mapped ? v4mapped[1] : ip;
  if (isIP(addr) === 4) return /^169\.254\./.test(addr); // 169.254.0.0/16
  const low = ip.toLowerCase();
  return low === "fe80::" || low.startsWith("fe80:"); // IPv6 link-local
}

// Block the classic SSRF target (cloud metadata / link-local) on the http
// transport. Checks the RESOLVED IPs, not the hostname string, so a name that
// resolves to 169.254.169.254 or an alternate encoding (decimal/octal/IPv6-
// mapped) can't slip past. A DNS-rebind window after this check remains
// (accepted for an admin-gated action).
async function assertSafeHttpTarget(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("URL 格式不正確");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("只允許 http/https");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host.toLowerCase() === "metadata.google.internal") {
    throw new Error("禁止連線至雲端 metadata 位址");
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true }); // resolves numeric forms too
  } catch {
    throw new Error("無法解析主機位址");
  }
  if (addrs.some((a) => isMetadataOrLinkLocal(a.address))) {
    throw new Error("禁止連線至 link-local / 雲端 metadata 位址");
  }
}

// A minimal, non-secret base env for stdio children. We deliberately do NOT
// use getDefaultEnvironment() (which forwards PATH etc.) beyond PATH so a
// poisoned server cannot read host tokens from process.env.
function childEnv(extra?: Record<string, string>): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(extra ?? {}) };
}

export type McpSession = {
  client: Client;
  close: () => Promise<void>;
};

export async function openMcp(spec: McpConnectSpec): Promise<McpSession> {
  if (spec.transport === "http") await assertSafeHttpTarget(spec.url);
  const client = new Client(
    { name: "coworker", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport =
    spec.transport === "http"
      ? new StreamableHTTPClientTransport(new URL(spec.url), {
          requestInit: spec.headers ? { headers: spec.headers } : undefined,
        })
      : new StdioClientTransport({
          command: spec.command,
          args: spec.args ?? [],
          env: childEnv(spec.env),
        });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("MCP connect timeout")), CONNECT_TIMEOUT_MS);
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
  } catch (e) {
    // Timeout (or connect error) already spawned the child/container — close the
    // transport so it isn't orphaned, then rethrow.
    try {
      await client.close();
    } catch {
      /* best-effort */
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }

  return {
    client,
    close: async () => {
      try {
        await client.close();
      } catch {
        // best-effort; transport may already be gone
      }
    },
  };
}

export async function listMcpTools(client: Client): Promise<McpToolDef[]> {
  const res = await client.listTools();
  return (res.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object" },
    annotations: t.annotations as Record<string, unknown> | undefined,
  }));
}

export type McpCallResult = { ok: boolean; text: string; isError: boolean };

export async function callMcpTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("MCP call timeout")), CALL_TIMEOUT_MS);
  });
  let res: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  try {
    res = (await Promise.race([client.callTool({ name, arguments: args }), timeout])) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = (res.content ?? [])
    .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
    .join("\n")
    .slice(0, 12_000);
  return { ok: !res.isError, text, isError: !!res.isError };
}

// Stable hash of a tool's trust surface (description + schema). Any change to
// either after approval trips the rug-pull guard.
export function toolSurfaceHash(description: string, inputSchema: unknown): string {
  const canon = stableStringify({ d: description, s: inputSchema ?? null });
  return createHash("sha256").update(canon).digest("hex");
}

// Deterministic JSON: object keys sorted recursively, so a server that merely
// reorders schema keys between listings does not trip a false rug-pull.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
