"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FolderKanban, Pencil, Search, Trash2 } from "lucide-react";
import { deleteThread, renameThread } from "@/lib/chat-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ThreadDto = {
  chatId: string;
  title: string | null;
  updatedAt: string;
  projectId: string | null;
  projectName: string | null;
};

export function ChatsManager({ threads }: { threads: ThreadDto[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [renaming, setRenaming] = useState<ThreadDto | null>(null);
  const [name, setName] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return threads;
    return threads.filter(
      (t) =>
        (t.title ?? "").toLowerCase().includes(needle) ||
        (t.projectName ?? "").toLowerCase().includes(needle),
    );
  }, [threads, q]);

  async function submitRename() {
    if (!renaming || !name.trim()) return;
    await renameThread(renaming.chatId, name.trim());
    setRenaming(null);
    router.refresh();
  }

  async function remove(t: ThreadDto) {
    if (!confirm(`刪除對話「${t.title ?? "未命名"}」?`)) return;
    await deleteThread(t.chatId);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜尋標題或專案…"
          className="pl-8"
        />
      </div>

      <ul className="divide-y rounded-lg border">
        {filtered.length === 0 && (
          <li className="text-muted-foreground px-4 py-8 text-center text-sm">
            {q ? "沒有符合的對話。" : "還沒有對話。"}
          </li>
        )}
        {filtered.map((t) => (
          <li
            key={t.chatId}
            className="group flex items-center gap-3 px-3 py-2.5 text-sm"
          >
            <a
              href={`/?t=${t.chatId}`}
              className="min-w-0 flex-1 truncate font-medium hover:underline"
            >
              {t.title ?? "(未命名對話)"}
            </a>
            {t.projectName && t.projectId && (
              <Badge variant="outline" className="shrink-0 gap-1">
                <FolderKanban className="size-3" /> {t.projectName}
              </Badge>
            )}
            <span className="text-muted-foreground shrink-0 text-xs">
              {new Date(t.updatedAt).toLocaleDateString("zh-TW", {
                timeZone: "Asia/Taipei",
              })}
            </span>
            <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
              <button
                className="text-muted-foreground hover:text-foreground p-1.5"
                title="重新命名"
                onClick={() => {
                  setRenaming(t);
                  setName(t.title ?? "");
                }}
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                className="text-muted-foreground hover:text-destructive p-1.5"
                title="刪除"
                onClick={() => remove(t)}
              >
                <Trash2 className="size-3.5" />
              </button>
            </span>
          </li>
        ))}
      </ul>

      <Dialog open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重新命名對話</DialogTitle>
          </DialogHeader>
          <form action={submitRename} className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              autoFocus
            />
            <Button type="submit">儲存</Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
