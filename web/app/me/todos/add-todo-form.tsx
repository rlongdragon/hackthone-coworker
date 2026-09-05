"use client";

import { useActionState, useRef, useEffect } from "react";
import { Plus } from "lucide-react";
import { addPersonalTodo, type TodoFormState } from "@/lib/todo-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AddTodoForm() {
  const [state, action, pending] = useActionState<TodoFormState, FormData>(
    addPersonalTodo,
    undefined,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const wasPending = useRef(false);

  // Clear inputs after a successful submit (no error returned).
  useEffect(() => {
    if (wasPending.current && !pending && !state?.error) {
      formRef.current?.reset();
    }
    wasPending.current = pending;
  }, [pending, state]);

  return (
    <div>
      <form ref={formRef} action={action} className="flex gap-2">
        <Input
          name="title"
          required
          placeholder="新增待辦…"
          className="flex-1"
          maxLength={200}
        />
        <Input name="due" type="date" className="w-36" title="截止日(選填)" />
        <Button type="submit" disabled={pending}>
          <Plus className="size-4" /> 新增
        </Button>
      </form>
      {state?.error && (
        <p className="text-destructive mt-1.5 text-sm">{state.error}</p>
      )}
    </div>
  );
}
