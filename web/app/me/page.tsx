import Link from "next/link";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Circle,
  CircleCheckBig,
  FolderKanban,
  ListTodo,
  MapPin,
} from "lucide-react";
import { requireEmployee } from "@/lib/authz";
import { db } from "@/db";
import { todos } from "@/db/schema";
import { listEventsInRange } from "@/lib/event-store";
import { listMyProjects } from "@/lib/project-store";
import { listThreads } from "@/lib/chat-store";
import { getLinkForEmployee } from "@/lib/telegram-store";
import {
  listApprovableHandovers,
  listReceivedHandovers,
} from "@/lib/handover-store";
import { listOpenQuestionsForLeaver } from "@/lib/handover-gaps";
import { TelegramCard } from "./telegram-card";
import {
  HandoverApprovalCard,
  HandoverInterviewCard,
  HandoverReceivedCard,
} from "./handover-cards";
import { toggleTodo } from "@/lib/project-actions";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BriefingCard } from "./briefing-card";

const TZ_OFFSET_MS = 8 * 3600 * 1000; // Asia/Taipei

function todayRange(): { start: Date; end: Date; label: string } {
  const local = new Date(Date.now() + TZ_OFFSET_MS);
  const label = local.toISOString().slice(0, 10);
  const start = new Date(new Date(label + "T00:00:00Z").getTime() - TZ_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000), label };
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Taipei",
  });
}

export default async function DashboardPage() {
  const user = await requireEmployee();
  const { start, end, label } = todayRange();

  const [events, dueTodos, projects, threads, tgLink, approvable, received, openQuestions] =
    await Promise.all([
    listEventsInRange(user.id, start, end),
    db
      .select()
      .from(todos)
      .where(
        and(eq(todos.employeeId, user.id), eq(todos.done, false), lte(todos.due, end)),
      )
      .orderBy(asc(todos.due))
      .limit(10),
    listMyProjects(user.id),
    listThreads(user.id),
    getLinkForEmployee(user.id),
    listApprovableHandovers(user.id, user.role),
    listReceivedHandovers(user.id),
    listOpenQuestionsForLeaver(user.id),
  ]);
  const activeProjects = projects.filter((p) => p.status === "active");

  return (
    <main className="w-full mx-auto max-w-5xl p-6">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> 回聊天
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          {user.name},今天是 {label}
        </h1>
      </div>

      <div className="space-y-4">
        <HandoverApprovalCard
          rows={approvable.map((h) => ({ id: h.id, toName: h.toName, scope: h.scope }))}
        />
        <HandoverInterviewCard
          rows={openQuestions.map((q) => ({
            id: q.id,
            question: q.question,
            kind: q.kind,
            toName: q.toName,
          }))}
        />
        <HandoverReceivedCard
          rows={received.map((h) => ({
            id: h.id,
            fromName: h.fromName,
            completedAt: h.completedAt?.toISOString() ?? null,
            summary: h.summary,
            graceUntil: h.graceUntil?.toISOString() ?? null,
            followupDone: h.followupDone,
            custodial: h.custodial,
          }))}
        />
      </div>

      <BriefingCard />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* today's events */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarDays className="size-4" /> 今日行程
              <Link
                href="/me/calendar"
                className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs font-normal"
              >
                開行事曆 <ArrowRight className="size-3" />
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-muted-foreground text-sm">今天沒有排程。</p>
            ) : (
              <ul className="space-y-2">
                {events.map((e) => (
                  <li key={e.id} className="flex items-baseline gap-3 text-sm">
                    <span className="text-muted-foreground w-24 shrink-0 font-mono text-xs">
                      {e.allDay ? "全天" : `${fmtTime(e.startsAt)}–${fmtTime(e.endsAt)}`}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{e.title}</span>
                      {e.location && (
                        <span className="text-muted-foreground flex items-center gap-1 text-xs">
                          <MapPin className="size-3" /> {e.location}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* due todos */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ListTodo className="size-4" /> 今天該處理的待辦
              <Link
                href="/me/todos"
                className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs font-normal"
              >
                全部待辦 <ArrowRight className="size-3" />
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dueTodos.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                沒有到期的待辦。跟 Coworker 說一聲就能新增。
              </p>
            ) : (
              <ul className="space-y-1.5">
                {dueTodos.map((t) => {
                  const overdue = t.due && t.due < start;
                  return (
                    <li key={t.id} className="flex items-center gap-2 text-sm">
                      <form action={toggleTodo}>
                        <input type="hidden" name="todoId" value={t.id} />
                        <button
                          type="submit"
                          className="text-muted-foreground hover:text-foreground mt-0.5"
                          title="標記完成"
                        >
                          <Circle className="size-4" />
                        </button>
                      </form>
                      <span className="truncate">{t.title}</span>
                      {t.due && (
                        <Badge
                          variant={overdue ? "destructive" : "secondary"}
                          className="ml-auto shrink-0"
                        >
                          {overdue ? "逾期 " : ""}
                          {t.due.toISOString().slice(5, 10)}
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* projects */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FolderKanban className="size-4" /> 進行中的專案
              <Link
                href="/projects"
                className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs font-normal"
              >
                全部專案 <ArrowRight className="size-3" />
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activeProjects.length === 0 ? (
              <p className="text-muted-foreground text-sm">目前沒有進行中的專案。</p>
            ) : (
              <ul className="space-y-2">
                {activeProjects.slice(0, 5).map((p) => (
                  <li key={p.id}>
                    <Link
                      href={`/projects/${p.id}`}
                      className="flex items-center gap-2 text-sm hover:underline"
                    >
                      <span className="truncate font-medium">{p.name}</span>
                      <Badge variant="outline" className="ml-auto shrink-0">
                        {p.openTodos} 未完成
                      </Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* recent conversations */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleCheckBig className="size-4" /> 最近的對話
            </CardTitle>
          </CardHeader>
          <CardContent>
            {threads.length === 0 ? (
              <p className="text-muted-foreground text-sm">還沒有對話。</p>
            ) : (
              <ul className="space-y-1.5">
                {threads.slice(0, 6).map((t) => (
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
          </CardContent>
        </Card>

        <TelegramCard
          linked={tgLink !== null}
          botUsername={process.env.TELEGRAM_BOT_USERNAME ?? null}
        />
      </div>
    </main>
  );
}
