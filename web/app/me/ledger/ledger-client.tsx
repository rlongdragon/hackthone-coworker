"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { markAllReadAction } from "@/lib/notification-actions";

export function MarkAllReadButton({ unread }: { unread: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (unread === 0) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await markAllReadAction();
          router.refresh();
        })
      }
    >
      {pending ? "處理中…" : `全部標為已讀 (${unread})`}
    </Button>
  );
}
