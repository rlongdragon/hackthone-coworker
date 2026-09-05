import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { listProjectFiles, saveProjectFile } from "@/lib/file-store";
import { getMembership } from "@/lib/project-store";
import { asUuid } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

async function memberGate(ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.id) return { err: new Response("Unauthorized", { status: 401 }) };
  const projectId = asUuid((await ctx.params).id);
  if (!projectId) return { err: new Response("Not found", { status: 404 }) };
  const membership = await getMembership(projectId, session.user.id);
  if (!membership) return { err: new Response("Not found", { status: 404 }) };
  return { userId: session.user.id, projectId, membership };
}

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await memberGate(ctx);
  if ("err" in gate) return gate.err;
  const files = await listProjectFiles(gate.projectId);
  return NextResponse.json(
    files.map((f) => ({
      id: f.id,
      filename: f.filename,
      mime: f.mime,
      size: f.size,
      uploaderId: f.uploaderId,
      uploaderName: f.uploaderName,
      createdAt: f.createdAt.toISOString(),
    })),
  );
}

export async function POST(req: Request, ctx: Ctx) {
  const gate = await memberGate(ctx);
  if ("err" in gate) return gate.err;

  const [p] = await db
    .select({ status: projects.status })
    .from(projects)
    .where(eq(projects.id, gate.projectId))
    .limit(1);
  if (p?.status !== "active") {
    return new Response("Project archived", { status: 409 });
  }

  // Reject oversized bodies before formData() buffers them into memory.
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > 21 * 1024 * 1024) {
    return new Response("Too large", { status: 413 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return new Response("No file", { status: 400 });

  const result = await saveProjectFile(gate.projectId, gate.userId, file);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ id: result.id }, { status: 201 });
}
