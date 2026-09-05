import { auth } from "@/auth";
import { getMembership } from "@/lib/project-store";
import { getOrCreateProjectChannel, listMessages } from "@/lib/channel-store";
import { asUuid } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

// Server-Sent Events (no websocket): polls the channel for messages newer than
// the last one sent and pushes them; heartbeats keep proxies happy. Membership
// is checked when the stream opens; the stream is closed by the client.
export async function GET(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const projectId = asUuid((await ctx.params).id);
  if (!projectId) return new Response("Not found", { status: 404 });
  if (!(await getMembership(projectId, session.user.id))) return new Response("Not found", { status: 404 });
  const ch = await getOrCreateProjectChannel(projectId, session.user.id);

  const sinceParam = new URL(req.url).searchParams.get("since");
  let cursor = sinceParam && !isNaN(new Date(sinceParam).getTime()) ? new Date(sinceParam) : new Date();
  const enc = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (s: string) => {
        if (!closed) controller.enqueue(enc.encode(s));
      };
      send(`event: ready\ndata: ${JSON.stringify({ channelId: ch.id })}\n\n`);
      const tick = async () => {
        if (closed) return;
        try {
          const msgs = await listMessages(ch.id, { after: cursor });
          if (msgs.length) {
            cursor = new Date(msgs[msgs.length - 1].createdAt);
            send(`data: ${JSON.stringify({ messages: msgs })}\n\n`);
          } else {
            send(`: ping\n\n`);
          }
        } catch {
          /* transient db error: keep the stream alive */
        }
      };
      const timer = setInterval(tick, 1500);
      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(timer);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      closed = true;
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
