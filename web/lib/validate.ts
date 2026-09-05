const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns the string if it is a UUID, else null — form values go through this
// before touching uuid columns (bad input would throw a Postgres cast error).
export function asUuid(v: unknown): string | null {
  const s = String(v ?? "");
  return UUID_RE.test(s) ? s : null;
}

// Parse a yyyy-mm-dd (or ISO) date string; null if absent or invalid.
export function asDate(v: unknown): Date | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
