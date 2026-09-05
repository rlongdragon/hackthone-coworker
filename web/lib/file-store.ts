import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, employees, projectFiles } from "@/db/schema";

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB
export const MAX_FILES_PER_PROJECT = 100;
export const MAX_PROJECT_BYTES = 200 * 1024 * 1024; // 200MB per project

// Local-disk storage (self-hosted). Bytes live under UPLOAD_DIR keyed by row
// id; the original filename only exists in the DB row.
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");

function diskPath(fileId: string): string {
  return path.join(UPLOAD_DIR, fileId);
}

// Host path of a stored blob — for handing project files to the sandbox
// (docker cp). Callers must have already authorized access to the file.
export function fileDiskPath(fileId: string): string {
  return diskPath(fileId);
}

export async function saveProjectFile(
  projectId: string,
  uploaderId: string,
  file: File,
): Promise<{ id: string } | { error: string }> {
  if (file.size === 0) return { error: "空檔案。" };
  if (file.size > MAX_FILE_BYTES) return { error: "檔案超過 20MB 上限。" };

  // Per-project quotas — one member must not be able to fill the disk.
  const existing = await db
    .select({ size: projectFiles.size })
    .from(projectFiles)
    .where(eq(projectFiles.projectId, projectId));
  if (existing.length >= MAX_FILES_PER_PROJECT) {
    return { error: `專案檔案數已達上限(${MAX_FILES_PER_PROJECT})。` };
  }
  const used = existing.reduce((s, f) => s + f.size, 0);
  if (used + file.size > MAX_PROJECT_BYTES) {
    return { error: "專案儲存空間已滿(200MB)。" };
  }

  const filename = path.basename(file.name || "file").slice(0, 255);
  // Client-controlled — normalize to a syntactically valid media type; it is
  // echoed back as Content-Type on download.
  const rawMime = (file.type || "").slice(0, 120);
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(rawMime)
    ? rawMime
    : "application/octet-stream";

  const [row] = await db
    .insert(projectFiles)
    .values({ projectId, uploaderId, filename, mime, size: file.size })
    .returning({ id: projectFiles.id });
  try {
    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(diskPath(row.id), Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    await db.delete(projectFiles).where(eq(projectFiles.id, row.id));
    console.error("file write failed:", e);
    return { error: "儲存失敗,請再試一次。" };
  }
  await db.insert(auditLog).values({
    employeeId: uploaderId,
    action: "project.file.upload",
    detail: { projectId, fileId: row.id, filename, size: file.size },
  });
  return { id: row.id };
}

export async function listProjectFiles(projectId: string) {
  return db
    .select({
      id: projectFiles.id,
      filename: projectFiles.filename,
      mime: projectFiles.mime,
      size: projectFiles.size,
      createdAt: projectFiles.createdAt,
      uploaderId: projectFiles.uploaderId,
      uploaderName: employees.name,
    })
    .from(projectFiles)
    .innerJoin(employees, eq(projectFiles.uploaderId, employees.id))
    .where(eq(projectFiles.projectId, projectId))
    .orderBy(desc(projectFiles.createdAt));
}

export async function getProjectFile(fileId: string) {
  const [row] = await db
    .select()
    .from(projectFiles)
    .where(eq(projectFiles.id, fileId))
    .limit(1);
  return row ?? null;
}

// Read a file's bytes as UTF-8 text, capped — for the agent's file-reading
// tool. null if the blob is missing on disk.
export async function readFileText(
  fileId: string,
  charCap: number,
): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  try {
    const buf = await readFile(diskPath(fileId));
    return buf.toString("utf8").slice(0, charCap);
  } catch {
    return null; // deleted between row lookup and read
  }
}

// Web ReadableStream over the on-disk bytes; null if the blob is missing.
// A concurrent delete after this check surfaces as a stream error, which
// terminates the response — acceptable for the race window.
export function openFileStream(fileId: string): ReadableStream | null {
  const p = diskPath(fileId);
  if (!existsSync(p)) return null;
  const rs = createReadStream(p);
  rs.on("error", () => rs.destroy());
  return Readable.toWeb(rs) as ReadableStream;
}

export async function deleteProjectFile(
  fileId: string,
  actorId: string,
): Promise<boolean> {
  const rows = await db
    .delete(projectFiles)
    .where(eq(projectFiles.id, fileId))
    .returning({ id: projectFiles.id, projectId: projectFiles.projectId });
  if (rows.length === 0) return false;
  await unlink(diskPath(fileId)).catch(() => {}); // row is source of truth
  await db.insert(auditLog).values({
    employeeId: actorId,
    action: "project.file.delete",
    detail: { projectId: rows[0].projectId, fileId },
  });
  return true;
}
