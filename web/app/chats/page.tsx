import Link from "next/link";
import { ArrowLeft, MessagesSquare } from "lucide-react";
import { requireEmployee } from "@/lib/authz";
import { listThreads } from "@/lib/chat-store";
import { ChatsManager } from "./chats-client";

export default async function ChatsPage() {
  const user = await requireEmployee();
  const threads = await listThreads(user.id, 500);

  return (
    <main className="w-full mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> 回聊天
        </Link>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <MessagesSquare className="size-5" /> 所有對話
        </h1>
        <p className="text-muted-foreground ml-auto text-sm">
          {threads.length} 則
        </p>
      </div>

      <ChatsManager
        threads={threads.map((t) => ({
          chatId: t.chatId ?? "",
          title: t.title,
          updatedAt: t.updatedAt.toISOString(),
          projectId: t.projectId,
          projectName: t.projectName,
        }))}
      />
    </main>
  );
}
