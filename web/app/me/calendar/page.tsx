import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireEmployee } from "@/lib/authz";
import { CalendarClient } from "./calendar-client";

export default async function CalendarPage() {
  await requireEmployee();
  return (
    <main className="w-full mx-auto max-w-6xl p-6">
      <div className="mb-4 flex items-center gap-3">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> 回聊天
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">行事曆</h1>
        <p className="text-muted-foreground ml-auto text-xs">
          拖曳空白處建立事件.點事件看詳情、記筆記
        </p>
      </div>
      <CalendarClient />
    </main>
  );
}
