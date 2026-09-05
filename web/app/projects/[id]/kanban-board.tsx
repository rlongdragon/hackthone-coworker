"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { GripVertical, Plus, Trash2, X } from "lucide-react";
import {
  createCard,
  createColumn,
  deleteCard,
  deleteColumn,
  moveCard,
  renameColumn,
  assignCard,
  type BoardState,
} from "@/lib/board-actions";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type BoardColumn = { id: string; name: string };
export type BoardCard = {
  id: string;
  columnId: string;
  title: string;
  assigneeId: string | null;
  assigneeName: string | null;
  position: number;
};
export type BoardMember = { id: string; name: string };

const SELECT_CLS =
  "h-6 max-w-28 truncate rounded border border-transparent bg-transparent text-xs text-muted-foreground outline-none hover:border-input focus-visible:border-input";

function Card({
  card,
  members,
  readOnly,
}: {
  card: BoardCard;
  members: BoardMember[];
  readOnly: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.id,
    disabled: readOnly,
  });
  const [, startTransition] = useTransition();

  return (
    <div
      ref={setNodeRef}
      className={`group/card bg-card rounded-md border p-2 text-sm shadow-xs ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <div className="flex items-start gap-1.5">
        {!readOnly && (
          <button
            {...attributes}
            {...listeners}
            className="text-muted-foreground/50 hover:text-muted-foreground mt-0.5 cursor-grab touch-none"
            aria-label="拖曳卡片"
          >
            <GripVertical className="size-3.5" />
          </button>
        )}
        <span className="min-w-0 flex-1 wrap-break-word">{card.title}</span>
        {!readOnly && (
          <form action={deleteCard}>
            <input type="hidden" name="cardId" value={card.id} />
            <button
              type="submit"
              className="text-muted-foreground hover:text-destructive opacity-0 transition-opacity group-hover/card:opacity-100"
              title="刪除卡片"
            >
              <X className="size-3.5" />
            </button>
          </form>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between pl-5">
        {readOnly ? (
          <span className="text-muted-foreground text-xs">
            {card.assigneeName ?? "未指派"}
          </span>
        ) : (
          <select
            className={SELECT_CLS}
            value={card.assigneeId ?? ""}
            onChange={(e) => {
              const fd = new FormData();
              fd.set("cardId", card.id);
              fd.set("assigneeId", e.target.value);
              startTransition(() => assignCard(fd));
            }}
            title="負責人"
          >
            <option value="">未指派</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

function AddCardForm({ columnId }: { columnId: string }) {
  const [state, action, pending] = useActionState<BoardState, FormData>(
    createCard,
    undefined,
  );
  return (
    <form action={action} className="mt-1.5">
      <input type="hidden" name="columnId" value={columnId} />
      <div className="flex gap-1">
        <Input
          name="title"
          placeholder="+ 新卡片"
          required
          maxLength={200}
          className="h-7 border-dashed bg-transparent text-sm shadow-none"
        />
        <Button type="submit" size="icon" variant="ghost" className="size-7" disabled={pending}>
          <Plus className="size-3.5" />
        </Button>
      </div>
      {state?.error && <p className="text-destructive mt-1 text-xs">{state.error}</p>}
    </form>
  );
}

function Column({
  column,
  cards,
  members,
  readOnly,
}: {
  column: BoardColumn;
  cards: BoardCard[];
  members: BoardMember[];
  readOnly: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const [editing, setEditing] = useState(false);

  return (
    <div
      ref={setNodeRef}
      className={`bg-muted/40 flex w-64 shrink-0 flex-col rounded-lg border p-2 ${
        isOver ? "ring-primary/40 ring-2" : ""
      }`}
    >
      <div className="mb-2 flex items-center gap-1.5 px-1">
        {editing && !readOnly ? (
          <form
            action={async (fd) => {
              await renameColumn(fd);
              setEditing(false);
            }}
            className="flex-1"
          >
            <input type="hidden" name="columnId" value={column.id} />
            <Input
              name="name"
              defaultValue={column.name}
              autoFocus
              maxLength={40}
              className="h-6 text-sm"
              onBlur={(e) => e.target.form?.requestSubmit()}
            />
          </form>
        ) : (
          <button
            className="truncate text-sm font-medium"
            onClick={() => !readOnly && setEditing(true)}
            title={readOnly ? column.name : "點擊改名"}
          >
            {column.name}
          </button>
        )}
        <span className="text-muted-foreground text-xs">{cards.length}</span>
        {!readOnly && cards.length === 0 && (
          <form action={deleteColumn} className="ml-auto">
            <input type="hidden" name="columnId" value={column.id} />
            <button
              type="submit"
              className="text-muted-foreground hover:text-destructive"
              title="刪除欄位(僅限空欄位)"
            >
              <Trash2 className="size-3.5" />
            </button>
          </form>
        )}
      </div>
      <div className="flex min-h-10 flex-col gap-1.5">
        {cards.map((c) => (
          <Card key={c.id} card={c} members={members} readOnly={readOnly} />
        ))}
      </div>
      {!readOnly && <AddCardForm columnId={column.id} />}
    </div>
  );
}

function AddColumnForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState<BoardState, FormData>(
    createColumn,
    undefined,
  );
  return (
    <form action={action} className="w-56 shrink-0">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex gap-1">
        <Input
          name="name"
          placeholder="+ 新增狀態欄"
          required
          maxLength={40}
          className="h-8 border-dashed bg-transparent text-sm shadow-none"
        />
        <Button type="submit" size="icon" variant="ghost" className="size-8" disabled={pending}>
          <Plus className="size-4" />
        </Button>
      </div>
      {state?.error && <p className="text-destructive mt-1 text-xs">{state.error}</p>}
    </form>
  );
}

export function KanbanBoard({
  projectId,
  columns,
  cards: serverCards,
  members,
  readOnly,
}: {
  projectId: string;
  columns: BoardColumn[];
  cards: BoardCard[];
  members: BoardMember[];
  readOnly: boolean;
}) {
  // Optimistic mirror of server cards — drag feels instant, server truth
  // re-syncs via revalidation whenever props change.
  const [localCards, setLocalCards] = useState(serverCards);
  useEffect(() => setLocalCards(serverCards), [serverCards]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const byColumn = useMemo(() => {
    const m = new Map<string, BoardCard[]>();
    for (const col of columns) m.set(col.id, []);
    for (const c of [...localCards].sort((a, b) => a.position - b.position)) {
      m.get(c.columnId)?.push(c);
    }
    return m;
  }, [columns, localCards]);

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const cardId = String(e.active.id);
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!overId) return;
    // dropped on a column container (cards are not droppable → column only)
    const targetColumn = columns.find((c) => c.id === overId);
    if (!targetColumn) return;
    const card = localCards.find((c) => c.id === cardId);
    if (!card || card.columnId === targetColumn.id) return;
    const prev = { columnId: card.columnId, position: card.position };
    const end =
      (byColumn.get(targetColumn.id)?.reduce((mx, c) => Math.max(mx, c.position), 0) ?? 0) + 1;
    setLocalCards((cur) =>
      cur.map((c) =>
        c.id === cardId ? { ...c, columnId: targetColumn.id, position: end } : c,
      ),
    );
    // On failure revert only this card — a blanket reset to serverCards would
    // wipe other in-flight optimistic moves.
    const revert = () =>
      setLocalCards((cur) =>
        cur.map((c) => (c.id === cardId ? { ...c, ...prev } : c)),
      );
    startTransition(async () => {
      try {
        const res = await moveCard(cardId, targetColumn.id, end);
        if (!res.ok) revert();
      } catch {
        revert();
      }
    });
  }

  const activeCard = activeId
    ? (localCards.find((c) => c.id === activeId) ?? null)
    : null;

  // Drop where the *pointer* is — the default rect-intersection resolves the
  // wide drag preview against neighbouring columns and lands one column off.
  const collisionDetection: CollisionDetection = (args) => {
    const byPointer = pointerWithin(args);
    return byPointer.length > 0 ? byPointer : rectIntersection(args);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="flex items-start gap-3 overflow-x-auto pb-2">
        {columns.map((col) => (
          <Column
            key={col.id}
            column={col}
            cards={byColumn.get(col.id) ?? []}
            members={members}
            readOnly={readOnly}
          />
        ))}
        {!readOnly && <AddColumnForm projectId={projectId} />}
      </div>
      <DragOverlay>
        {activeCard && (
          <div className="bg-card w-60 rounded-md border p-2 text-sm shadow-md">
            {activeCard.title}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
