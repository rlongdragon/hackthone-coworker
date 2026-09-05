import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { getMembership } from "@/lib/project-store";
import { createMeetingRecord, listMeetingRecords } from "@/lib/meeting-store";
import { asUuid } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

async function memberGate(ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.id) return { err: new Response("Unauthorized", { status: 401 }) };
  const projectId = asUuid((await ctx.params).id);
  if (!projectId) return { err: new Response("Not found", { status: 404 }) };
  const membership = await getMembership(projectId, session.user.id);
  if (!membership) return { err: new Response("Not found", { status: 404 }) };
  return { userId: session.user.id, projectId };
}

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await memberGate(ctx);
  if ("err" in gate) return gate.err;
  return NextResponse.json(await listMeetingRecords(gate.projectId));
}

// multipart: `file` (audio → self-hosted ASR) and/or `transcript` (pasted text)
export async function POST(req: Request, ctx: Ctx) {
  const gate = await memberGate(ctx);
  if ("err" in gate) return gate.err;
  const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, gate.projectId)).limit(1);
  if (p?.status !== "active") return new Response("Project archived", { status: 409 });
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > 101 * 1024 * 1024) return new Response("Too large", { status: 413 });

  const form = await req.formData().catch(() => null);
  if (!form) return new Response("Bad form", { status: 400 });
  const file = form.get("file");
  const transcript = String(form.get("transcript") ?? "");
  const audio =
    file instanceof File && file.size > 0
      ? { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name }
      : undefined;

  const r = await createMeetingRecord({ projectId: gate.projectId, createdBy: gate.userId, transcript, audio });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json(r.record, { status: 201 });
}
