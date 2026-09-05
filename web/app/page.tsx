import { randomUUID } from "node:crypto";
import { requireEmployee } from "@/lib/authz";
import { getThreadProjectId, listThreads, loadUIMessages } from "@/lib/chat-store";
import { listMyProjects } from "@/lib/project-store";
import { AppShell } from "./assistant";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; p?: string }>;
}) {
  const user = await requireEmployee();
  const { t, p } = await searchParams;
  const [threadRows, projectRows] = await Promise.all([
    listThreads(user.id),
    listMyProjects(user.id),
  ]);
  const threads = threadRows.map((th) => ({
    chatId: th.chatId ?? "",
    title: th.title,
  }));
  const projects = projectRows
    .filter((p) => p.status === "active")
    .map((p) => ({ id: p.id, name: p.name }));

  // Project binding: an existing thread's stored project wins; otherwise
  // ?p=<projectId> starts a new project-scoped thread (must be a member).
  // The badge lookup uses the *unfiltered* membership list so archived
  // projects still show their binding instead of silently unscoping.
  const boundProjectId = t ? await getThreadProjectId(user.id, t) : null;
  const wantedProjectId = boundProjectId ?? p ?? null;
  const activeProject = wantedProjectId
    ? (projectRows
        .map((pr) => ({ id: pr.id, name: pr.name }))
        .find((pr) => pr.id === wantedProjectId) ?? null)
    : null;

  const activeChatId = t ?? randomUUID();
  const initialMessages = t ? await loadUIMessages(user.id, t) : [];
  const threadTitle =
    threads.find((th) => th.chatId === activeChatId)?.title ?? null;

  return (
    <AppShell
      user={{ name: user.name, role: user.role }}
      threads={threads}
      projects={projects}
      activeProject={activeProject}
      activeChatId={activeChatId}
      initialMessages={initialMessages}
      threadTitle={threadTitle}
    />
  );
}
