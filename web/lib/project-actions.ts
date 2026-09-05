"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, not, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { auditLog, employees, projectMembers, projects, todos } from "@/db/schema";
import { asDate, asUuid } from "@/lib/validate";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthenticated");
  return session.user.id;
}

async function isMember(projectId: string, employeeId: string) {
  const [m] = await db
    .select({ memberRole: projectMembers.memberRole })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.employeeId, employeeId),
      ),
    )
    .limit(1);
  return m ?? null;
}

async function isOwner(projectId: string, employeeId: string) {
  const m = await isMember(projectId, employeeId);
  return m?.memberRole === "owner";
}

async function isActiveProject(projectId: string) {
  const [p] = await db
    .select({ status: projects.status })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return p?.status === "active";
}

export type FormState = { error: string } | undefined;

export async function createProject(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const userId = await requireUserId();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  if (!name) return { error: "請填專案名稱。" };

  const projectId = await db.transaction(async (tx) => {
    const [p] = await tx
      .insert(projects)
      .values({ name, description, ownerId: userId })
      .returning({ id: projects.id });
    await tx.insert(projectMembers).values({
      projectId: p.id,
      employeeId: userId,
      memberRole: "owner",
    });
    await tx.insert(auditLog).values({
      employeeId: userId,
      action: "project.create",
      detail: { projectId: p.id, name },
    });
    return p.id;
  });
  revalidatePath("/projects");
  redirect(`/projects/${projectId}`);
}

export async function addMember(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const userId = await requireUserId();
  const projectId = asUuid(formData.get("projectId"));
  const email = String(formData.get("email") ?? "").toLowerCase().trim();
  if (!projectId || !email) return { error: "請填 email。" };
  if (!(await isOwner(projectId, userId))) return { error: "只有負責人可以加成員。" };
  if (!(await isActiveProject(projectId))) return { error: "專案已封存。" };

  const [emp] = await db
    .select({ id: employees.id })
    .from(employees)
    .where(eq(employees.email, email)) // emails are lowercased on account creation
    .limit(1);
  if (!emp) return { error: "找不到這個 email 的員工。" };
  if (await isMember(projectId, emp.id)) return { error: "已是成員。" };

  await db
    .insert(projectMembers)
    .values({ projectId, employeeId: emp.id })
    .onConflictDoNothing();
  await db.insert(auditLog).values({
    employeeId: userId,
    action: "project.member.add",
    detail: { projectId, memberId: emp.id },
  });
  revalidatePath(`/projects/${projectId}`);
}

export async function removeMember(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const projectId = asUuid(formData.get("projectId"));
  const memberId = asUuid(formData.get("memberId"));
  if (!projectId || !memberId) return;
  if (!(await isOwner(projectId, userId))) return;

  // Owners can never be removed (covers self and any future co-owner).
  await db
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.employeeId, memberId),
        not(eq(projectMembers.memberRole, "owner")),
      ),
    );
  await db.insert(auditLog).values({
    employeeId: userId,
    action: "project.member.remove",
    detail: { projectId, memberId },
  });
  revalidatePath(`/projects/${projectId}`);
}

export async function setProjectStatus(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const projectId = asUuid(formData.get("projectId"));
  const status = String(formData.get("status") ?? "");
  if (!projectId || !["active", "archived"].includes(status)) return;
  if (!(await isOwner(projectId, userId))) return;

  await db
    .update(projects)
    .set({ status: status as "active" | "archived", updatedAt: new Date() })
    .where(eq(projects.id, projectId));
  await db.insert(auditLog).values({
    employeeId: userId,
    action: "project.status",
    detail: { projectId, status },
  });
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
}

export async function addProjectTodo(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const userId = await requireUserId();
  const projectId = asUuid(formData.get("projectId"));
  const title = String(formData.get("title") ?? "").trim();
  const due = asDate(formData.get("due"));
  if (!projectId || !title) return { error: "請填待辦內容。" };
  if (!(await isMember(projectId, userId))) return { error: "不是專案成員。" };
  if (!(await isActiveProject(projectId))) return { error: "專案已封存。" };

  await db.insert(todos).values({ employeeId: userId, projectId, title, due });
  revalidatePath(`/projects/${projectId}`);
}

export async function toggleTodo(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const todoId = asUuid(formData.get("todoId"));
  if (!todoId) return;
  const [t] = await db
    .select({ id: todos.id, employeeId: todos.employeeId, projectId: todos.projectId })
    .from(todos)
    .where(eq(todos.id, todoId))
    .limit(1);
  if (!t) return;
  // Project todos require *current* membership (authorship alone is not enough
  // — a removed member must lose access); personal todos require ownership.
  const allowed = t.projectId
    ? Boolean(await isMember(t.projectId, userId)) &&
      (await isActiveProject(t.projectId))
    : t.employeeId === userId;
  if (!allowed) return;
  // Atomic flip — concurrent toggles each invert once instead of losing one.
  await db
    .update(todos)
    .set({ done: sql`not ${todos.done}` })
    .where(eq(todos.id, todoId));
  if (t.projectId) revalidatePath(`/projects/${t.projectId}`);
  revalidatePath("/me/todos");
  revalidatePath("/me"); // dashboard renders due todos too
}
