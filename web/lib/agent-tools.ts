import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { trace, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import { db } from "@/db";
import { auditLog, cards, employees, handovers, projectMembers, projects, todos } from "@/db/schema";
import { endOfColumnPosition, getBoard } from "@/lib/board-store";
import {
  addEventNote,
  createEvent,
  listEventsInRange,
} from "@/lib/event-store";
import { createPendingAction } from "@/lib/approval-store";
import {
  fileDiskPath,
  listProjectFiles,
  readFileText,
  saveProjectFile,
} from "@/lib/file-store";
import {
  copyIntoSandbox,
  copyOutOfSandbox,
  execInSandbox,
  isSafeFileName,
  writeFileInSandbox,
} from "@/lib/sandbox";
import { saveChatFile } from "@/lib/chat-file-store";
import { findVisibleTool, type ActionSpec } from "@/lib/tool-store";
import { executeAction, runSkill } from "@/lib/tool-runtime";
import { saveMemory, searchMemories } from "@/lib/memory-store";
import { askSuccessorQuestion } from "@/lib/handover-gaps";
import {
  askCoworker as delegateAsk,
  crossDeptHitlEnabled,
  principalOf,
  resolveCoworker,
} from "@/lib/delegation";
import { pepIntersection, recordQueryAudit, type ScopeLabel } from "@/lib/pep";
import { notifyQuery } from "@/lib/notifications";
import { asUuid } from "@/lib/validate";

const tracer = trace.getTracer("coworker-agent");

// Wrap a unit of work in its own span -> a detailed bar in the waterfall / o11y timeline.
async function span<T>(
  name: string,
  attrs: Attributes,
  fn: (set: (a: Attributes) => void) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: attrs }, async (s) => {
    try {
      const out = await fn((a) => s.setAttributes(a));
      s.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (e) {
      s.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
      throw e;
    } finally {
      s.end();
    }
  });
}

function parseDate(v?: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

async function isProjectMember(projectId: string, employeeId: string) {
  const [m] = await db
    .select({ employeeId: projectMembers.employeeId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.employeeId, employeeId),
      ),
    )
    .limit(1);
  return Boolean(m);
}

// Text-ish formats we can hand to the model directly. Binary formats (pdf,
// docx…) need an extraction pipeline — future work.
const READABLE_MIME = /^text\/|^application\/(json|xml|x-yaml|javascript|typescript)|\+(json|xml)$/;
const READ_CHAR_CAP = 20_000;

// Tools bound to a specific employee -> all reads/writes scoped + persisted in
// Postgres. `projectId` (already membership-checked by the caller) unlocks the
// project-file tools for project-scoped threads; `role` unlocks admin tools,
// which never execute directly — they create a pending action the user must
// approve in the UI (fresh session + role re-check at execution time).
export function makeTools(
  employeeId: string,
  projectId?: string | null,
  role?: string,
  conversationId?: string,
) {
  const base = {
    addTodo: tool({
      description:
        "Add a to-do item for the employee. Use when they mention a task to track.",
      inputSchema: z.object({
        title: z.string().max(200).describe("Short task description"),
        due: z.string().optional().describe("ISO date, if a deadline was mentioned"),
      }),
      execute: ({ title, due }) =>
        span(
          "tool.addTodo",
          { "todo.title": title, "todo.due": due ?? "none", employeeId },
          async (set) => {
            const dueDate = parseDate(due);
            if (due && !dueDate) {
              return { ok: false, error: `invalid due date: ${due}` };
            }
            await db.insert(todos).values({ employeeId, title, due: dueDate });
            const total = await db.$count(todos, eq(todos.employeeId, employeeId));
            set({ "todos.total": total });
            return { ok: true, total, due: dueDate?.toISOString() ?? null };
          },
        ),
    }),
    listTodos: tool({
      description:
        "List the employee's to-do items with their ids (needed for completeTodo).",
      inputSchema: z.object({}),
      execute: () =>
        span("tool.listTodos", { employeeId }, async (set) => {
          const rows = await db
            .select()
            .from(todos)
            .where(eq(todos.employeeId, employeeId))
            .orderBy(todos.done, asc(todos.due));
          set({ "todos.total": rows.length });
          return {
            todos: rows.map((t) => ({
              id: t.id,
              title: t.title,
              due: t.due?.toISOString() ?? null,
              done: t.done,
            })),
          };
        }),
    }),
    completeTodo: tool({
      description:
        "Mark one of the employee's to-dos as done (or not done). Get the id from listTodos first.",
      inputSchema: z.object({
        id: z.string().describe("todo id from listTodos"),
        done: z.boolean().default(true),
      }),
      execute: ({ id, done }) =>
        span("tool.completeTodo", { "todo.id": id, employeeId }, async () => {
          const todoId = asUuid(id);
          if (!todoId) return { ok: false, error: "invalid id" };
          const rows = await db
            .update(todos)
            .set({ done })
            .where(and(eq(todos.id, todoId), eq(todos.employeeId, employeeId)))
            .returning({ id: todos.id });
          return { ok: rows.length > 0 };
        }),
    }),
    createEvent: tool({
      description:
        "Create a calendar event for the employee (meeting, deadline, reminder). Times are ISO 8601 with timezone.",
      inputSchema: z.object({
        title: z.string().max(200),
        start: z.string().describe("ISO datetime"),
        end: z.string().optional().describe("ISO datetime; default start+1h"),
        allDay: z.boolean().optional(),
        location: z.string().max(200).optional(),
        description: z.string().max(2000).optional(),
      }),
      execute: ({ title, start, end, allDay, location, description }) =>
        span(
          "tool.createEvent",
          { "event.title": title, "event.start": start, employeeId },
          async (set) => {
            const s = parseDate(start);
            if (!s) return { ok: false, error: "invalid start datetime" };
            const e = parseDate(end) ?? new Date(s.getTime() + 60 * 60 * 1000);
            if (e < s) return { ok: false, error: "end before start" };
            const ev = await createEvent(employeeId, {
              title,
              startsAt: s,
              endsAt: e,
              allDay: allDay ?? false,
              location: location ?? null,
              description: description ?? null,
            });
            set({ "event.id": ev.id });
            return { ok: true, id: ev.id, title: ev.title };
          },
        ),
    }),
    listEvents: tool({
      description:
        "List the employee's calendar events in a date range (defaults to the next 14 days). Returns ids usable with addEventNote.",
      inputSchema: z.object({
        from: z.string().optional().describe("ISO date, default today"),
        to: z.string().optional().describe("ISO date, default from+14d"),
      }),
      execute: ({ from, to }) =>
        span("tool.listEvents", { employeeId }, async (set) => {
          const start = parseDate(from) ?? new Date();
          const end =
            parseDate(to) ?? new Date(start.getTime() + 14 * 24 * 3600 * 1000);
          const rows = await listEventsInRange(employeeId, start, end);
          set({ "events.total": rows.length });
          return {
            events: rows.map((e) => ({
              id: e.id,
              title: e.title,
              start: e.startsAt.toISOString(),
              end: e.endsAt.toISOString(),
              allDay: e.allDay,
              location: e.location,
            })),
          };
        }),
    }),
    addEventNote: tool({
      description:
        "Attach a note to one of the employee's calendar events (e.g. meeting prep, follow-ups). Get the event id from listEvents.",
      inputSchema: z.object({
        eventId: z.string(),
        content: z.string().max(4000),
      }),
      execute: ({ eventId, content }) =>
        span("tool.addEventNote", { "event.id": eventId, employeeId }, async () => {
          const id = asUuid(eventId);
          if (!id) return { ok: false, error: "invalid event id" };
          const note = await addEventNote(id, employeeId, content, "ai");
          return { ok: note !== null };
        }),
    }),
    remember: tool({
      description:
        "Save a fact about the employee to long-term memory (preference, ongoing work, context worth recalling weeks later). Use when they share something durable — not for one-off chit-chat. " +
        "Set derivedFromUntrusted=true when the fact came from untrusted content (a tool/MCP output, an attached document, or a coworker's delegated answer) rather than the employee's own words — it is stored as untrusted-derived provenance so the self-red-team can flag it if it later drives an automatic action.",
      inputSchema: z.object({
        content: z.string().max(1000).describe("The fact, written to stand alone"),
        kind: z.enum(["history", "preference", "context"]).default("context"),
        derivedFromUntrusted: z
          .boolean()
          .optional()
          .describe("true if distilled from untrusted content, not the employee's own words"),
      }),
      execute: ({ content, kind, derivedFromUntrusted }) =>
        span("tool.remember", { "memory.kind": kind, employeeId }, async () => {
          const m = await saveMemory(employeeId, content, kind, {
            provenance: derivedFromUntrusted ? "untrusted_derived" : "trusted",
          });
          return { ok: true, id: m.id };
        }),
    }),
    recallMemories: tool({
      description:
        "Semantic search over the employee's long-term memory. Use when past context/preferences would help answer.",
      inputSchema: z.object({
        query: z.string().max(500),
      }),
      execute: ({ query }) =>
        span("tool.recallMemories", { "memory.query": query, employeeId }, async (set) => {
          const hits = await searchMemories(employeeId, query, 5);
          set({ "memory.hits": hits.length });
          return {
            memories: hits.map((h) => ({
              content: h.content,
              kind: h.kind,
              similarity: Number(h.similarity.toFixed(3)),
              // present when the memory arrived via a handover
              handoverFrom: h.sourceName ?? undefined,
            })),
          };
        }),
    }),
    askPredecessor: tool({
      description:
        "When the employee received a handover (recallMemories hits show handoverFrom) and you CANNOT " +
        "answer a question about the predecessor's work from memories or the handover report, route the " +
        "question to the predecessor. They get it as an interview question; their answer flows back into " +
        "this employee's handover memories automatically. Tell the user the question was sent, not answered.",
      inputSchema: z.object({
        question: z.string().max(500).describe("concrete question for the predecessor, zh-TW"),
        fromName: z
          .string()
          .max(100)
          .optional()
          .describe("predecessor name, only if the employee received multiple handovers"),
      }),
      execute: ({ question, fromName }) =>
        span("tool.askPredecessor", { employeeId, "gap.fromName": fromName ?? "latest" }, async (set) => {
          const received = await db
            .select({ id: handovers.id, fromEmployeeId: handovers.fromEmployeeId })
            .from(handovers)
            .where(and(eq(handovers.toEmployeeId, employeeId), eq(handovers.status, "completed")))
            .orderBy(desc(handovers.completedAt))
            .limit(10);
          if (!received.length) return { ok: false, error: "此員工沒有收過交接,無前任可問" };
          const fromIds = [...new Set(received.map((r) => r.fromEmployeeId))];
          const people = await db
            .select({ id: employees.id, name: employees.name })
            .from(employees)
            .where(inArray(employees.id, fromIds));
          const nameOf = new Map(people.map((p) => [p.id, p.name]));
          let target = received[0];
          if (fromName) {
            const m = received.find((r) => nameOf.get(r.fromEmployeeId) === fromName);
            if (!m)
              return {
                ok: false,
                error: `找不到名為「${fromName}」的前任;有:${fromIds.map((i) => nameOf.get(i)).join("、")}`,
              };
            target = m;
          }
          const r = await askSuccessorQuestion(target.id, employeeId, question);
          set({ "gap.ok": r.ok });
          return r.ok
            ? { ok: true, sentTo: nameOf.get(target.fromEmployeeId) ?? "?", note: r.message }
            : { ok: false, error: r.message };
        }),
    }),
    askCoworker: tool({
      description:
        "把一個問題委派給另一位同事的 AI 代理回答(用同事姓名或部門名指定 target)。務必依問題內容標好 scope:" +
        "project=專案/任務進度、team=團隊會議/事務、private=對方個人事務、sensitive=請假原因/健康/薪資等敏感資訊。" +
        "系統會在模型之外強制『你 ∩ 對方』的權限交集:sensitive/private 只有本人能存取(任何角色都擋、無 HITL 例外);" +
        "每次查詢(允許或拒絕)都會寫進帳本並『通知被查的當事人』。回傳 answer、droppedFields(被擋的欄位)、droppedTools。",
      inputSchema: z.object({
        target: z.string().max(100).describe("同事姓名,或部門名稱"),
        question: z.string().max(500).describe("要委派的問題,zh-TW"),
        scope: z
          .enum(["project", "team", "private", "sensitive"])
          .describe("這個問題問的是對方的哪一類資訊"),
        purpose: z
          .string()
          .max(120)
          .optional()
          .describe("一句話說明查詢目的(正規化意圖,不是原始提問)"),
      }),
      execute: ({ target, question, scope, purpose }) =>
        span("tool.askCoworker", { employeeId, "deleg.target": target, "deleg.scope": scope }, async (set) => {
          const callee = await resolveCoworker(employeeId, target);
          if (!callee) return { ok: false, error: `找不到名為「${target}」的同事或部門。` };
          const caller = await principalOf(employeeId);
          const normPurpose = purpose?.trim() || `查詢${scope}相關資訊`;

          // Scope-intersection PEP (enforced outside the model) + transparent
          // ledger. The decision is recorded and the SUBJECT notified BEFORE any
          // answer — 不留紀錄 = 不執行. sensitive/private are self-only.
          const decision = await pepIntersection(employeeId, callee.id, scope as ScopeLabel, normPurpose);
          const audit = await recordQueryAudit({
            callerId: employeeId,
            subjectId: callee.id,
            scope: scope as ScopeLabel,
            purpose: normPurpose,
            allowed: decision.allowed,
            deniedFields: decision.deniedFields,
          });
          await notifyQuery({
            subjectId: callee.id,
            actorId: employeeId,
            actorName: caller?.name ?? "一位同事",
            scope: scope as ScopeLabel,
            allowed: decision.allowed,
            purpose: normPurpose,
            auditId: audit.id,
          });
          set({ "deleg.scopeAllowed": decision.allowed });
          if (!decision.allowed) {
            return {
              ok: false,
              denied: true,
              error: `權限交集拒絕:${decision.deniedReason}`,
              droppedFields: decision.deniedFields,
              note: `已記入帳本並通知 ${callee.name}:你的代理查詢了他的「${scope}」— 已拒絕。`,
            };
          }

          const crossDept =
            !!caller?.departmentId && caller.departmentId !== callee.departmentId;
          // Optional cross-department consent gate: the callee must approve
          // before their agent answers (reuses the HITL approval + Telegram
          // buttons). The intersected scope still applies after consent.
          if (crossDeptHitlEnabled() && crossDept) {
            const p = await createPendingAction(callee.id, "delegation.ask", {
              callerId: employeeId,
              chain: [employeeId],
              question,
              target,
            });
            set({ "deleg.needsApproval": true });
            return {
              needsApproval: true,
              approvalId: p.id,
              summary: `等待 ${callee.name} 同意跨部門委派`,
              expiresAt: p.expiresAt.toISOString(),
              note: `已請 ${callee.name} 在他的對話中確認是否受理這個跨部門委派。`,
            };
          }
          const r = await delegateAsk({ chain: [employeeId], target, question });
          set({ "deleg.ok": r.ok });
          if (!r.ok) return { ok: false, error: r.error };
          return {
            ok: true,
            from: r.from,
            answer: r.answer,
            droppedTools: r.droppedTools,
            note: `對方在你們的交集權限下作答(scope=${scope},已允許並通知當事人);droppedTools 是因你權限不足被移除的工具。`,
          };
        }),
    }),
    listProjects: tool({
      description: "List projects the employee belongs to.",
      inputSchema: z.object({}),
      execute: () =>
        span("tool.listProjects", { employeeId }, async (set) => {
          const rows = await db
            .select({
              id: projects.id,
              name: projects.name,
              status: projects.status,
              description: projects.description,
            })
            .from(projects)
            .innerJoin(
              projectMembers,
              and(
                eq(projectMembers.projectId, projects.id),
                eq(projectMembers.employeeId, employeeId),
              ),
            );
          set({ "projects.total": rows.length });
          return { projects: rows };
        }),
    }),
    runCommand: tool({
      description:
        "Run a shell command in the employee's personal Linux sandbox (Debian, no network access). " +
        "Installed: bash, python3 (+openpyxl/python-docx/python-pptx/pypdf/reportlab/weasyprint), node, pandoc, pdftotext, jq, ripgrep, and `doc2pdf <in> <out.pdf>` for CJK-capable PDF generation. " +
        "Working directory /workspace persists across commands and conversations — reusable scripts you write survive. " +
        "Convention: input files appear in /workspace/in/, put deliverables in /workspace/out/, keep reusable scripts in /workspace/skills/.",
      inputSchema: z.object({
        command: z.string().max(4000).describe("bash command line"),
        timeoutSeconds: z.number().int().min(1).max(300).optional()
          .describe("default 60, max 300"),
      }),
      execute: ({ command, timeoutSeconds }) =>
        span(
          "tool.runCommand",
          { "sandbox.command": command.slice(0, 500), employeeId },
          async (set) => {
            // Every sandbox command is audited — the sandbox is isolated
            // (gVisor, no network, non-root) but what ran must be traceable.
            await db.insert(auditLog).values({
              employeeId,
              action: "agent.sandbox.exec",
              detail: { command: command.slice(0, 1000) },
            });
            const r = await execInSandbox(employeeId, command, timeoutSeconds ?? 60);
            set({ "sandbox.exitCode": r.exitCode, "sandbox.timedOut": r.timedOut });
            return r;
          },
        ),
    }),
    writeSandboxFile: tool({
      description:
        "Write a text file into the sandbox at a path relative to /workspace (parent dirs auto-created). " +
        "Use this instead of heredocs when creating scripts or documents; then run them with runCommand.",
      inputSchema: z.object({
        path: z.string().max(300).describe("relative to /workspace, e.g. skills/report.py"),
        content: z.string().max(50_000),
      }),
      execute: ({ path, content }) =>
        span(
          "tool.writeSandboxFile",
          { "sandbox.path": path, "sandbox.bytes": content.length, employeeId },
          async () => {
            await db.insert(auditLog).values({
              employeeId,
              action: "agent.sandbox.writeFile",
              detail: { path, bytes: content.length },
            });
            return writeFileInSandbox(employeeId, path, content);
          },
        ),
    }),
    deliverFileToChat: tool({
      description:
        "Hand a file the sandbox produced (must be under /workspace/out/) back to the user as a chat download. " +
        "Give just the filename, e.g. 'summary.pdf' for /workspace/out/summary.pdf. " +
        "Returns a downloadUrl — include it in your reply as a markdown link so the user can click to download.",
      inputSchema: z.object({
        filename: z.string().max(255).describe("name of a file in /workspace/out/"),
      }),
      execute: ({ filename }) =>
        span(
          "tool.deliverFileToChat",
          { "file.name": filename, employeeId },
          async (set) => {
            if (!conversationId) {
              return { ok: false, error: "no conversation context to attach the file to" };
            }
            if (!isSafeFileName(filename)) return { ok: false, error: "invalid filename" };
            const { mkdtemp, readFile, rm } = await import("node:fs/promises");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");
            const dir = await mkdtemp(join(tmpdir(), "cw-out-"));
            try {
              await copyOutOfSandbox(employeeId, filename, join(dir, filename));
              const buf = await readFile(join(dir, filename));
              const saved = await saveChatFile(
                employeeId,
                conversationId,
                filename,
                guessMime(filename),
                buf,
              );
              if ("error" in saved) return { ok: false, error: saved.error };
              set({ "file.bytes": buf.length });
              return {
                ok: true,
                downloadUrl: `/api/files/${saved.id}`,
                filename,
                bytes: buf.length,
                note: `Give the user a markdown link: [${filename}](/api/files/${saved.id})`,
              };
            } catch {
              return {
                ok: false,
                error: `could not read /workspace/out/${filename} — does it exist? (ls /workspace/out)`,
              };
            } finally {
              await rm(dir, { recursive: true, force: true }).catch(() => {});
            }
          },
        ),
    }),
    runSkill: tool({
      description:
        "Run a shared skill from the tool library (a script — personal, department, or company scope) in your sandbox. " +
        "The available skills are listed in the system prompt. Pass positional string args if the skill takes any.",
      inputSchema: z.object({
        name: z.string().max(64).describe("skill name from the tool-library list"),
        args: z.array(z.string().max(2000)).max(20).optional(),
      }),
      execute: ({ name, args }) =>
        span("tool.runSkill", { "skill.name": name, employeeId }, async (set) => {
          const r = await runSkill(employeeId, name, args ?? []);
          set({ "skill.ok": r.ok });
          return r;
        }),
    }),
    callAction: tool({
      description:
        "Invoke a shared action tool from the tool library (an integration that performs a real side effect, e.g. creating a git card). " +
        "The available actions are listed in the system prompt. Sensitive actions return needsApproval — tell the user to confirm in the chat.",
      inputSchema: z.object({
        name: z.string().max(64).describe("action name from the tool-library list"),
        args: z.record(z.string(), z.string()).optional(),
      }),
      execute: ({ name, args }) =>
        span("tool.callAction", { "action.name": name, employeeId }, async (set) => {
          const t = await findVisibleTool(employeeId, name, "action");
          if (!t) return { ok: false, error: `action not found or not visible: ${name}` };
          const spec = t.spec as ActionSpec | null;
          if (spec?.sensitive) {
            const p = await createPendingAction(employeeId, "tool.action", {
              toolId: t.id,
              args: args ?? {},
            });
            set({ "action.needsApproval": true });
            return {
              needsApproval: true,
              approvalId: p.id,
              summary: `執行「${t.name}」`,
              expiresAt: p.expiresAt.toISOString(),
              note: "Tell the user to press the confirm button shown in the chat.",
            };
          }
          const r = await executeAction(t, args ?? {}, employeeId);
          set({ "action.ok": r.ok, "action.status": r.status ?? 0 });
          return r;
        }),
    }),
  };

  const adminTools: ToolSet =
    role === "admin"
      ? {
          assignDepartment: tool({
            description:
              "ADMIN: assign an employee (by email) to a department, or remove them from one (departmentName omitted). Creates a pending action the user must approve in the chat before anything changes.",
            inputSchema: z.object({
              email: z.string().max(320),
              departmentName: z
                .string()
                .max(100)
                .optional()
                .describe("omit to clear the department"),
            }),
            execute: ({ email, departmentName }) =>
              span(
                "tool.assignDepartment",
                { "target.email": email, employeeId },
                async () => {
                  const p = await createPendingAction(
                    employeeId,
                    "admin.assignDepartment",
                    { email, departmentName: departmentName ?? null },
                  );
                  return {
                    needsApproval: true,
                    approvalId: p.id,
                    summary: departmentName
                      ? `把 ${email} 指派到「${departmentName}」`
                      : `移除 ${email} 的部門`,
                    expiresAt: p.expiresAt.toISOString(),
                    note: "Tell the user to press the confirm button shown in the chat.",
                  };
                },
              ),
          }),
          setEmployeeRole: tool({
            description:
              "ADMIN: change an employee's role (employee/manager/admin) by email. Creates a pending action the user must approve in the chat before anything changes.",
            inputSchema: z.object({
              email: z.string().max(320),
              role: z.enum(["employee", "manager", "admin"]),
            }),
            execute: ({ email, role: newRole }) =>
              span(
                "tool.setEmployeeRole",
                { "target.email": email, "target.role": newRole, employeeId },
                async () => {
                  const p = await createPendingAction(employeeId, "admin.setRole", {
                    email,
                    role: newRole,
                  });
                  return {
                    needsApproval: true,
                    approvalId: p.id,
                    summary: `把 ${email} 的角色改為 ${newRole}`,
                    expiresAt: p.expiresAt.toISOString(),
                    note: "Tell the user to press the confirm button shown in the chat.",
                  };
                },
              ),
          }),
        }
      : {};

  if (!projectId) return { ...base, ...adminTools };

  // Board helpers shared by the kanban tools below.
  const findCard = async (title: string) => {
    const { cards: allCards, columns } = await getBoard(projectId);
    const matches = allCards.filter((c) => c.title === title);
    return { allCards, columns, matches };
  };
  // Board mutations require an *active* project — same rule as the UI actions.
  const boardWritable = async () => {
    const [p] = await db
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return p?.status === "active";
  };

  return {
    ...base,
    ...adminTools,
    listBoard: tool({
      description:
        "Show this project's kanban board: columns (statuses) and cards with assignees.",
      inputSchema: z.object({}),
      execute: () =>
        span("tool.listBoard", { projectId, employeeId }, async () => {
          const { columns, cards: allCards } = await getBoard(projectId);
          return {
            columns: columns.map((col) => ({
              name: col.name,
              cards: allCards
                .filter((c) => c.columnId === col.id)
                .map((c) => ({ title: c.title, assignee: c.assigneeName })),
            })),
          };
        }),
    }),
    createBoardCard: tool({
      description:
        "Create a kanban card in this project. columnName defaults to the first column; assigneeEmail optionally assigns a member.",
      inputSchema: z.object({
        title: z.string().max(200),
        columnName: z.string().max(40).optional(),
        assigneeEmail: z.string().max(320).optional(),
      }),
      execute: ({ title, columnName, assigneeEmail }) =>
        span("tool.createBoardCard", { "card.title": title, projectId, employeeId }, async () => {
          if (!(await boardWritable())) {
            return { ok: false, error: "project is archived (read-only)" };
          }
          const { columns } = await getBoard(projectId);
          const col = columnName
            ? columns.find((c) => c.name === columnName)
            : columns[0];
          if (!col) {
            return {
              ok: false,
              error: `column not found; available: ${columns.map((c) => c.name).join("、")}`,
            };
          }
          let assigneeId: string | null = null;
          if (assigneeEmail) {
            const [emp] = await db
              .select({ id: employees.id })
              .from(employees)
              .where(eq(employees.email, assigneeEmail.toLowerCase().trim()))
              .limit(1);
            if (!emp || !(await isProjectMember(projectId, emp.id))) {
              return { ok: false, error: "assignee is not a project member" };
            }
            assigneeId = emp.id;
          }
          await db.insert(cards).values({
            projectId,
            columnId: col.id,
            title,
            assigneeId,
            position: endOfColumnPosition(col.id),
          });
          return { ok: true, column: col.name };
        }),
    }),
    moveBoardCard: tool({
      description:
        "Move a kanban card (by exact title) to another column (status) on this project's board.",
      inputSchema: z.object({
        cardTitle: z.string().max(200),
        toColumn: z.string().max(40),
      }),
      execute: ({ cardTitle, toColumn }) =>
        span("tool.moveBoardCard", { "card.title": cardTitle, projectId, employeeId }, async () => {
          if (!(await boardWritable())) {
            return { ok: false, error: "project is archived (read-only)" };
          }
          const { columns, matches } = await findCard(cardTitle);
          if (matches.length === 0) return { ok: false, error: "card not found" };
          if (matches.length > 1) {
            return { ok: false, error: "multiple cards share this title — ask the user which one" };
          }
          const col = columns.find((c) => c.name === toColumn);
          if (!col) {
            return {
              ok: false,
              error: `column not found; available: ${columns.map((c) => c.name).join("、")}`,
            };
          }
          await db
            .update(cards)
            .set({
              columnId: col.id,
              position: endOfColumnPosition(col.id),
              updatedAt: new Date(),
            })
            .where(eq(cards.id, matches[0].id));
          return { ok: true, moved: cardTitle, to: col.name };
        }),
    }),
    assignBoardCard: tool({
      description:
        "Assign a kanban card (by exact title) to a project member by email; omit assigneeEmail to unassign.",
      inputSchema: z.object({
        cardTitle: z.string().max(200),
        assigneeEmail: z.string().max(320).optional(),
      }),
      execute: ({ cardTitle, assigneeEmail }) =>
        span("tool.assignBoardCard", { "card.title": cardTitle, projectId, employeeId }, async () => {
          if (!(await boardWritable())) {
            return { ok: false, error: "project is archived (read-only)" };
          }
          const { matches } = await findCard(cardTitle);
          if (matches.length === 0) return { ok: false, error: "card not found" };
          if (matches.length > 1) {
            return { ok: false, error: "multiple cards share this title — ask the user which one" };
          }
          let assigneeId: string | null = null;
          if (assigneeEmail) {
            const [emp] = await db
              .select({ id: employees.id, name: employees.name })
              .from(employees)
              .where(eq(employees.email, assigneeEmail.toLowerCase().trim()))
              .limit(1);
            if (!emp || !(await isProjectMember(projectId, emp.id))) {
              return { ok: false, error: "assignee is not a project member" };
            }
            assigneeId = emp.id;
          }
          await db
            .update(cards)
            .set({ assigneeId, updatedAt: new Date() })
            .where(eq(cards.id, matches[0].id));
          return { ok: true };
        }),
    }),
    readProjectFile: tool({
      description:
        "Read the content of a file uploaded to this project (text formats only: txt/md/csv/json/xml/code). Use the exact filename from the file list.",
      inputSchema: z.object({
        filename: z.string().max(255),
      }),
      execute: ({ filename }) =>
        span(
          "tool.readProjectFile",
          { "file.name": filename, projectId, employeeId },
          async (set) => {
            const files = await listProjectFiles(projectId);
            const matches = files.filter((x) => x.filename === filename);
            if (matches.length === 0) {
              return {
                ok: false,
                error: "file not found",
                available: files.map((x) => x.filename),
              };
            }
            if (matches.length > 1) {
              return {
                ok: false,
                error: `${matches.length} files share this name — ask the user which one (by upload date/uploader)`,
                candidates: matches.map((x) => ({
                  uploader: x.uploaderName,
                  uploadedAt: x.createdAt.toISOString(),
                })),
              };
            }
            const f = matches[0];
            if (!READABLE_MIME.test(f.mime)) {
              return {
                ok: false,
                error: `cannot parse ${f.mime} yet — only text formats are readable`,
              };
            }
            const content = await readFileText(f.id, READ_CHAR_CAP);
            if (content === null) return { ok: false, error: "file data missing" };
            set({ "file.chars": content.length });
            return {
              ok: true,
              filename: f.filename,
              truncated: content.length >= READ_CHAR_CAP,
              content,
            };
          },
        ),
    }),
    copyProjectFileToSandbox: tool({
      description:
        "Copy a project file (any format, incl. pdf/docx/xlsx) into the sandbox at /workspace/in/<filename> " +
        "so runCommand can process it (pandoc, pdftotext, python…). Use the exact filename from the file list.",
      inputSchema: z.object({
        filename: z.string().max(255),
      }),
      execute: ({ filename }) =>
        span(
          "tool.copyProjectFileToSandbox",
          { "file.name": filename, projectId, employeeId },
          async () => {
            const files = await listProjectFiles(projectId);
            const matches = files.filter((x) => x.filename === filename);
            if (matches.length === 0) {
              return { ok: false, error: "file not found", available: files.map((x) => x.filename) };
            }
            if (matches.length > 1) {
              return { ok: false, error: "multiple files share this name — ask the user which one" };
            }
            if (!isSafeFileName(filename)) {
              return { ok: false, error: "filename contains characters the sandbox copy cannot handle" };
            }
            await db.insert(auditLog).values({
              employeeId,
              action: "agent.sandbox.copyIn",
              detail: { projectId, fileId: matches[0].id, filename },
            });
            await copyIntoSandbox(employeeId, fileDiskPath(matches[0].id), filename);
            return { ok: true, sandboxPath: `/workspace/in/${filename}` };
          },
        ),
    }),
    saveSandboxFileToProject: tool({
      description:
        "Upload a file the sandbox produced (must be under /workspace/out/) to this project's files, " +
        "so members can download it. Give just the filename, e.g. 'report.pdf' for /workspace/out/report.pdf.",
      inputSchema: z.object({
        filename: z.string().max(255).describe("name of a file in /workspace/out/"),
      }),
      execute: ({ filename }) =>
        span(
          "tool.saveSandboxFileToProject",
          { "file.name": filename, projectId, employeeId },
          async (set) => {
            if (!isSafeFileName(filename)) {
              return { ok: false, error: "invalid filename" };
            }
            const { mkdtemp, readFile, rm } = await import("node:fs/promises");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");
            const dir = await mkdtemp(join(tmpdir(), "cw-sbx-"));
            try {
              await copyOutOfSandbox(employeeId, filename, join(dir, filename));
              const buf = await readFile(join(dir, filename));
              const file = new File([buf], filename, { type: guessMime(filename) });
              const saved = await saveProjectFile(projectId, employeeId, file);
              if ("error" in saved) return { ok: false, error: saved.error };
              set({ "file.bytes": buf.length });
              return { ok: true, fileId: saved.id, bytes: buf.length };
            } catch {
              return {
                ok: false,
                error: `could not read /workspace/out/${filename} — does it exist? (ls /workspace/out)`,
              };
            } finally {
              await rm(dir, { recursive: true, force: true }).catch(() => {});
            }
          },
        ),
    }),
  };
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  json: "application/json",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
