import { type UIMessage } from "ai";
import { after } from "next/server";
import { auth } from "@/auth";
import { runAgentTurn, textOf } from "@/lib/agent-run";
import { maybeAutoTitle } from "@/lib/chat-store";

export const maxDuration = 60;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }
  const employeeId = session.user.id;

  // chatId comes from our transport body (stable per thread); the runtime's own
  // `id` is an internal local id that changes per mount — never trust it as key.
  const {
    id,
    chatId: bodyChatId,
    projectId: bodyProjectId,
    messages,
  }: {
    id?: string;
    chatId?: string;
    projectId?: string;
    messages: UIMessage[];
  } = await req.json();

  const turn = await runAgentTurn({
    employeeId,
    chatId: bodyChatId ?? id ?? "",
    messages,
    requestedProjectId: bodyProjectId ?? null,
    channel: "web",
  });
  if (!turn.ok) {
    return new Response(turn.message, { status: turn.status });
  }

  return turn.result.toUIMessageStreamResponse({
    // Surface a readable message instead of the client's generic
    // "An error occurred" when the model/provider fails mid-stream.
    onError: (error) => {
      console.error("chat stream error:", error);
      return "抱歉,處理時發生錯誤,請再試一次或換個說法。";
    },
    onFinish: async ({ responseMessage }) => {
      try {
        await turn.saveAssistant(responseMessage.parts);
      } catch (e) {
        // conversation may have been deleted mid-stream — drop, don't crash
        console.warn("saveMessage failed:", e instanceof Error ? e.message : e);
        return;
      }
      // after(): keep the title generation alive past the response lifecycle
      after(() =>
        maybeAutoTitle(
          turn.conv.id,
          turn.conv.title,
          turn.lastUserText,
          textOf(responseMessage),
        ),
      );
    },
  });
}
