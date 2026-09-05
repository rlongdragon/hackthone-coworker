import { randomInt } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  departments,
  employees,
  projectMembers,
  projects,
  telegramGroups,
  telegramLinkCodes,
  telegramLinks,
} from "@/db/schema";

const CODE_TTL_MS = 10 * 60 * 1000;

// Issue a fresh one-time link code for this employee (any previous unused
// codes are invalidated so only the latest works).
export async function createLinkCode(employeeId: string): Promise<string> {
  await db.delete(telegramLinkCodes).where(eq(telegramLinkCodes.employeeId, employeeId));
  // Opportunistic sweep of expired codes from anyone.
  await db.delete(telegramLinkCodes).where(lt(telegramLinkCodes.expiresAt, new Date()));
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    try {
      await db.insert(telegramLinkCodes).values({
        code,
        employeeId,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      });
      return code;
    } catch {
      // PK collision with someone else's live code — retry with a new number.
    }
  }
  throw new Error("could not allocate link code");
}

// Consume a code (single use): returns the employee id or null.
export async function consumeLinkCode(code: string): Promise<string | null> {
  const [row] = await db
    .delete(telegramLinkCodes)
    .where(and(eq(telegramLinkCodes.code, code), gt(telegramLinkCodes.expiresAt, new Date())))
    .returning({ employeeId: telegramLinkCodes.employeeId });
  return row?.employeeId ?? null;
}

// Non-destructive validation, so a code survives a failed link attempt
// (e.g. tg_taken) and the user can retry after /unlink without regenerating.
export async function peekLinkCode(code: string): Promise<string | null> {
  const [row] = await db
    .select({ employeeId: telegramLinkCodes.employeeId })
    .from(telegramLinkCodes)
    .where(and(eq(telegramLinkCodes.code, code), gt(telegramLinkCodes.expiresAt, new Date())))
    .limit(1);
  return row?.employeeId ?? null;
}

export async function deleteLinkCode(code: string): Promise<void> {
  await db.delete(telegramLinkCodes).where(eq(telegramLinkCodes.code, code));
}

export async function linkTelegram(
  telegramUserId: number,
  employeeId: string,
): Promise<{ ok: true } | { ok: false; reason: "tg_taken" | "employee_taken" }> {
  const [byTg] = await db
    .select({ employeeId: telegramLinks.employeeId })
    .from(telegramLinks)
    .where(eq(telegramLinks.telegramUserId, telegramUserId))
    .limit(1);
  if (byTg) return byTg.employeeId === employeeId ? { ok: true } : { ok: false, reason: "tg_taken" };
  try {
    await db.insert(telegramLinks).values({ telegramUserId, employeeId });
    return { ok: true };
  } catch {
    // unique(employee_id) — this account is already bound to another TG user.
    return { ok: false, reason: "employee_taken" };
  }
}

export async function unlinkTelegram(telegramUserId: number): Promise<boolean> {
  const rows = await db
    .delete(telegramLinks)
    .where(eq(telegramLinks.telegramUserId, telegramUserId))
    .returning({ employeeId: telegramLinks.employeeId });
  return rows.length > 0;
}

// Resolve a Telegram user to the linked employee (with display name), or null.
export async function getLinkedEmployee(
  telegramUserId: number,
): Promise<{ id: string; name: string; role: string; threadSeq: number } | null> {
  const [row] = await db
    .select({
      id: employees.id,
      name: employees.name,
      role: employees.role,
      threadSeq: telegramLinks.threadSeq,
    })
    .from(telegramLinks)
    .innerJoin(employees, eq(telegramLinks.employeeId, employees.id))
    .where(
      and(eq(telegramLinks.telegramUserId, telegramUserId), eq(employees.active, true)),
    )
    .limit(1);
  return row ?? null;
}

// Raw link lookup that does NOT require an active account — used ONLY to
// tell a deactivated account apart from an unlinked one for the polite
// "帳號已停用" message. Never use it to grant any capability.
export async function getLinkRawByTelegram(
  telegramUserId: number,
): Promise<{ employeeId: string; name: string; active: boolean } | null> {
  const [row] = await db
    .select({ employeeId: telegramLinks.employeeId, name: employees.name, active: employees.active })
    .from(telegramLinks)
    .innerJoin(employees, eq(telegramLinks.employeeId, employees.id))
    .where(eq(telegramLinks.telegramUserId, telegramUserId))
    .limit(1);
  return row ?? null;
}

// Employee → telegram id, ACTIVE accounts only (handover question pushes —
// 離職封存後不再問人).
export async function getActiveLinkTgId(employeeId: string): Promise<number | null> {
  const [row] = await db
    .select({ telegramUserId: telegramLinks.telegramUserId })
    .from(telegramLinks)
    .innerJoin(employees, eq(telegramLinks.employeeId, employees.id))
    .where(and(eq(telegramLinks.employeeId, employeeId), eq(employees.active, true)))
    .limit(1);
  return row?.telegramUserId ?? null;
}

// /new: rotate the DM's rolling thread. Returns the new seq, or null if the
// Telegram user isn't linked.
export async function bumpThreadSeq(telegramUserId: number): Promise<number | null> {
  const [row] = await db
    .update(telegramLinks)
    .set({ threadSeq: sql`${telegramLinks.threadSeq} + 1` })
    .where(eq(telegramLinks.telegramUserId, telegramUserId))
    .returning({ threadSeq: telegramLinks.threadSeq });
  return row?.threadSeq ?? null;
}

// For the /me page: is this employee already linked?
export async function getLinkForEmployee(
  employeeId: string,
): Promise<{ telegramUserId: number; createdAt: Date } | null> {
  const [row] = await db
    .select({
      telegramUserId: telegramLinks.telegramUserId,
      createdAt: telegramLinks.createdAt,
    })
    .from(telegramLinks)
    .where(eq(telegramLinks.employeeId, employeeId))
    .limit(1);
  return row ?? null;
}

// ---- group mode (P3) --------------------------------------------------------

export type TgGroup = {
  chatId: number;
  kind: "project" | "department";
  projectId: string | null;
  departmentId: string | null;
  contextOptin: boolean;
  bindingName: string;
};

export async function getGroup(chatId: number): Promise<TgGroup | null> {
  const [g] = await db
    .select({
      chatId: telegramGroups.chatId,
      kind: telegramGroups.kind,
      projectId: telegramGroups.projectId,
      departmentId: telegramGroups.departmentId,
      contextOptin: telegramGroups.contextOptin,
      projectName: projects.name,
      departmentName: departments.name,
    })
    .from(telegramGroups)
    .leftJoin(projects, eq(telegramGroups.projectId, projects.id))
    .leftJoin(departments, eq(telegramGroups.departmentId, departments.id))
    .where(eq(telegramGroups.chatId, chatId))
    .limit(1);
  if (!g) return null;
  return {
    chatId: g.chatId,
    kind: g.kind as "project" | "department",
    projectId: g.projectId,
    departmentId: g.departmentId,
    contextOptin: g.contextOptin,
    bindingName: g.projectName ?? g.departmentName ?? "?",
  };
}

export async function authorizeGroup(opts: {
  chatId: number;
  title: string | null;
  kind: "project" | "department";
  bindingName: string;
  authorizedBy: string;
}): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  let projectId: string | null = null;
  let departmentId: string | null = null;
  let name = "";
  if (opts.kind === "project") {
    const [p] = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.name, opts.bindingName))
      .limit(1);
    if (!p) return { ok: false, error: `找不到專案「${opts.bindingName}」` };
    projectId = p.id;
    name = p.name;
  } else {
    const [d] = await db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .where(eq(departments.name, opts.bindingName))
      .limit(1);
    if (!d) return { ok: false, error: `找不到部門「${opts.bindingName}」` };
    departmentId = d.id;
    name = d.name;
  }
  await db
    .insert(telegramGroups)
    .values({
      chatId: opts.chatId,
      title: opts.title,
      kind: opts.kind,
      projectId,
      departmentId,
      authorizedBy: opts.authorizedBy,
    })
    .onConflictDoUpdate({
      target: telegramGroups.chatId,
      set: { kind: opts.kind, projectId, departmentId, title: opts.title },
    });
  return { ok: true, name };
}

export async function revokeGroup(chatId: number): Promise<boolean> {
  const rows = await db
    .delete(telegramGroups)
    .where(eq(telegramGroups.chatId, chatId))
    .returning({ chatId: telegramGroups.chatId });
  return rows.length > 0;
}

export async function setGroupContextOptin(chatId: number, on: boolean): Promise<boolean> {
  const rows = await db
    .update(telegramGroups)
    .set({ contextOptin: on })
    .where(eq(telegramGroups.chatId, chatId))
    .returning({ chatId: telegramGroups.chatId });
  return rows.length > 0;
}

// Two-gate membership check for a bound group: the speaker's employee account
// must belong to the bound project (member) or department.
export async function isGroupMember(group: TgGroup, employeeId: string): Promise<boolean> {
  if (group.kind === "project" && group.projectId) {
    const [row] = await db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, group.projectId),
          eq(projectMembers.employeeId, employeeId),
        ),
      )
      .limit(1);
    return !!row;
  }
  if (group.kind === "department" && group.departmentId) {
    const [row] = await db
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.id, employeeId), eq(employees.departmentId, group.departmentId)))
      .limit(1);
    return !!row;
  }
  return false;
}

export async function setNotify(telegramUserId: number, on: boolean): Promise<boolean> {
  const rows = await db
    .update(telegramLinks)
    .set({ notify: on })
    .where(eq(telegramLinks.telegramUserId, telegramUserId))
    .returning({ telegramUserId: telegramLinks.telegramUserId });
  return rows.length > 0;
}

// Everyone who gets proactive pushes (linked, notify on, account active).
export async function listNotifyTargets(): Promise<
  { telegramUserId: number; employeeId: string; name: string }[]
> {
  return db
    .select({
      telegramUserId: telegramLinks.telegramUserId,
      employeeId: telegramLinks.employeeId,
      name: employees.name,
    })
    .from(telegramLinks)
    .innerJoin(employees, eq(telegramLinks.employeeId, employees.id))
    .where(and(eq(telegramLinks.notify, true), eq(employees.active, true)));
}

export async function unlinkByEmployee(employeeId: string): Promise<boolean> {
  const rows = await db
    .delete(telegramLinks)
    .where(eq(telegramLinks.employeeId, employeeId))
    .returning({ telegramUserId: telegramLinks.telegramUserId });
  return rows.length > 0;
}
