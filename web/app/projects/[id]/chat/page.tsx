import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireEmployee } from "@/lib/authz";
import { getProject } from "@/lib/project-store";
import { getOrCreateProjectChannel, listMessages } from "@/lib/channel-store";
import { ChannelClient } from "./channel-client";

// Project channel: members only (getProject returns null for non-members).
export default async function ProjectChatPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireEmployee();
  const { id } = await params;
  const data = await getProject(id, user.id);
  if (!data) notFound();
  const ch = await getOrCreateProjectChannel(data.project.id, user.id);
  const initial = await listMessages(ch.id, { limit: 50 });
  return (
    <main className="mx-auto w-full max-w-3xl p-6">
      <div className="mb-4 flex items-center gap-3">
        <Link href={`/projects/${data.project.id}`} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="size-4" /> {data.project.name}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">#general · 專案頻道</h1>
        <span className="text-muted-foreground ml-auto text-xs">成員 {data.members.length} 人</span>
      </div>
      <ChannelClient projectId={data.project.id} initial={initial} myId={user.id} />
    </main>
  );
}
