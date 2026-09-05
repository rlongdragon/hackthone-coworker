"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { todos } from "@/db/schema";
import { asDate, asUuid } from "@/lib/validate";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthenticated");
  return session.user.id;
}

export type TodoFormState = { error: string } | undefined;

export async function addPersonalTodo(
  _prev: TodoFormState,
  formData: FormData,
): Promise<TodoFormState> {
  const userId = await requireUserId();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { error: "請填待辦內容。" };
  if (title.length > 200) return { error: "太長了,精簡一點。" };
  await db.insert(todos).values({
    employeeId: userId,
    title,
    due: asDate(formData.get("due")),
  });
  revalidatePath("/me/todos");
}

export async function deleteTodo(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const todoId = asUuid(formData.get("todoId"));
  if (!todoId) return;
  // Personal scope only — project todos are managed from the project page,
  // and the isNull guard enforces that server-side, not just in the UI.
  await db
    .delete(todos)
    .where(
      and(
        eq(todos.id, todoId),
        eq(todos.employeeId, userId),
        isNull(todos.projectId),
      ),
    );
  revalidatePath("/me/todos");
}
