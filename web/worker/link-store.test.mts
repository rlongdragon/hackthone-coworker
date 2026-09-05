// DB-level tests for the telegram link store (non-happy paths included).
// Run: npx tsx --env-file=.env.local worker/link-store.test.mts
import { eq } from "drizzle-orm";
import { db } from "../db";
import { employees, telegramLinkCodes } from "../db/schema";
import {
  createLinkCode,
  consumeLinkCode,
  linkTelegram,
  unlinkTelegram,
  getLinkedEmployee,
} from "../lib/telegram-store";

const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) process.exitCode = 1;
};

const [admin] = await db
  .select({ id: employees.id })
  .from(employees)
  .where(eq(employees.email, "admin@coworker.local"));
const [demo] = await db
  .select({ id: employees.id })
  .from(employees)
  .where(eq(employees.email, "demo@coworker.local"));

check("bad code rejected", (await consumeLinkCode("000000")) === null);
const c1 = await createLinkCode(admin.id);
const c2 = await createLinkCode(admin.id); // must invalidate c1
check("old code invalidated by reissue", (await consumeLinkCode(c1)) === null);
check("valid code consumes to owner", (await consumeLinkCode(c2)) === admin.id);
check("single-use", (await consumeLinkCode(c2)) === null);

const c3 = await createLinkCode(admin.id);
await db
  .update(telegramLinkCodes)
  .set({ expiresAt: new Date(Date.now() - 1000) })
  .where(eq(telegramLinkCodes.code, c3));
check("expired code rejected", (await consumeLinkCode(c3)) === null);

check("link", (await linkTelegram(111111, admin.id)).ok);
check("re-link same pair idempotent", (await linkTelegram(111111, admin.id)).ok);
const r1 = await linkTelegram(111111, demo.id);
check("tg user already taken", !r1.ok && r1.reason === "tg_taken");
const r2 = await linkTelegram(222222, admin.id);
check("employee already taken", !r2.ok && r2.reason === "employee_taken");
check("resolve linked employee", (await getLinkedEmployee(111111)) !== null);
check("unlink", await unlinkTelegram(111111));
check("unlink again is no-op", !(await unlinkTelegram(111111)));
process.exit(process.exitCode ?? 0);
