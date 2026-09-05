// Library E2E for the per-employee mailbox against the self-hosted throwaway
// IMAP/SMTP (greenmail, auth disabled): connect (IMAP login verified, password
// stored encrypted), inbound mail → collab_events(mail, private, tainted) +
// extraction, outbound ONLY via the mail.send HITL executor (reject = nothing
// sent; approve = delivered, verified by reading the recipient's INBOX).
// Run: npx tsx --env-file=.env.local worker/mail.test.mts
import { and, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { db } from "../db";
import { collabEvents, emailAccounts, employees, toolSecrets } from "../db/schema";
import { connectMailbox, disconnectMailbox, getMailbox, listInbox, syncInbox } from "../lib/mail-store";
import { createPendingAction, resolvePendingAction } from "../lib/approval-store";

const check = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) process.exitCode = 1;
};
const rand = Math.random().toString(36).slice(2, 8);
const ME = `qa-mail-${rand}@qa.local`;
const BOSS = `qa-boss-${rand}@qa.local`;
const GM = { host: "127.0.0.1", smtp: 3025, imap: 3143 };
let empId = "";

async function inboxSubjects(user: string): Promise<string[]> {
  const c = new ImapFlow({ host: GM.host, port: GM.imap, secure: false, auth: { user, pass: "x" }, logger: false });
  await c.connect();
  const lock = await c.getMailboxLock("INBOX");
  const out: string[] = [];
  try {
    for await (const m of c.fetch("1:*", { envelope: true })) out.push(m.envelope?.subject ?? "");
  } finally { lock.release(); }
  await c.logout();
  return out;
}

try {
  const [e] = await db.insert(employees).values({ email: ME, name: `qa-mail-${rand}`, passwordHash: "x", role: "employee" }).returning({ id: employees.id });
  empId = e.id;

  // ---- 1. connect: bad creds/host rejected, good ones stored encrypted ----
  const bad = await connectMailbox(empId, { fromAddress: ME, username: ME, password: "x", imapHost: "127.0.0.1", imapPort: 1, imapSecure: false, smtpHost: GM.host, smtpPort: GM.smtp, smtpSecure: false });
  check("unreachable IMAP → connect refused (nothing stored)", !bad.ok && !(await getMailbox(empId)));
  const meta = await connectMailbox(empId, { fromAddress: ME, username: ME, password: "x", imapHost: "169.254.169.254", imapPort: 143, imapSecure: false, smtpHost: GM.host, smtpPort: GM.smtp, smtpSecure: false });
  check("metadata host blocked", !meta.ok);
  const ok = await connectMailbox(empId, { fromAddress: ME, username: ME, password: "secret-pw", imapHost: GM.host, imapPort: GM.imap, imapSecure: false, smtpHost: GM.host, smtpPort: GM.smtp, smtpSecure: false });
  check("connect ok (IMAP login verified)", ok.ok, ok);
  const acct = await getMailbox(empId);
  check("account row has no password column", !!acct && !("password" in acct));
  const [sec] = await db.select().from(toolSecrets).where(and(eq(toolSecrets.scope, "personal"), eq(toolSecrets.name, `mail/${empId}`)));
  check("password stored AES-GCM (ciphertext ≠ plaintext)", !!sec && sec.ciphertext !== "secret-pw" && !!sec.iv && !!sec.authTag);

  // ---- 2. inbound: deliver a mail to ME via greenmail SMTP, then sync ------
  const t = nodemailer.createTransport({ host: GM.host, port: GM.smtp, secure: false });
  await t.sendMail({ from: BOSS, to: ME, subject: `Q3 預算 ${rand}`, text: "決議:Q3 預算凍結 10%。請你 9/30 前回覆差旅預算表。" });
  const s1 = await syncInbox(empId);
  check("sync fetched the new mail", s1.ok && s1.fetched === 1, s1);
  const inbox = await listInbox(empId);
  check("inbox lists subject + from", inbox.some((m) => m.subject.includes(`Q3 預算 ${rand}`) && m.from.includes(BOSS)), inbox.map((m) => m.subject));
  const [ev] = await db.select().from(collabEvents).where(and(eq(collabEvents.sourceType, "mail"), eq(collabEvents.createdBy, empId)));
  check("collab event: mail / private / tainted", ev?.scopeLabel === "private" && ev?.isTainted === true);
  check("extraction ran on the mail", Array.isArray((ev?.extractedData as { decisions?: unknown[] })?.decisions));
  const s2 = await syncInbox(empId);
  check("second sync is incremental (0 new)", s2.ok && s2.fetched === 0, s2);

  // ---- 3. outbound ONLY through HITL -------------------------------------
  const before = (await inboxSubjects(BOSS)).length;
  const p1 = await createPendingAction(empId, "mail.send", { to: BOSS, subject: `回覆 ${rand}`, text: "收到" });
  const rej = await resolvePendingAction(p1.id, empId, "employee", "reject");
  check("reject → nothing sent", rej.ok && (await inboxSubjects(BOSS)).length === before);
  const p2 = await createPendingAction(empId, "mail.send", { to: BOSS, subject: `回覆 ${rand}`, text: "收到,9/30 前回覆。" });
  const other = await resolvePendingAction(p2.id, "00000000-0000-0000-0000-000000000000", "admin", "approve");
  check("someone else cannot approve my mail", !other.ok);
  const app = await resolvePendingAction(p2.id, empId, "employee", "approve");
  check("approve → sent via own SMTP", app.ok && app.message.includes("已寄出"), app);
  const after = await inboxSubjects(BOSS);
  check("recipient INBOX has the mail", after.some((s) => s.includes(`回覆 ${rand}`)), after);

  await disconnectMailbox(empId);
  check("disconnect removes account + secret", !(await getMailbox(empId)) && (await db.select().from(toolSecrets).where(eq(toolSecrets.name, `mail/${empId}`))).length === 0);
} finally {
  const safe = async (fn: () => Promise<unknown>) => { try { await fn(); } catch { /* partial */ } };
  if (empId) {
    await safe(() => db.delete(collabEvents).where(eq(collabEvents.createdBy, empId)));
    await safe(() => db.delete(emailAccounts).where(eq(emailAccounts.employeeId, empId)));
    await safe(() => db.delete(toolSecrets).where(eq(toolSecrets.name, `mail/${empId}`)));
    await safe(() => db.delete(employees).where(eq(employees.id, empId)));
  }
}
console.log("mail.test done");
process.exit(process.exitCode ?? 0);
