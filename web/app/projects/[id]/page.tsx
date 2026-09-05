import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  MessageSquarePlus,
  X,
} from "lucide-react";
import { requireEmployee } from "@/lib/authz";
import { getProject } from "@/lib/project-store";
import { listProjectFiles } from "@/lib/file-store";
import { listMyProjectThreads } from "@/lib/chat-store";
import { getBoard } from "@/lib/board-store";
import { removeMember, setProjectStatus } from "@/lib/project-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AddMemberForm } from "../projects-client";
import { ProjectFiles } from "./project-files";
import { KanbanBoard } from "./kanban-board";
import { MeetingMinutes } from "./meeting-minutes";
import { TeamAgent } from "./team-agent";
import { DispatchForm } from "./dispatch-form";
import { listMeetingRecords } from "@/lib/meeting-store";
import { getTeamAgent } from "@/lib/team-agent";
import { asrConfigured } from "@/lib/asr";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireEmployee();
  const { id } = await params;
  const data = await getProject(id, user.id);
  if (!data) notFound();
  const { project, members, myRole } = data;
  const isOwner = myRole === "owner";

  const [files, myThreads, board, meetings, teamAgent] = await Promise.all([
    listProjectFiles(project.id),
    listMyProjectThreads(user.id, project.id),
    getBoard(project.id),
    listMeetingRecords(project.id),
    getTeamAgent(project.id),
  ]);

  return (
    <main className="w-full mx-auto max-w-4xl p-6">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Link
          href="/projects"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> 專案列表
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
        {project.status === "archived" && <Badge variant="outline">已封存</Badge>}
        <Link href={`/projects/${project.id}/chat`} className="text-muted-foreground hover:text-foreground text-sm underline">
          專案頻道 →
        </Link>
        {isOwner && (
          <form action={setProjectStatus} className="ml-auto">
            <input type="hidden" name="projectId" value={project.id} />
            <input
              type="hidden"
              name="status"
              value={project.status === "active" ? "archived" : "active"}
            />
            <Button type="submit" variant="outline" size="sm">
              {project.status === "active" ? (
                <>
                  <Archive className="size-3.5" /> 封存
                </>
              ) : (
                <>
                  <ArchiveRestore className="size-3.5" /> 還原
                </>
              )}
            </Button>
          </form>
        )}
      </div>
      {project.description && (
        <p className="text-muted-foreground -mt-3 mb-6 text-sm">
          {project.description}
        </p>
      )}

      {/* Kanban board — statuses are user-defined columns, cards draggable */}
      <section className="mb-6">
        <KanbanBoard
          projectId={project.id}
          columns={board.columns.map((c) => ({ id: c.id, name: c.name }))}
          cards={board.cards.map((c) => ({
            id: c.id,
            columnId: c.columnId,
            title: c.title,
            assigneeId: c.assigneeId,
            assigneeName: c.assigneeName,
            position: c.position,
          }))}
          members={members.map((m) => ({ id: m.id, name: m.name }))}
          readOnly={project.status !== "active"}
        />
      </section>

      {/* Meeting records: audio/transcript → team-scoped collab event → decisions +
          action items (需確認) → confirmed items become dispatched todos */}
      <section className="mb-6">
        <MeetingMinutes
          projectId={project.id}
          members={members.map((m) => ({ id: m.id, name: m.name }))}
          canEdit={project.status === "active"}
          asrEnabled={asrConfigured()}
          initial={meetings.map((m) => ({
            id: m.id,
            createdByName: m.createdByName,
            createdAt: m.createdAt.toISOString(),
            source: m.source,
            transcript: m.transcript,
            decisions: m.decisions,
            tasks: m.tasks,
            tainted: m.tainted,
            asr: m.asr,
          }))}
        />
      </section>

      {/* The project's own agent identity (scope=team): answers from team-produced
          data only — board, files, meeting decisions — never a member's private memory */}
      {teamAgent && (
        <section className="mb-6">
          <TeamAgent
            projectId={project.id}
            identity={{
              projectName: teamAgent.projectName,
              permissions: teamAgent.permissions,
              memberCount: teamAgent.memberCount,
              meetingCount: teamAgent.meetingCount,
              decisionCount: teamAgent.decisionCount,
            }}
          />
        </section>
      )}

      <div className="grid gap-6 md:grid-cols-[1fr_280px]">
        {/* Members */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">成員 {members.length}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-2">
              {members.map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-sm">
                  <span className="bg-muted grid size-7 shrink-0 place-items-center rounded-full text-xs font-medium">
                    {m.name.slice(0, 1)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate">{m.name}</span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {m.email}
                    </span>
                  </span>
                  {m.memberRole === "owner" ? (
                    <Badge variant="secondary" className="ml-auto">
                      負責人
                    </Badge>
                  ) : (
                    isOwner && (
                      <form action={removeMember} className="ml-auto">
                        <input type="hidden" name="projectId" value={project.id} />
                        <input type="hidden" name="memberId" value={m.id} />
                        <Button
                          type="submit"
                          variant="ghost"
                          size="sm"
                          title="移除成員"
                        >
                          <X className="size-3.5" />
                        </Button>
                      </form>
                    )
                  )}
                </li>
              ))}
            </ul>
            {isOwner && project.status === "active" && (
              <AddMemberForm projectId={project.id} />
            )}
          </CardContent>
        </Card>

        {/* Files */}
        <ProjectFiles
          projectId={project.id}
          initialFiles={files.map((f) => ({
            id: f.id,
            filename: f.filename,
            mime: f.mime,
            size: f.size,
            uploaderId: f.uploaderId,
            uploaderName: f.uploaderName,
            createdAt: f.createdAt.toISOString(),
          }))}
          canUpload={project.status === "active"}
          canDeleteAll={isOwner}
          myId={user.id}
        />

        {/* Manager dispatch (P4): same rule as meeting-item confirm */}
        {project.status === "active" && (
          <DispatchForm projectId={project.id} members={members.map((m) => ({ id: m.id, name: m.name }))} />
        )}

        {/* My conversations in this project */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              專案對話
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                nativeButton={false}
                render={<a href={`/?p=${project.id}`} />}
              >
                <MessageSquarePlus className="size-3.5" /> 開新對話
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {myThreads.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                還沒有專案對話。開一個,AI 會自帶這個專案的成員、待辦與文件清單。
              </p>
            ) : (
              <ul className="space-y-1.5">
                {myThreads.map((t) => (
                  <li key={t.chatId}>
                    <Link
                      href={`/?t=${t.chatId}`}
                      className="text-sm hover:underline"
                    >
                      {t.title ?? "(未命名對話)"}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-muted-foreground mt-3 text-xs">
              對話屬於個人,成員各自擁有自己的專案對話。
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
