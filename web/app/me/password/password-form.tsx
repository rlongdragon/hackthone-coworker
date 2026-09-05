"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { changePassword } from "@/lib/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function PasswordForm() {
  const router = useRouter();
  const [state, action, pending] = useActionState(
    async (prev: string | undefined, formData: FormData) => {
      const err = await changePassword(prev, formData);
      return err ?? "__ok__";
    },
    undefined,
  );

  useEffect(() => {
    if (state === "__ok__") router.replace("/");
  }, [state, router]);

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="current">目前密碼</Label>
        <Input
          id="current"
          name="current"
          type="password"
          required
          autoComplete="current-password"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="next">新密碼</Label>
        <Input
          id="next"
          name="next"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">確認新密碼</Label>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
        />
      </div>
      {state && state !== "__ok__" && (
        <p className="text-destructive text-sm">{state}</p>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "更新中…" : "更新密碼"}
      </Button>
    </form>
  );
}
