"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { conversations } from "@/db/schema";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthenticated");
  return session.user.id;
}

export async function renameThread(chatId: string, title: string): Promise<void> {
  const userId = await requireUserId();
  const clean = title.trim().slice(0, 60);
  if (!chatId || !clean) return;
  await db
    .update(conversations)
    .set({ title: clean })
    .where(
      and(eq(conversations.chatId, chatId), eq(conversations.employeeId, userId)),
    );
  revalidatePath("/");
}

export async function deleteThread(chatId: string): Promise<void> {
  const userId = await requireUserId();
  if (!chatId) return;
  // messages cascade via conversation FK
  await db
    .delete(conversations)
    .where(
      and(eq(conversations.chatId, chatId), eq(conversations.employeeId, userId)),
    );
  revalidatePath("/");
}
