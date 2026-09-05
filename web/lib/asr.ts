// Client for the self-hosted AiMeetingMinutes ASR service (FunASR Nano +
// speaker diarization) reachable over Tailscale. Flow: POST /api/transcribe
// (multipart) → {job_id} → GET /api/jobs/{job_id}/stream (SSE) until stage
// "done" carries the session result, whose `segments[]` have speaker + text.
// Everything returned is UNTRUSTED content (framed as data downstream).

export type AsrSegment = { speaker?: string; text: string; start?: number; end?: number };
export type AsrResult = {
  ok: boolean;
  transcript: string; // speaker-labelled lines
  segments: AsrSegment[];
  sessionId?: string;
  error?: string;
  mock?: boolean; // the service fell back to mock output (models missing)
};

const JOB_TIMEOUT_MS = 15 * 60 * 1000;

export function asrConfigured(): boolean {
  return !!process.env.ASR_BASE_URL;
}

export async function asrHealthy(): Promise<boolean> {
  const base = process.env.ASR_BASE_URL;
  if (!base) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${base}/api/models`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

export async function transcribeAudio(
  bytes: Uint8Array,
  filename: string,
  opts?: { speakerCount?: number; hotwords?: string },
): Promise<AsrResult> {
  const base = process.env.ASR_BASE_URL;
  if (!base) return { ok: false, transcript: "", segments: [], error: "ASR_BASE_URL not set" };

  const fd = new FormData();
  fd.append("file", new Blob([bytes as unknown as BlobPart]), filename || "meeting.wav");
  if (opts?.speakerCount) fd.append("speaker_count", String(opts.speakerCount));
  if (opts?.hotwords) fd.append("hotwords", opts.hotwords);

  let jobId: string;
  const upCtrl = new AbortController();
  const upTimer = setTimeout(() => upCtrl.abort(), 2 * 60 * 1000);
  try {
    const r = await fetch(`${base}/api/transcribe`, { method: "POST", body: fd, signal: upCtrl.signal });
    if (!r.ok) return { ok: false, transcript: "", segments: [], error: `transcribe HTTP ${r.status}` };
    const j = (await r.json()) as { job_id?: unknown };
    if (typeof j.job_id !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(j.job_id)) {
      return { ok: false, transcript: "", segments: [], error: "ASR returned no job id" };
    }
    jobId = j.job_id;
  } catch (e) {
    return { ok: false, transcript: "", segments: [], error: `ASR unreachable: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(upTimer);
  }

  // Follow the SSE stream until done/error.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), JOB_TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/api/jobs/${encodeURIComponent(jobId)}/stream`, { signal: ctrl.signal });
    if (!r.ok || !r.body) return { ok: false, transcript: "", segments: [], error: `stream HTTP ${r.status}` };
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let ev: {
          stage?: string;
          label?: string;
          result?: { session_id?: string; segments?: { speaker?: string; speaker_name?: string; text?: string; start?: number; end?: number }[]; summary?: unknown };
        };
        try {
          ev = JSON.parse(line.slice(5).trim());
        } catch {
          continue; // keepalive / non-JSON frame — ignore, don't abort the job
        }
        if (ev.stage === "error") return { ok: false, transcript: "", segments: [], error: ev.label ?? "ASR error" };
        if (ev.stage === "done" && ev.result) {
          const segments: AsrSegment[] = (ev.result.segments ?? []).map((s) => ({
            speaker: s.speaker_name || s.speaker,
            text: s.text ?? "",
            start: s.start,
            end: s.end,
          }));
          const transcript = segments.map((s) => (s.speaker ? `${s.speaker}:${s.text}` : s.text)).join("\n");
          // The service reports missing models / fallback in `summary` (string
          // or list of strings); treat any mention as mock, and an empty result
          // as not-real too.
          const summaryText = Array.isArray(ev.result.summary) ? ev.result.summary.map(String).join(" ") : String(ev.result.summary ?? "");
          const mock = /mock|missing|缺|fallback|示意/i.test(summaryText) || segments.length === 0;
          return { ok: true, transcript, segments, sessionId: ev.result.session_id, mock };
        }
      }
    }
    return { ok: false, transcript: "", segments: [], error: "stream ended without result" };
  } catch (e) {
    return { ok: false, transcript: "", segments: [], error: `ASR stream failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}
