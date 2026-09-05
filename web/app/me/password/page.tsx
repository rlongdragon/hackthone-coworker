import { eq } from "drizzle-orm";
import { requireEmployee } from "@/lib/authz";
import { db } from "@/db";
import { employees } from "@/db/schema";
import { PasswordForm } from "./password-form";

export default async function PasswordPage() {
  const user = await requireEmployee({ skipPasswordGate: true });
  const [row] = await db
    .select({ mustChange: employees.mustChangePassword })
    .from(employees)
    .where(eq(employees.id, user.id))
    .limit(1);

  return (
    <main className="grid min-h-dvh place-items-center bg-muted/40 p-6">
      <div className="w-full max-w-sm">
        <div className="bg-card rounded-lg border p-6 shadow-sm">
          <h1 className="text-lg font-semibold">變更密碼</h1>
          {row?.mustChange ? (
            <p className="mt-1 mb-4 text-sm text-amber-600">
              你正在使用公司發放的臨時密碼,請先設定新密碼。
            </p>
          ) : (
            <p className="text-muted-foreground mt-1 mb-4 text-sm">
              設定一組新密碼(至少 8 碼)。
            </p>
          )}
          <PasswordForm />
        </div>
      </div>
    </main>
  );
}
