import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getChatFile, openChatFileStream } from "@/lib/chat-file-store";
import { asUuid } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

// Download an agent-delivered chat file. Only the employee the file belongs to
// may fetch it (files are personal, never shared across accounts).
export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const id = asUuid((await ctx.params).id);
  if (!id) return new Response("Not found", { status: 404 });
  const file = await getChatFile(id);
  if (!file || file.employeeId !== session.user.id) {
    return new Response("Not found", { status: 404 });
  }
  const stream = openChatFileStream(file.id);
  if (!stream) return new Response("File data missing", { status: 410 });
  return new NextResponse(stream, {
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(file.size),
      // RFC 5987 — filenames are UTF-8 (Chinese common); ASCII fallback + ext-value.
      "Content-Disposition":
        `attachment; filename="${file.filename.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; ` +
        `filename*=UTF-8''${encodeURIComponent(file.filename).replace(
          /['()*]/g,
          (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
        )}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
