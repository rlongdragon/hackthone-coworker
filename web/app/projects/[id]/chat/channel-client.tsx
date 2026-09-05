"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";

type Msg = {
  id: string;
  authorId: string | null;
  authorName: string;
  authorType: "user" | "agent";
  content: string;
  createdAt: string;
};

export function ChannelClient({ projectId, initial, myId }: { projectId: string; initial: Msg[]; myId: string }) {
  const [msgs, setMsgs] = useState<Msg[]>(initial);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const lastAt = useRef<string | null>(initial.at(-1)?.createdAt ?? null);

  // SSE: everything newer than what we already have.
  useEffect(() => {
    const since = lastAt.current ?? new Date(0).toISOString();
    const es = new EventSource(`/api/projects/${projectId}/channel/stream?since=${encodeURIComponent(since)}`);
    es.addEventListener("ready", () => setLive(true));
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as { messages?: Msg[] };
        if (data.messages?.length) {
          setMsgs((cur) => {
            const seen = new Set(cur.map((m) => m.id));
            const add = data.messages!.filter((m) => !seen.has(m.id));
            if (add.length) lastAt.current = add[add.length - 1].createdAt;
            return add.length ? [...cur, ...add] : cur;
          });
        }
      } catch {
        /* ignore malformed */
      }
    };
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [projectId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [msgs.length]);

  async function send() {
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/channel/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        const data = (await res.json()) as { message: Msg; agentReply: Msg | null };
        // optimistic: SSE will dedupe by id
        setMsgs((cur) => {
          const seen = new Set(cur.map((m) => m.id));
          const add = [data.message, ...(data.agentReply ? [data.agentReply] : [])].filter((m) => !seen.has(m.id));
          if (add.length) lastAt.current = add[add.length - 1].createdAt;
          return [...cur, ...add];
        });
        setText("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[70vh] flex-col rounded-lg border">
      <div className="text-muted-foreground flex items-center gap-2 border-b px-3 py-2 text-xs">
        <span className={`inline-block size-2 rounded-full ${live ? "bg-emerald-500" : "bg-gray-400"}`} />
        {live ? "即時連線(SSE)" : "連線中…"} · 輸入 <code>@agent</code> 讓團隊代理加入(它只用團隊資料作答,不會提升你的權限)
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3" data-testid="channel-messages">
        {msgs.length === 0 && <p className="text-muted-foreground text-sm">還沒有訊息。</p>}
        {msgs.map((m) => (
          <div key={m.id} className={`text-sm ${m.authorType === "agent" ? "bg-muted/50 rounded-md border p-2" : ""}`} data-author-type={m.authorType}>
            <span className="mr-2 font-medium">
              {m.authorType === "agent" ? <Bot className="mr-1 inline size-3.5" /> : null}
              {m.authorId === myId ? "我" : m.authorName}
            </span>
            <span className="text-muted-foreground mr-2 text-xs">{new Date(m.createdAt).toLocaleTimeString("zh-TW")}</span>
            <span className="whitespace-pre-wrap">{m.content}</span>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="flex gap-2 border-t p-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
          placeholder="傳訊息…(@agent 可召喚團隊代理)"
          className="bg-background flex-1 rounded-md border px-2 py-1 text-sm"
          aria-label="頻道訊息"
        />
        <Button size="sm" disabled={busy || !text.trim()} onClick={send} data-testid="channel-send">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}
