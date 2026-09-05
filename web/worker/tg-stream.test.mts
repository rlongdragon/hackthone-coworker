// Unit test for streamReply with a mock grammY context.
// Run: npx tsx worker/tg-stream.test.mts
import { streamReply } from "./tg-stream";

const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) process.exitCode = 1;
};

type Call = { kind: "send" | "edit"; text: string; opts?: Record<string, unknown> };

function mockCtx(calls: Call[]) {
  return {
    chat: { id: 42 },
    reply: async (text: string, opts?: Record<string, unknown>) => {
      calls.push({ kind: "send", text, opts });
      return { message_id: 100 + calls.length };
    },
    api: {
      editMessageText: async (
        _chat: number,
        _mid: number,
        text: string,
        opts?: Record<string, unknown>,
      ) => {
        calls.push({ kind: "edit", text, opts });
        return true;
      },
    },
  } as never;
}

async function* deltas(parts: string[], delayMs = 0) {
  for (const p of parts) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    yield p;
  }
}

// 1. Normal stream: opens one message, edits, finalizes with HTML.
{
  const calls: Call[] = [];
  const words = Array.from({ length: 40 }, (_, i) => `字詞${i} **重點** `);
  const r = await streamReply(mockCtx(calls), deltas(words, 60));
  const sends = calls.filter((c) => c.kind === "send");
  const edits = calls.filter((c) => c.kind === "edit");
  const final = calls[calls.length - 1];
  check("one message opened", sends.length === 1);
  check("progressive edits happened", edits.length >= 2);
  check("stream previews are plain (no parse_mode)", sends[0].opts === undefined);
  check("finalize uses HTML", final.opts?.parse_mode === "HTML");
  check("finalize formats bold", final.text.includes("<b>重點</b>"));
  check("cursor gone in final", !final.text.includes("▍"));
  check("returned full text", r.sent && r.text.includes("字詞39"));
}

// 2. Tiny stutter (short output): still delivered via finalize.
{
  const calls: Call[] = [];
  const r = await streamReply(mockCtx(calls), deltas(["ok"]));
  check("short reply delivered once", calls.length === 1 && calls[0].kind === "send");
  check("short reply text", r.sent && r.text === "ok");
}

// 3. Empty stream: nothing sent.
{
  const calls: Call[] = [];
  const r = await streamReply(mockCtx(calls), deltas([]));
  check("empty stream sends nothing", calls.length === 0 && !r.sent);
}

// 4. Overflow: >4096 final splits into multiple messages, preview saturates.
{
  const calls: Call[] = [];
  const big = Array.from({ length: 120 }, (_, i) => `行${i} ` + "a".repeat(80) + "\n");
  const r = await streamReply(mockCtx(calls), deltas(big, 25));
  const finals = calls.filter((c) => c.opts?.parse_mode === "HTML");
  check("overflow split into 2+ final chunks", finals.length >= 2);
  check("no chunk exceeds 4096", calls.every((c) => c.text.length <= 4096));
  check("full text returned", r.text.length > 9000);
}

process.exit(process.exitCode ?? 0);
