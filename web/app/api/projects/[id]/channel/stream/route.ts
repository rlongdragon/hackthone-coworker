import { auth } from "@/auth";
import { getMembership } from "@/lib/project-store";
import { getOrCreateProjectChannel, listMessages } from "@/lib/channel-store";
import { asUuid } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

// Per-user cap on concurrent streams (each one polls the DB): protects the
// self-hosted box from a runaway tab storm.
const MAX_STREAMS_PER_USER = 5;
const openStreams = new Map<string, number>();
const POLL_MS = 2000;

// Server-Sent Events (no websocket): polls the channel for messages newer than
// the last one sent and pushes them; heartbeats keep proxies happy. Membership
// is checked when the stream opens AND on every poll — a member removed from the
// project stops receiving immediately (the stream is closed), not only after a
// reconnect.
export async function GET(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const userId = session.user.id;
  const projectId = asUuid((await ctx.params).id);
  if (!projectId) return new Response("Not found", { status: 404 });
  if (!(await getMembership(projectId, userId))) return new Response("Not found", { status: 404 });
  if ((openStreams.get(userId) ?? 0) >= MAX_STREAMS_PER_USER) return new Response("Too many streams", { status: 429 });
  const ch = await getOrCreateProjectChannel(projectId, userId);

  const sinceParam = new URL(req.url).searchParams.get("since");
  let cursor = sinceParam && !isNaN(new Date(sinceParam).getTime()) ? new Date(sinceParam) : new Date();
  const enc = new TextEncoder();
  let closed = false;
  openStreams.set(userId, (openStreams.get(userId) ?? 0) + 1);
  const release = () => {
    if (closed) return;
    closed = true;
    openStreams.set(userId, Math.max(0, (openStreams.get(userId) ?? 1) - 1));
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (s: string) => {
        if (!closed) controller.enqueue(enc.encode(s));
      };
      send(`event: ready\ndata: ${JSON.stringify({ channelId: ch.id })}\n\n`);
      let ticking = false;
      const tick = async () => {
        if (closed || ticking) return;
        ticking = true;
        try {
          // Re-check membership every poll: removal takes effect immediately.
          if (!(await getMembership(projectId, userId))) {
            send(`event: gone\ndata: {}\n\n`);
            clearInterval(timer);
            release();
            try { controller.close(); } catch { /* already closed */ }
            return;
          }
          const msgs = await listMessages(ch.id, { after: cursor });
          if (msgs.length) {
            cursor = new Date(msgs[msgs.length - 1].createdAt);
            send(`data: ${JSON.stringify({ messages: msgs })}\n\n`);
          } else {
            send(`: ping\n\n`);
          }
        } catch {
          /* transient db error: keep the stream alive */
        } finally {
          ticking = false;
        }
      };
      const timer = setInterval(tick, POLL_MS);
      req.signal.addEventListener("abort", () => {
        clearInterval(timer);
        release();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      release();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
