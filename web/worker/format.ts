// Markdown → Telegram HTML (parse_mode: "HTML") + length splitting.
// Telegram supports only a small tag set: b/i/s/u/code/pre/a/blockquote.

const TG_LIMIT = 4096;

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Placeholder for extracted code blocks: NUL-framed so it can never collide
// with model-produced text (NULs are stripped from it first).
const PH = (i: number) => `\u0000${i}\u0000`;

export function mdToTelegramHtml(md: string): string {
  const blocks: string[] = [];
  let s = md.replaceAll("\u0000", "");
  // Pull fenced code blocks out first so inline rules never touch them.
  s = s.replace(/```(?:[\w+-]*)\n?([\s\S]*?)```/g, (_m, code: string) => {
    blocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`);
    return PH(blocks.length - 1);
  });

  s = escapeHtml(s);
  // Inline code before bold/italic (backtick content stays literal).
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "<i>$1</i>");
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  // Headings → bold lines; list bullets → "•".
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  s = s.replace(/^(\s*)[-*]\s+/gm, "$1• ");

  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)] ?? "");
  return s.trim();
}

// Split into ≤4096-char chunks, preferring paragraph then line boundaries.
// Naive about tags spanning chunks — callers fall back to plain text when
// Telegram rejects a chunk, so a rare split-through-tag degrades, not fails.
export function splitMessage(text: string, limit = TG_LIMIT): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit * 0.5) cut = window.lastIndexOf("\n");
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
