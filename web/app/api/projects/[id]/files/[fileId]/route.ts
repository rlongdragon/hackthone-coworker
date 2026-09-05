import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  deleteProjectFile,
  getProjectFile,
  openFileStream,
} from "@/lib/file-store";
import { getMembership } from "@/lib/project-store";
import { asUuid } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string; fileId: string }> };

async function fileGate(ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.id) return { err: new Response("Unauthorized", { status: 401 }) };
  const { id, fileId: rawFileId } = await ctx.params;
  const projectId = asUuid(id);
  const fileId = asUuid(rawFileId);
  if (!projectId || !fileId) return { err: new Response("Not found", { status: 404 }) };
  const membership = await getMembership(projectId, session.user.id);
  if (!membership) return { err: new Response("Not found", { status: 404 }) };
  const file = await getProjectFile(fileId);
  if (!file || file.projectId !== projectId) {
    return { err: new Response("Not found", { status: 404 }) };
  }
  return { userId: session.user.id, membership, file };
}

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await fileGate(ctx);
  if ("err" in gate) return gate.err;
  const stream = openFileStream(gate.file.id);
  if (!stream) return new Response("File data missing", { status: 410 });
  return new NextResponse(stream, {
    headers: {
      "Content-Type": gate.file.mime,
      "Content-Length": String(gate.file.size),
      // RFC 5987 encoding — filenames are UTF-8 (Chinese names common here);
      // encodeURIComponent leaves '()* unescaped, which are invalid in an
      // ext-value, so escape them too. Plain filename= is the ASCII fallback.
      "Content-Disposition":
        `attachment; filename="${gate.file.filename.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; ` +
        `filename*=UTF-8''${encodeURIComponent(gate.file.filename).replace(
          /['()*]/g,
          (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
        )}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const gate = await fileGate(ctx);
  if ("err" in gate) return gate.err;
  // Uploader can delete their own file; project owner can delete any.
  const allowed =
    gate.file.uploaderId === gate.userId ||
    gate.membership.memberRole === "owner";
  if (!allowed) return new Response("Forbidden", { status: 403 });
  await deleteProjectFile(gate.file.id, gate.userId);
  return NextResponse.json({ ok: true });
}
