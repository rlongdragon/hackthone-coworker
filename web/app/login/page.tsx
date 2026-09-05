"use client";

import { useActionState } from "react";
import { authenticate } from "@/lib/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function LoginForm() {
  const [error, action, pending] = useActionState(authenticate, undefined);

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@company.com"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">密碼</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="••••••••"
        />
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "登入中…" : "登入"}
      </Button>
      <p className="text-muted-foreground text-center text-xs">
        帳號由公司管理員發放。忘記密碼請聯絡管理員。
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-muted/40 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="bg-primary text-primary-foreground mx-auto mb-3 grid size-11 place-items-center rounded-lg text-lg font-bold">
            C!
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Coworker!</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            你的 AI 同事在等你。
          </p>
        </div>
        <div className="bg-card rounded-lg border p-6 shadow-sm">
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
