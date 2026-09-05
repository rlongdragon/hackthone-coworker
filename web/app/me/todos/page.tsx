import Link from "next/link";
import { asc, desc, eq } from "drizzle-orm";
import { ArrowLeft, Circle, CircleCheckBig, Trash2 } from "lucide-react";
import { requireEmployee } from "@/lib/authz";
import { db } from "@/db";
import { projects, todos } from "@/db/schema";
import { toggleTodo } from "@/lib/project-actions";
import { deleteTodo } from "@/lib/todo-actions";
import { Badge } from "@/components/ui/badge";
import { AddTodoForm } from "./add-todo-form";

const TZ_OFFSET_MS = 8 * 3600 * 1000;

function todayStart(): Date {
  const label = new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
  return new Date(new Date(label + "T00:00:00Z").getTime() - TZ_OFFSET_MS);
}

export default async function MyTodosPage() {
  const user = await requireEmployee();
  const rows = await db
    .select({
      id: todos.id,
      title: todos.title,
      due: todos.due,
      done: todos.done,
      projectId: todos.projectId,
      projectName: projects.name,
    })
    .from(todos)
    .leftJoin(projects, eq(todos.projectId, projects.id))
    .where(eq(todos.employeeId, user.id))
    .orderBy(asc(todos.done), asc(todos.due), desc(todos.createdAt));

  const open = rows.filter((t) => !t.done);
  const done = rows.filter((t) => t.done);
  const dayStart = todayStart();

  function Row({ t }: { t: (typeof rows)[number] }) {
    const overdue = !t.done && t.due && t.due < dayStart;
    return (
      <li className="group flex items-center gap-2.5 px-3 py-2 text-sm">
        <form action={toggleTodo}>
          <input type="hidden" name="todoId" value={t.id} />
          <button
            type="submit"
            className="text-muted-foreground hover:text-foreground mt-0.5"
            title={t.done ? "標記未完成" : "標記完成"}
          >
            {t.done ? (
              <CircleCheckBig className="size-4 text-emerald-600" />
            ) : (
              <Circle className="size-4" />
            )}
          </button>
        </form>
        <span className={t.done ? "text-muted-foreground line-through" : ""}>
          {t.title}
        </span>
        {t.projectName && t.projectId && (
          <Link href={`/projects/${t.projectId}`}>
            <Badge variant="outline" className="shrink-0">
              {t.projectName}
            </Badge>
          </Link>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {t.due && (
            <Badge variant={overdue ? "destructive" : "secondary"}>
              {overdue ? "逾期 " : ""}
              {t.due.toISOString().slice(5, 10)}
            </Badge>
          )}
          {!t.projectId && (
            <form action={deleteTodo}>
              <input type="hidden" name="todoId" value={t.id} />
              <button
                type="submit"
                className="text-muted-foreground hover:text-destructive opacity-0 transition-opacity group-hover:opacity-100"
                title="刪除"
              >
                <Trash2 className="size-3.5" />
              </button>
            </form>
          )}
        </span>
      </li>
    );
  }

  return (
    <main className="w-full mx-auto max-w-2xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> 回聊天
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">我的待辦</h1>
        <p className="text-muted-foreground ml-auto text-sm">
          {open.length} 未完成
        </p>
      </div>

      <AddTodoForm />

      {rows.length === 0 ? (
        <p className="text-muted-foreground mt-8 text-center text-sm">
          還沒有待辦。在上面新增,或直接跟 Coworker 說。
        </p>
      ) : (
        <div className="mt-4 space-y-6">
          <ul className="divide-y rounded-lg border">
            {open.length === 0 && (
              <li className="text-muted-foreground px-3 py-4 text-center text-sm">
                全部完成 🎉
              </li>
            )}
            {open.map((t) => (
              <Row key={t.id} t={t} />
            ))}
          </ul>
          {done.length > 0 && (
            <div>
              <p className="text-muted-foreground mb-2 text-xs font-medium">
                已完成 {done.length}
              </p>
              <ul className="divide-y rounded-lg border opacity-70">
                {done.map((t) => (
                  <Row key={t.id} t={t} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
