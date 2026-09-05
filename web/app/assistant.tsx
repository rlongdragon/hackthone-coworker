"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { signOut } from "next-auth/react";
import type { UIMessage } from "ai";
import {
  MessageSquare,
  ChevronDown,
  FolderKanban,
  BarChart3,
  CalendarDays,
  History,
  LayoutDashboard,
  ListTodo,
  Wrench,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings2,
  Trash2,
  Users,
} from "lucide-react";
import { deleteThread, renameThread } from "@/lib/chat-actions";
import {
  AssignDepartmentToolUI,
  SetEmployeeRoleToolUI,
} from "@/components/assistant-ui/approval-tool-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

// One consistent look for every sidebar row (matches SidebarGroupLabel).
const ROW = "text-xs font-medium text-sidebar-foreground/70";

function ThreadRow({
  chatId,
  title,
  isActive,
}: {
  chatId: string;
  title: string | null;
  isActive: boolean;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(title ?? "");

  async function submitRename() {
    if (name.trim()) {
      await renameThread(chatId, name.trim());
      setRenaming(false);
      router.refresh();
    }
  }

  async function submitDelete() {
    if (!confirm(`刪除對話「${title ?? "未命名"}」?`)) return;
    await deleteThread(chatId);
    if (isActive) router.push("/");
    else router.refresh();
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className={ROW}
        isActive={isActive}
        render={<a href={`/?t=${chatId}`} />}
      >
        <span className="truncate">{title ?? "(未命名對話)"}</span>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction showOnHover aria-label="對話選項">
              <MoreHorizontal className="size-4" />
            </SidebarMenuAction>
          }
        />
        <DropdownMenuContent side="right" align="start">
          <DropdownMenuItem
            onClick={() => {
              setName(title ?? "");
              setRenaming(true);
            }}
          >
            <Pencil className="size-4" /> 重新命名
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={submitDelete}>
            <Trash2 className="size-4" /> 刪除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重新命名對話</DialogTitle>
          </DialogHeader>
          <form
            action={submitRename}
            className="flex gap-2"
          >
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
    </SidebarMenuItem>
  );
}

export function AppShell({
  user,
  threads,
  projects = [],
  activeProject = null,
  activeChatId,
  initialMessages,
  threadTitle = null,
}: {
  user: { name: string; role: string };
  threads: { chatId: string; title: string | null }[];
  projects?: { id: string; name: string }[];
  activeProject?: { id: string; name: string } | null;
  activeChatId: string;
  initialMessages: UIMessage[];
  threadTitle?: string | null;
}) {
  const isAdmin = user.role === "admin";
  const isManager = user.role === "manager" || isAdmin;
  const [threadsOpen, setThreadsOpen] = useState(true);
  const runtime = useChatRuntime({
    id: activeChatId,
    messages: initialMessages,
    transport: new AssistantChatTransport({
      api: "/api/chat",
      // The runtime's internal id changes per mount; send our stable thread key.
      body: { chatId: activeChatId, projectId: activeProject?.id },
    }),
  });

  // Keep the sidebar live: when a run finishes, re-render the server shell so
  // the new thread + auto-title show up; pin the URL to the thread key so a
  // browser refresh in a fresh chat resumes instead of starting over.
  const router = useRouter();
  const wasRunning = useRef(false);
  useEffect(() => {
    return runtime.thread.subscribe(() => {
      const running = runtime.thread.getState().isRunning;
      if (wasRunning.current && !running) {
        if (!new URLSearchParams(window.location.search).has("t")) {
          const suffix = activeProject ? `&p=${activeProject.id}` : "";
          window.history.replaceState(null, "", `/?t=${activeChatId}${suffix}`);
        }
        router.refresh();
        // auto-title lands async after the stream ends — refresh again for it
        setTimeout(() => router.refresh(), 4000);
      }
      wasRunning.current = running;
    });
  }, [runtime, router, activeChatId, activeProject]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AssignDepartmentToolUI />
      <SetEmployeeRoleToolUI />
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader className="px-3 py-2 text-sm font-semibold">
            Coworker!
          </SidebarHeader>

          <SidebarContent>
            {/* 對話紀錄 — DB-backed; recent few here, full list at /chats */}
            <SidebarGroup>
              <SidebarGroupLabel
                className="cursor-pointer select-none"
                onClick={() => setThreadsOpen((v) => !v)}
              >
                <MessageSquare className="mr-1.5 size-3.5" /> 對話
                <ChevronDown
                  className={`ml-auto size-3.5 transition-transform ${
                    threadsOpen ? "" : "-rotate-90"
                  }`}
                />
              </SidebarGroupLabel>
              <SidebarMenu className="pl-3">
                <SidebarMenuItem>
                  <SidebarMenuButton className={ROW} render={<a href="/" />}>
                    <Plus className="size-4" /> 新對話
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {threadsOpen &&
                  threads.slice(0, 8).map((th) => (
                    <ThreadRow
                      key={th.chatId}
                      chatId={th.chatId}
                      title={th.title}
                      isActive={th.chatId === activeChatId}
                    />
                  ))}
                {threadsOpen && threads.length > 8 && (
                  <SidebarMenuItem>
                    <SidebarMenuButton className={ROW} render={<a href="/chats" />}>
                      <History className="size-4" /> 全部對話({threads.length})
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroup>

            {/* 專案 */}
            <SidebarGroup>
              <SidebarGroupLabel>
                <FolderKanban className="mr-1.5 size-3.5" /> 專案
              </SidebarGroupLabel>
              <SidebarMenu className="pl-3">
                <SidebarMenuItem>
                  <SidebarMenuButton className={ROW} render={<a href="/projects" />}>
                    <Plus className="size-4" /> 新專案
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {projects.map((pr) => (
                  <SidebarMenuItem key={pr.id}>
                    <SidebarMenuButton
                      className={ROW}
                      render={<a href={`/projects/${pr.id}`} />}
                    >
                      <span className="truncate">{pr.name}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
                {projects.length > 0 && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      className={ROW}
                      render={<a href="/projects" />}
                    >
                      <FolderKanban className="size-4" /> 所有專案(
                      {projects.length})
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroup>

            {/* 我的業務 */}
            <SidebarGroup>
              <SidebarGroupLabel>
                <BarChart3 className="mr-1.5 size-3.5" /> 我的業務
              </SidebarGroupLabel>
              <SidebarMenu className="pl-3">
                <SidebarMenuItem>
                  <SidebarMenuButton className={ROW} render={<a href="/me" />}>
                    <LayoutDashboard className="size-4" /> 今日總覽
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    className={ROW}
                    render={<a href="/me/calendar" />}
                  >
                    <CalendarDays className="size-4" /> 行事曆
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton className={ROW} render={<a href="/me/todos" />}>
                    <ListTodo className="size-4" /> 我的待辦
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton className={ROW} render={<a href="/tools" />}>
                    <Wrench className="size-4" /> 工具庫
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>

            {/* 管理 — manager/admin only */}
            {isManager && (
              <SidebarGroup>
                <SidebarGroupLabel>
                  <Users className="mr-1.5 size-3.5" /> 管理
                </SidebarGroupLabel>
                <SidebarMenu className="pl-3">
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      className={ROW}
                      render={<a href="/manager" />}
                    >
                      <Users className="size-4" /> 團隊總覽
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  {isAdmin && (
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        className={ROW}
                        render={<a href="/admin" />}
                      >
                        <Settings2 className="size-4" /> 管理後台
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                </SidebarMenu>
              </SidebarGroup>
            )}
          </SidebarContent>

          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <div className="text-muted-foreground px-2 py-1 text-xs">
                  {user.name} · {user.role}
                </div>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className={ROW}
                  onClick={async () => {
                    // redirect:false + relative navigation — NextAuth's own
                    // redirect builds an absolute URL from the server's bind
                    // address (0.0.0.0), which breaks off-box access.
                    await signOut({ redirect: false });
                    window.location.href = "/login";
                  }}
                >
                  <LogOut className="size-4" /> 登出
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>

        {/* h-dvh + overflow-hidden: the thread viewport scrolls internally;
            the page body must never scroll (or the composer leaves the screen). */}
        <SidebarInset className="h-dvh overflow-hidden">
          <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3 text-sm">
            <SidebarTrigger />
            {activeProject && (
              <>
                <a
                  href={`/projects/${activeProject.id}`}
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                  title="回專案頁"
                >
                  <FolderKanban className="size-3.5" /> {activeProject.name}
                </a>
                <span className="text-muted-foreground/50">/</span>
              </>
            )}
            <span className="min-w-0 truncate font-medium">
              {threadTitle ?? "新對話"}
            </span>
          </header>
          <div className="min-h-0 flex-1">
            <Thread />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </AssistantRuntimeProvider>
  );
}
