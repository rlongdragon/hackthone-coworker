"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, count, eq, ne } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { db } from "@/db";
import { employees, departments, auditLog } from "@/db/schema";

// All admin mutations go through this gate. Role is re-read from the DB —
// the JWT's role claim may be stale (demotion must apply immediately).
async function assertAdmin(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("forbidden");
  const [row] = await db
    .select({ role: employees.role })
    .from(employees)
    .where(eq(employees.id, session.user.id))
    .limit(1);
  if (row?.role !== "admin") throw new Error("forbidden");
  return { id: session.user.id };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asUuid(v: unknown): string | null {
  const s = String(v ?? "");
  return UUID_RE.test(s) ? s : null;
}

function tempPassword(): string {
  // 12 chars base64url — shown once to the admin, must be changed on first login.
  return randomBytes(9).toString("base64url");
}

async function audit(actorId: string, action: string, detail: unknown) {
  await db.insert(auditLog).values({ employeeId: actorId, action, detail });
}

export type CreateEmployeeState =
  | { error: string }
  | { ok: true; email: string; tempPassword: string }
  | undefined;

export async function createEmployee(
  _prev: CreateEmployeeState,
  formData: FormData,
): Promise<CreateEmployeeState> {
  const admin = await assertAdmin();
  const email = String(formData.get("email") ?? "").toLowerCase().trim();
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "employee");
  const departmentId = asUuid(formData.get("departmentId"));
  if (!email || !email.includes("@") || !name) {
    return { error: "請填寫 email 與姓名。" };
  }
  if (!["employee", "manager", "admin"].includes(role)) {
    return { error: "角色不合法。" };
  }

  const pw = tempPassword();
  const passwordHash = await bcrypt.hash(pw, 10);
  try {
    await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(employees)
        .values({
          email,
          name,
          passwordHash,
          role: role as "employee" | "manager" | "admin",
          departmentId,
          mustChangePassword: true,
        })
        .returning({ id: employees.id });
      await tx.insert(auditLog).values({
        employeeId: admin.id,
        action: "admin.employee.create",
        detail: { employeeId: u.id, email, role },
      });
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("employees_email_unique") || msg.includes("duplicate key")) {
      return { error: "此 email 已存在。" };
    }
    if (msg.includes("foreign key")) return { error: "部門不存在,請重新整理。" };
    console.error("createEmployee failed:", msg);
    return { error: "建立失敗,請再試一次。" };
  }
  revalidatePath("/admin");
  return { ok: true, email, tempPassword: pw };
}

export type ResetPasswordState =
  | { error: string }
  | { ok: true; tempPassword: string }
  | undefined;

export async function resetEmployeePassword(
  _prev: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const admin = await assertAdmin();
  const employeeId = asUuid(formData.get("employeeId"));
  if (!employeeId) return { error: "缺少員工 ID。" };
  const pw = tempPassword();
  const passwordHash = await bcrypt.hash(pw, 10);
  try {
    const found = await db.transaction(async (tx) => {
      const updated = await tx
        .update(employees)
        .set({ passwordHash, mustChangePassword: true })
        .where(eq(employees.id, employeeId))
        .returning({ id: employees.id });
      if (updated.length === 0) return false;
      await tx.insert(auditLog).values({
        employeeId: admin.id,
        action: "admin.employee.resetPassword",
        detail: { employeeId },
      });
      return true;
    });
    if (!found) return { error: "找不到員工。" };
  } catch (e) {
    console.error("resetEmployeePassword failed:", e);
    return { error: "重設失敗,請再試一次。" };
  }
  revalidatePath("/admin");
  return { ok: true, tempPassword: pw };
}

export async function updateEmployee(formData: FormData): Promise<void> {
  const admin = await assertAdmin();
  const employeeId = asUuid(formData.get("employeeId"));
  const role = String(formData.get("role") ?? "");
  const departmentId = asUuid(formData.get("departmentId"));
  if (!employeeId || !["employee", "manager", "admin"].includes(role)) return;

  try {
    await db.transaction(async (tx) => {
      // Never demote the last admin — that locks everyone out of /admin.
      if (role !== "admin") {
        const [{ others }] = await tx
          .select({ others: count() })
          .from(employees)
          .where(and(eq(employees.role, "admin"), ne(employees.id, employeeId)));
        const [current] = await tx
          .select({ role: employees.role })
          .from(employees)
          .where(eq(employees.id, employeeId))
          .limit(1);
        if (current?.role === "admin" && others === 0) {
          throw new Error("last-admin");
        }
      }
      await tx
        .update(employees)
        .set({ role: role as "employee" | "manager" | "admin", departmentId })
        .where(eq(employees.id, employeeId));
      await tx.insert(auditLog).values({
        employeeId: admin.id,
        action: "admin.employee.update",
        detail: { employeeId, role, departmentId },
      });
    });
  } catch (e) {
    // last-admin guard or FK violation — refuse silently, table re-renders truth.
    console.warn("updateEmployee refused:", e instanceof Error ? e.message : e);
  }
  revalidatePath("/admin");
}

export type DeptState = { error: string } | undefined;

export async function createDepartment(
  _prev: DeptState,
  formData: FormData,
): Promise<DeptState> {
  const admin = await assertAdmin();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "請填部門名稱。" };
  const [d] = await db.insert(departments).values({ name }).returning({ id: departments.id });
  await audit(admin.id, "admin.department.create", { departmentId: d.id, name });
  revalidatePath("/admin");
}

export async function deleteDepartment(formData: FormData): Promise<void> {
  const admin = await assertAdmin();
  const departmentId = asUuid(formData.get("departmentId"));
  if (!departmentId) return;
  let deleted = false;
  try {
    const rows = await db
      .delete(departments)
      .where(eq(departments.id, departmentId))
      .returning({ id: departments.id });
    deleted = rows.length > 0;
  } catch {
    // FK restrict: department still has employees/projects — leave it, UI shows count.
  }
  if (deleted) {
    await audit(admin.id, "admin.department.delete", { departmentId });
  }
  revalidatePath("/admin");
}
