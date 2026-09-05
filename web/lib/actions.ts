"use server";

import { AuthError } from "next-auth";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { auth, signIn } from "@/auth";
import { db } from "@/db";
import { employees, auditLog } from "@/db/schema";

export async function authenticate(
  _prev: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/",
    });
  } catch (e) {
    if (e instanceof AuthError) return "帳號或密碼錯誤。";
    throw e; // redirect signal
  }
}

// Accounts are company-issued (no self-registration). Employees change their
// own password here; forced on first login when mustChangePassword is set.
export async function changePassword(
  _prev: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const session = await auth();
  if (!session?.user?.id) return "請先登入。";
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (next.length < 8) return "新密碼至少 8 碼。";
  if (next !== confirm) return "兩次輸入的新密碼不一致。";
  if (next === current) return "新密碼不能與目前密碼相同。";

  const [u] = await db
    .select({ id: employees.id, passwordHash: employees.passwordHash })
    .from(employees)
    .where(eq(employees.id, session.user.id))
    .limit(1);
  if (!u) return "找不到帳號。";
  const ok = await bcrypt.compare(current, u.passwordHash);
  if (!ok) return "目前密碼錯誤。";

  await db
    .update(employees)
    .set({
      passwordHash: await bcrypt.hash(next, 10),
      mustChangePassword: false,
    })
    .where(eq(employees.id, u.id));
  await db.insert(auditLog).values({
    employeeId: u.id,
    action: "employee.changePassword",
    detail: null,
  });
  return undefined;
}
