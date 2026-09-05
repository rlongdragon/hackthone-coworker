// Edit-based streaming to Telegram, after hermes-agent's stream_consumer:
// send one message early, then progressively editMessageText as deltas arrive,
// throttled to stay under flood control; the finalize edit applies real
// formatting (HTML) and splits overflow into follow-up messages.
import { GrammyError, type Context } from "grammy";
import { mdToTelegramHtml, splitMessage } from "./format";

const EDIT_INTERVAL_MS = 1000; // hermes: 0.8s; stay a hair safer
const BUFFER_THRESHOLD = 24; // don't edit for fewer than this many new chars
const MIN_FIRST_CHARS = 4; // don't open a message for a 1-2 token stutter
const CURSOR = " ▍"; // typing cursor shown while streaming
// Preview cap under Telegram's 4096: once reached, stop editing (every further
// edit would be the identical truncated text — repeating those is what gets a
// bot flood-limited) and let finalize deliver the full text in chunks.
const PREVIEW_CAP = 3900;

export type StreamedReply = { text: string; sent: boolean };

export async function streamReply(
  ctx: Context,
  textStream: AsyncIterable<string>,
): Promise<StreamedReply> {
  const chatId = ctx.chat!.id;
  let full = "";
  let messageId: number | null = null;
  let lastSent = "";
  let lastLen = 0;
  let notBefore = 0; // next moment an edit is allowed (throttle / 429 backoff)
  let saturated = false;

  const preview = (): string => {
    if (full.length > PREVIEW_CAP) {
      saturated = true;
      return full.slice(0, PREVIEW_CAP) + "…";
    }
    return full + CURSOR;
  };

  const sendOpts = {
    parse_mode: "HTML" as const,
    link_preview_options: { is_disabled: true },
  };

  async function maybeEdit(): Promise<void> {
    const now = Date.now();
    if (now < notBefore) return;
    if (full.length - lastLen < BUFFER_THRESHOLD) return;
    const t = preview();
    if (t === lastSent) return; // saturated: identical truncation — skip
    try {
      if (messageId === null) {
        if (full.trim().length < MIN_FIRST_CHARS) return;
        // Plain text during the stream — mid-stream markdown is unbalanced
        // (open fences, half bold markers); real formatting lands on finalize.
        const m = await ctx.reply(t);
        messageId = m.message_id;
      } else {
        await ctx.api.editMessageText(chatId, messageId, t);
      }
      lastSent = t;
      lastLen = full.length;
      notBefore = now + EDIT_INTERVAL_MS;
    } catch (e) {
      if (e instanceof GrammyError) {
        if (e.description.includes("message is not modified")) {
          lastSent = t;
          notBefore = now + EDIT_INTERVAL_MS;
          return;
        }
        if (e.error_code === 429) {
          notBefore = now + ((e.parameters?.retry_after ?? 3) + 1) * 1000;
          return;
        }
      }
      // transient network hiccup — try again on a later delta
      notBefore = now + EDIT_INTERVAL_MS;
    }
  }

  async function deliverChunk(html: string, editId: number | null): Promise<void> {
    try {
      if (editId !== null) {
        await ctx.api.editMessageText(chatId, editId, html, sendOpts);
      } else {
        await ctx.reply(html, sendOpts);
      }
    } catch (e) {
      if (e instanceof GrammyError && e.description.includes("message is not modified")) return;
      // Bad HTML (split through a tag, mistranslated markup) — plain fallback.
      const plain = html.replace(/<[^>]+>/g, "");
      if (editId !== null) {
        await ctx.api.editMessageText(chatId, editId, plain).catch(() => {});
      } else {
        await ctx.reply(plain).catch(() => {});
      }
    }
  }

  for await (const delta of textStream) {
    full += delta;
    await maybeEdit();
  }

  const text = full.trim();
  if (!text) return { text: "", sent: false };

  // Finalize: replace the streamed preview with the fully formatted text;
  // overflow beyond one message continues as fresh messages.
  const chunks = splitMessage(mdToTelegramHtml(text));
  await deliverChunk(chunks[0], messageId);
  for (const c of chunks.slice(1)) await deliverChunk(c, null);
  return { text, sent: true };
}
