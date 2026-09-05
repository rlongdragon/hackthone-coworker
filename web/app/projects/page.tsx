import Link from "next/link";
import { ArrowLeft, FolderKanban } from "lucide-react";
import { requireEmployee } from "@/lib/authz";
import { listMyProjects } from "@/lib/project-store";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CreateProjectForm } from "./projects-client";

export default async function ProjectsPage() {
  const user = await requireEmployee();
  const list = await listMyProjects(user.id);
  const active = list.filter((p) => p.status === "active");
  const archived = list.filter((p) => p.status === "archived");

  return (
    <main className="w-full mx-auto max-w-4xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> 回聊天
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">專案</h1>
      </div>

      <CreateProjectForm />

      {active.length === 0 && archived.length === 0 && (
        <div className="text-muted-foreground mt-10 flex flex-col items-center gap-2 text-sm">
          <FolderKanban className="size-8 opacity-40" />
          <p>還沒有專案。建立第一個,或請同事把你加進去。</p>
        </div>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {active.map((p) => (
          <Link key={p.id} href={`/projects/${p.id}`} className="group">
            <Card className="h-full transition-colors group-hover:border-foreground/20">
              <CardHeader>
                <CardTitle className="text-base">{p.name}</CardTitle>
                {p.description && (
                  <CardDescription className="line-clamp-2">
                    {p.description}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="flex gap-2">
                <Badge variant="secondary">{p.memberCount} 成員</Badge>
                <Badge variant={p.openTodos > 0 ? "default" : "outline"}>
                  {p.openTodos} 未完成
                </Badge>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {archived.length > 0 && (
        <>
          <h2 className="text-muted-foreground mt-10 mb-3 text-sm font-medium">
            已封存
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {archived.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`} className="group">
                <Card className="h-full opacity-60 transition-opacity group-hover:opacity-100">
                  <CardHeader>
                    <CardTitle className="text-base">{p.name}</CardTitle>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
