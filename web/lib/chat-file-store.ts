import { mkdir, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, chatFiles } from "@/db/schema";

// Agent-produced files handed back to the employee in chat. Bytes live under
// UPLOAD_DIR/chat keyed by row id; served by /api/files/[id] to the owning
// employee only. Same disk-storage philosophy as project files (self-hosted).
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");
const CHAT_DIR = path.join(UPLOAD_DIR, "chat");

export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024; // 20MB

function diskPath(id: string): string {
  return path.join(CHAT_DIR, id);
}

// For non-HTTP consumers (telegram worker) that upload the bytes elsewhere.
export function chatFileDiskPath(id: string): string {
  return diskPath(id);
}

export async function saveChatFile(
  employeeId: string,
  conversationId: string,
  filename: string,
  mime: string,
  bytes: Buffer,
): Promise<{ id: string } | { error: string }> {
  if (bytes.length === 0) return { error: "empty file" };
  if (bytes.length > MAX_CHAT_FILE_BYTES) return { error: "file exceeds 20MB" };
  const safeName = path.basename(filename).slice(0, 255) || "file";
  const safeMime = /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : "application/octet-stream";

  const [row] = await db
    .insert(chatFiles)
    .values({ employeeId, conversationId, filename: safeName, mime: safeMime, size: bytes.length })
    .returning({ id: chatFiles.id });
  try {
    await mkdir(CHAT_DIR, { recursive: true });
    await writeFile(diskPath(row.id), bytes);
  } catch (e) {
    await db.delete(chatFiles).where(eq(chatFiles.id, row.id));
    console.error("chat file write failed:", e);
    return { error: "storage failed" };
  }
  await db.insert(auditLog).values({
    employeeId,
    action: "agent.chatFile.deliver",
    detail: { conversationId, fileId: row.id, filename: safeName, size: bytes.length },
  });
  return { id: row.id };
}

export async function getChatFile(id: string) {
  const [row] = await db.select().from(chatFiles).where(eq(chatFiles.id, id)).limit(1);
  return row ?? null;
}

export function openChatFileStream(id: string): ReadableStream | null {
  const p = diskPath(id);
  if (!existsSync(p)) return null;
  const rs = createReadStream(p);
  rs.on("error", () => rs.destroy());
  return Readable.toWeb(rs) as ReadableStream;
}
