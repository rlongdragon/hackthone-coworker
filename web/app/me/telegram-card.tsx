"use client";

import { useState, useTransition } from "react";
import { Send } from "lucide-react";
import {
  generateTelegramLinkCode,
  unlinkTelegramAction,
} from "@/lib/telegram-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function TelegramCard({
  linked,
  botUsername,
}: {
  linked: boolean;
  botUsername: string | null;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="size-4" /> Telegram
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {linked ? (
          <>
            <p>已綁定 Telegram — 私訊 bot 即可與你的 AI 同事對話。</p>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => startTransition(() => unlinkTelegramAction())}
            >
              解除綁定
            </Button>
          </>
        ) : code ? (
          <>
            <p>
              在 Telegram 私訊
              {botUsername ? (
                <>
                  {" "}
                  <a
                    href={`https://t.me/${botUsername}`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    @{botUsername}
                  </a>{" "}
                </>
              ) : (
                " bot "
              )}
              並送出:
            </p>
            <p className="bg-muted rounded px-3 py-2 font-mono text-base tracking-wider">
              /link {code}
            </p>
            <p className="text-muted-foreground text-xs">
              10 分鐘內有效、只能用一次。過期就再按一次產生。
            </p>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              綁定後可在 Telegram 直接與你的 AI 同事對話。
            </p>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const r = await generateTelegramLinkCode();
                  setCode(r.code);
                })
              }
            >
              產生綁定碼
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
