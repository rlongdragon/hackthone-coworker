"use client";

import { useCallback, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import zhTwLocale from "@fullcalendar/core/locales/zh-tw";
import type {
  DateSelectArg,
  EventClickArg,
  EventDropArg,
} from "@fullcalendar/core";
import type { EventResizeDoneArg } from "@fullcalendar/interaction";
import { Bot, Loader2, MapPin, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type NoteDto = {
  id: string;
  authorType: string;
  content: string;
  createdAt: string;
};
type EventDetail = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  start: string;
  end: string;
  allDay: boolean;
  source: string;
};

function fmtRange(startIso: string, endIso: string, allDay: boolean): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const d = (x: Date) =>
    x.toLocaleDateString("zh-TW", { month: "numeric", day: "numeric", weekday: "short" });
  const t = (x: Date) =>
    x.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (allDay) return d(s) === d(e) ? `${d(s)} 全天` : `${d(s)} – ${d(e)} 全天`;
  return d(s) === d(e)
    ? `${d(s)} ${t(s)} – ${t(e)}`
    : `${d(s)} ${t(s)} – ${d(e)} ${t(e)}`;
}

export function CalendarClient() {
  const calRef = useRef<FullCalendar>(null);

  // create dialog state
  const [createRange, setCreateRange] = useState<{
    start: Date;
    end: Date;
    allDay: boolean;
  } | null>(null);
  const [creating, setCreating] = useState(false);

  // detail dialog state
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [notes, setNotes] = useState<NoteDto[]>([]);
  const [noteText, setNoteText] = useState("");
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);

  const refetch = useCallback(() => {
    calRef.current?.getApi().refetchEvents();
  }, []);

  const openDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/events/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setDetail(data.event);
    setNotes(data.notes);
    setNoteText("");
    setAiText("");
  }, []);

  const onSelect = useCallback((sel: DateSelectArg) => {
    setCreateRange({ start: sel.start, end: sel.end, allDay: sel.allDay });
  }, []);

  const onEventClick = useCallback(
    (arg: EventClickArg) => void openDetail(arg.event.id),
    [openDetail],
  );

  const onMoveOrResize = useCallback(
    async (arg: EventDropArg | EventResizeDoneArg) => {
      const ev = arg.event;
      try {
        const res = await fetch(`/api/events/${ev.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start: ev.start?.toISOString(),
            end: (ev.end ?? ev.start)?.toISOString(),
            allDay: ev.allDay,
          }),
        });
        if (!res.ok) arg.revert();
      } catch {
        arg.revert(); // network failure: keep UI honest
      }
    },
    [],
  );

  async function submitCreate(formData: FormData) {
    if (!createRange) return;
    setCreating(true);
    try {
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: String(formData.get("title") ?? ""),
          description: String(formData.get("description") ?? "") || null,
          location: String(formData.get("location") ?? "") || null,
          start: createRange.start.toISOString(),
          end: createRange.end.toISOString(),
          allDay: createRange.allDay,
        }),
      });
      if (res.ok) {
        setCreateRange(null);
        refetch();
      }
    } finally {
      setCreating(false);
    }
  }

  async function removeEvent() {
    if (!detail) return;
    if (!confirm(`刪除「${detail.title}」?`)) return;
    const res = await fetch(`/api/events/${detail.id}`, { method: "DELETE" });
    if (res.ok) {
      setDetail(null);
      refetch();
    }
  }

  async function addNote() {
    if (!detail || !noteText.trim() || noteBusy) return;
    setNoteBusy(true);
    try {
      const res = await fetch(`/api/events/${detail.id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: noteText.trim() }),
      });
      if (res.ok) {
        setNoteText("");
        await openDetail(detail.id);
      }
    } finally {
      setNoteBusy(false);
    }
  }

  async function askAiNote() {
    if (!detail || !aiText.trim() || aiBusy) return;
    setAiBusy(true);
    try {
      const res = await fetch(`/api/events/${detail.id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ai: true, instruction: aiText.trim() }),
      });
      if (res.ok) {
        setAiText("");
        await openDetail(detail.id);
      }
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-3 [&_.fc]:text-sm">
      <FullCalendar
        ref={calRef}
        plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
        locale={zhTwLocale}
        initialView="dayGridMonth"
        headerToolbar={{
          left: "prev,next today",
          center: "title",
          right: "dayGridMonth,timeGridWeek,timeGridDay",
        }}
        height="calc(100dvh - 10rem)"
        nowIndicator
        selectable
        selectMirror
        editable
        dayMaxEventRows={4}
        events="/api/events"
        select={onSelect}
        eventClick={onEventClick}
        eventDrop={onMoveOrResize}
        eventResize={onMoveOrResize}
      />

      {/* create dialog */}
      <Dialog
        open={createRange !== null}
        onOpenChange={(o) => !o && setCreateRange(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新增事件</DialogTitle>
            <DialogDescription>
              {createRange &&
                fmtRange(
                  createRange.start.toISOString(),
                  createRange.end.toISOString(),
                  createRange.allDay,
                )}
            </DialogDescription>
          </DialogHeader>
          <form action={submitCreate} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ev-title">標題</Label>
              <Input id="ev-title" name="title" required autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-loc">地點(選填)</Label>
              <Input id="ev-loc" name="location" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-desc">說明(選填)</Label>
              <Input id="ev-desc" name="description" />
            </div>
            <Button type="submit" disabled={creating} className="w-full">
              {creating ? "建立中…" : "建立事件"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {/* detail dialog */}
      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="pr-8">{detail.title}</DialogTitle>
                <DialogDescription className="space-y-0.5">
                  <span className="block">
                    {fmtRange(detail.start, detail.end, detail.allDay)}
                  </span>
                  {detail.location && (
                    <span className="flex items-center gap-1">
                      <MapPin className="size-3" /> {detail.location}
                    </span>
                  )}
                </DialogDescription>
              </DialogHeader>

              {detail.description && (
                <p className="text-sm whitespace-pre-wrap">{detail.description}</p>
              )}

              {/* notes */}
              <div className="space-y-2">
                <p className="text-sm font-medium">筆記</p>
                {notes.length === 0 && (
                  <p className="text-muted-foreground text-sm">
                    還沒有筆記。自己寫,或請 AI 幫你記。
                  </p>
                )}
                <ul className="space-y-2">
                  {notes.map((n) => (
                    <li
                      key={n.id}
                      className="bg-muted/50 rounded-md border p-2.5 text-sm"
                    >
                      <div className="mb-1 flex items-center gap-2">
                        {n.authorType === "ai" ? (
                          <Badge variant="secondary" className="gap-1">
                            <Bot className="size-3" /> AI
                          </Badge>
                        ) : (
                          <Badge variant="outline">我</Badge>
                        )}
                        <span className="text-muted-foreground text-xs">
                          {new Date(n.createdAt).toLocaleString("zh-TW", {
                            hour12: false,
                          })}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap">{n.content}</p>
                    </li>
                  ))}
                </ul>

                <div className="flex gap-2">
                  <Input
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    placeholder="寫筆記…"
                    onKeyDown={(e) =>
                      e.key === "Enter" && !e.nativeEvent.isComposing && addNote()
                    }
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={addNote}
                    disabled={noteBusy || !noteText.trim()}
                    title="新增筆記"
                  >
                    {noteBusy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-4" />
                    )}
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={aiText}
                    onChange={(e) => setAiText(e.target.value)}
                    placeholder="請 AI 記錄…(例:整理這場會要追的三件事)"
                    onKeyDown={(e) =>
                      e.key === "Enter" && !e.nativeEvent.isComposing && askAiNote()
                    }
                  />
                  <Button
                    size="icon"
                    onClick={askAiNote}
                    disabled={aiBusy || !aiText.trim()}
                    title="請 AI 寫筆記"
                  >
                    {aiBusy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Bot className="size-4" />
                    )}
                  </Button>
                </div>
              </div>

              <div className="flex justify-end border-t pt-3">
                <Button variant="ghost" size="sm" onClick={removeEvent}>
                  <Trash2 className="size-3.5" /> 刪除事件
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
