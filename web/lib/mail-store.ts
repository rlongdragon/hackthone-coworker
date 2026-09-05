import { and, desc, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { db } from "@/db";
import { auditLog, collabEvents, emailAccounts, toolSecrets } from "@/db/schema";
import { getSecret, putSecret } from "@/lib/tool-store";
import { extractDecisionsAndTasks, ingestCollabEvent } from "@/lib/collab-events";

// ============================================================================
// Per-employee mailbox (P4). Self-authenticated IMAP/SMTP — the employee gives
// THEIR OWN server + credentials (no Graph/OAuth broker, self-hosted friendly).
// Password: AES-256-GCM in tool_secrets (`mail/<employeeId>`, personal scope),
// never in email_accounts, never in the model context. Inbound mail becomes
// collab_events(mail, private, tainted) + the usual decision/action extraction.
// Sending is ONLY reachable through the mail.send HITL executor.
// ============================================================================

const SECRET_SCOPE = "personal" as const;
const secretName = (employeeId: string) => `mail/${employeeId}`;

export type MailboxConfig = {
  fromAddress: string;
  username: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
};

function isPrivateHost(h: string): boolean {
  // Block the cloud metadata endpoint; loopback / RFC1918 are ALLOWED on purpose
  // (self-hosted mail servers live there).
  const host = h.toLowerCase();
  return host === "169.254.169.254" || host === "metadata.google.internal" || host.endsWith(".metadata.internal");
}

export async function connectMailbox(employeeId: string, cfg: MailboxConfig): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!/^[^@\s]+@[^@\s]+$/.test(cfg.fromAddress)) return { ok: false, error: "寄件地址格式不對" };
  if (!cfg.imapHost || !cfg.smtpHost) return { ok: false, error: "IMAP / SMTP 主機必填" };
  if (isPrivateHost(cfg.imapHost) || isPrivateHost(cfg.smtpHost)) return { ok: false, error: "主機不允許" };
  if (!cfg.password) return { ok: false, error: "密碼必填" };

  // Prove the credentials work BEFORE storing anything.
  const client = new ImapFlow({
    host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapSecure,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false, tls: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    await client.logout();
  } catch (e) {
    return { ok: false, error: `IMAP 登入失敗:${e instanceof Error ? e.message : String(e)}` };
  }

  // Replace any previous password row, then store the new one encrypted.
  await db.delete(toolSecrets).where(and(eq(toolSecrets.scope, SECRET_SCOPE), eq(toolSecrets.name, secretName(employeeId))));
  await putSecret({ scope: SECRET_SCOPE, name: secretName(employeeId), value: cfg.password, createdBy: employeeId });

  const values = {
    employeeId,
    fromAddress: cfg.fromAddress,
    username: cfg.username,
    imapHost: cfg.imapHost, imapPort: cfg.imapPort, imapSecure: cfg.imapSecure,
    smtpHost: cfg.smtpHost, smtpPort: cfg.smtpPort, smtpSecure: cfg.smtpSecure,
    enabledAt: new Date(), disabledAt: null, lastUid: 0,
  };
  await db.insert(emailAccounts).values(values).onConflictDoUpdate({ target: emailAccounts.employeeId, set: values });
  await db.insert(auditLog).values({ employeeId, action: "mail.connect", detail: { imapHost: cfg.imapHost, smtpHost: cfg.smtpHost, from: cfg.fromAddress } });
  return { ok: true };
}

export async function disconnectMailbox(employeeId: string): Promise<void> {
  await db.delete(emailAccounts).where(eq(emailAccounts.employeeId, employeeId));
  await db.delete(toolSecrets).where(and(eq(toolSecrets.scope, SECRET_SCOPE), eq(toolSecrets.name, secretName(employeeId))));
  await db.insert(auditLog).values({ employeeId, action: "mail.disconnect", detail: {} });
}

export async function getMailbox(employeeId: string) {
  const [row] = await db.select().from(emailAccounts).where(eq(emailAccounts.employeeId, employeeId)).limit(1);
  return row ?? null;
}

async function password(employeeId: string): Promise<string | null> {
  return getSecret(SECRET_SCOPE, null, secretName(employeeId));
}

export type InboxItem = {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  decisions: string[];
  tasks: { title: string; needsConfirm: boolean }[];
  createdAt: Date;
};

// Incremental IMAP fetch of INBOX (UID > lastUid) → collab_events(mail, private).
export async function syncInbox(employeeId: string, opts?: { max?: number }): Promise<{ ok: true; fetched: number } | { ok: false; error: string }> {
  const acct = await getMailbox(employeeId);
  if (!acct || acct.disabledAt) return { ok: false, error: "尚未連接信箱" };
  const pass = await password(employeeId);
  if (!pass) return { ok: false, error: "找不到信箱密碼,請重新連接" };
  const client = new ImapFlow({
    host: acct.imapHost, port: acct.imapPort, secure: acct.imapSecure,
    auth: { user: acct.username, pass }, logger: false, tls: { rejectUnauthorized: false },
  });
  let fetched = 0;
  let maxUid = acct.lastUid;
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const limit = opts?.max ?? 10;
      for await (const msg of client.fetch(`${acct.lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
        if (msg.uid <= acct.lastUid) continue; // IMAP `*` may return the last message
        if (fetched >= limit) break;
        const parsed = await simpleParser(msg.source as Buffer);
        const from = parsed.from?.text ?? "";
        const subject = parsed.subject ?? "(無主旨)";
        const text = (parsed.text ?? "").slice(0, 20_000);
        const content = `寄件者: ${from}\n主旨: ${subject}\n\n${text}`;
        const ev = await ingestCollabEvent({
          sourceType: "mail",
          sourceId: `${acct.id}:${msg.uid}`,
          scopeLabel: "private",
          createdBy: employeeId,
          content,
          isTainted: true,
        });
        await extractDecisionsAndTasks(ev.id, content);
        fetched++;
        maxUid = Math.max(maxUid, msg.uid);
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    try { await client.logout(); } catch { /* ignore */ }
    return { ok: false, error: `收信失敗:${e instanceof Error ? e.message : String(e)}` };
  }
  await db.update(emailAccounts).set({ lastUid: maxUid, lastSyncAt: new Date() }).where(eq(emailAccounts.employeeId, employeeId));
  await db.insert(auditLog).values({ employeeId, action: "mail.sync", detail: { fetched } });
  return { ok: true, fetched };
}

export async function listInbox(employeeId: string, limit = 30): Promise<InboxItem[]> {
  const rows = await db
    .select()
    .from(collabEvents)
    .where(and(eq(collabEvents.sourceType, "mail"), eq(collabEvents.createdBy, employeeId)))
    .orderBy(desc(collabEvents.createdAt))
    .limit(limit);
  return rows.map((r) => {
    const content = r.content ?? "";
    const from = /^寄件者: (.*)$/m.exec(content)?.[1] ?? "";
    const subject = /^主旨: (.*)$/m.exec(content)?.[1] ?? "(無主旨)";
    const body = content.split("\n\n").slice(1).join("\n\n");
    const ex = (r.extractedData as { decisions?: string[]; tasks?: { title: string; needsConfirm: boolean }[] } | null) ?? {};
    return { id: r.id, subject, from, snippet: body.slice(0, 160), decisions: ex.decisions ?? [], tasks: ex.tasks ?? [], createdAt: r.createdAt };
  });
}

// Actually send. ONLY the mail.send HITL executor may call this.
export async function sendMail(employeeId: string, msg: { to: string; subject: string; text: string }): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const acct = await getMailbox(employeeId);
  if (!acct || acct.disabledAt) return { ok: false, error: "尚未連接信箱" };
  const pass = await password(employeeId);
  if (!pass) return { ok: false, error: "找不到信箱密碼" };
  if (!/^[^@\s]+@[^@\s]+$/.test(msg.to)) return { ok: false, error: "收件地址格式不對" };
  const transport = nodemailer.createTransport({
    host: acct.smtpHost, port: acct.smtpPort, secure: acct.smtpSecure,
    auth: { user: acct.username, pass },
    tls: { rejectUnauthorized: false },
  });
  try {
    const info = await transport.sendMail({ from: acct.fromAddress, to: msg.to, subject: msg.subject.slice(0, 200), text: msg.text.slice(0, 20_000) });
    await db.insert(auditLog).values({ employeeId, action: "mail.send", detail: { to: msg.to, subject: msg.subject.slice(0, 200), messageId: info.messageId } });
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    return { ok: false, error: `寄信失敗:${e instanceof Error ? e.message : String(e)}` };
  }
}
