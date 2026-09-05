// Library E2E for the Telegram group digest: opted-in group messages roll up
// into ONE team-scoped, tainted collab_event bound to the group's project, with
// self-hosted decision/action extraction, visible in the project's 會議記錄.
// Run: npx tsx --env-file=.env.local worker/tg-digest.test.mts
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { collabEvents, departments, employees, projects, telegramGroupMessages, telegramGroups } from "../db/schema";
import { digestAllGroups, digestGroup, saveGroupMessage } from "../lib/telegram-digest";
import { listMeetingRecords } from "../lib/meeting-store";

const check = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) process.exitCode = 1;
};
const rand = Math.random().toString(36).slice(2, 8);
const chatId = -(900_000_000 + Math.floor(Math.random() * 1_000_000));
let deptId = "", empId = "", projId = "";

try {
  const [d] = await db.insert(departments).values({ name: `qa-dept-${rand}` }).returning({ id: departments.id });
  deptId = d.id;
  const [e] = await db.insert(employees).values({ email: `qa-tg-${rand}@qa.local`, name: `qa-tg-${rand}`, passwordHash: "x", role: "admin", departmentId: deptId }).returning({ id: employees.id });
  empId = e.id;
  const [p] = await db.insert(projects).values({ name: `qa-proj-${rand}`, ownerId: empId }).returning({ id: projects.id });
  projId = p.id;

  // not opted in → refuses (privacy: nothing is stored / digested)
  await db.insert(telegramGroups).values({ chatId, title: "qa group", kind: "project", projectId: projId, contextOptin: false, authorizedBy: empId });
  const refused = await digestGroup(chatId);
  check("digest refused when group has not opted in", !refused.ok && refused.error.includes("聊天脈絡"), refused);

  await db.update(telegramGroups).set({ contextOptin: true }).where(eq(telegramGroups.chatId, chatId));
  await saveGroupMessage({ chatId, senderName: "阿明", text: "大家好,今天決定 A 專案上線日改到 10/1。" });
  await saveGroupMessage({ chatId, senderName: "小華", text: "好,那我 9/20 前把客戶回饋整理成報告。", employeeId: empId });
  await saveGroupMessage({ chatId, senderName: "老王", text: "我 9/25 前給 Q3 對帳表。" });
  const stored = await db.select().from(telegramGroupMessages).where(eq(telegramGroupMessages.chatId, chatId));
  check("3 messages persisted for the opted-in group", stored.length === 3, stored.length);

  const r = await digestGroup(chatId, { hours: 1, actorId: empId });
  check("digest ok", r.ok, r);
  if (r.ok) {
    check("digest consumed all 3 messages", r.messages === 3, r.messages);
    check("digest bound to the group's project", r.projectId === projId, r.projectId);
    const [ev] = await db.select().from(collabEvents).where(eq(collabEvents.id, r.eventId));
    check("collab event: telegram_group / team / tainted / project", ev.sourceType === "telegram_group" && ev.scopeLabel === "team" && ev.isTainted && ev.projectId === projId);
    check("content keeps sender-attributed lines", (ev.content ?? "").includes("阿明:"));
    const ex = ev.extractedData as { decisions?: string[]; tasks?: unknown[]; tainted?: boolean } | null;
    check("extraction persisted with taint lineage", !!ex && Array.isArray(ex.decisions) && ex.tainted === true, ex);
    const digested = await db.select().from(telegramGroupMessages).where(eq(telegramGroupMessages.chatId, chatId));
    check("messages marked digested → not re-digested", digested.every((m) => m.digestedEventId === r.eventId));
    const again = await digestGroup(chatId, { hours: 1 });
    check("second digest finds nothing new", !again.ok, again);
    const recs = await listMeetingRecords(projId);
    check("shows up in the project's 會議記錄 as telegram source", recs.some((m) => m.id === r.eventId && m.source === "telegram"), recs.map((m) => m.source));
  }
  const sweep = await digestAllGroups(1);
  check("daily sweep skips groups with nothing pending", !sweep.some((s) => s.chatId === chatId));
} finally {
  const safe = async (fn: () => Promise<unknown>) => { try { await fn(); } catch { /* partial */ } };
  await safe(() => db.delete(telegramGroups).where(eq(telegramGroups.chatId, chatId))); // cascades messages
  if (projId) await safe(() => db.delete(collabEvents).where(eq(collabEvents.projectId, projId)));
  if (projId) await safe(() => db.delete(projects).where(eq(projects.id, projId)));
  if (empId) await safe(() => db.delete(employees).where(inArray(employees.id, [empId])));
  if (deptId) await safe(() => db.delete(departments).where(eq(departments.id, deptId)));
}
console.log("tg-digest.test done");
process.exit(process.exitCode ?? 0);
