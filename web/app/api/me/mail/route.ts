import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { connectMailbox, disconnectMailbox, getMailbox, listInbox, syncInbox } from "@/lib/mail-store";
import { createPendingAction } from "@/lib/approval-store";

// The signed-in employee's OWN mailbox. Everything is keyed by the session id;
// there is no way to address another employee's mailbox from here.
async function me() {
  const session = await auth();
  return session?.user?.id ?? null;
}

// GET → account (never the password) + inbox
export async function GET() {
  const id = await me();
  if (!id) return new Response("Unauthorized", { status: 401 });
  const acct = await getMailbox(id);
  const inbox = acct ? await listInbox(id) : [];
  return NextResponse.json({
    account: acct
      ? { fromAddress: acct.fromAddress, username: acct.username, imapHost: acct.imapHost, imapPort: acct.imapPort, smtpHost: acct.smtpHost, smtpPort: acct.smtpPort, lastSyncAt: acct.lastSyncAt, disabled: !!acct.disabledAt }
      : null,
    inbox,
  });
}

// POST {op:"connect"|"sync"|"compose"|"disconnect", ...}
export async function POST(req: Request) {
  const id = await me();
  if (!id) return new Response("Unauthorized", { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const op = String(body?.op ?? "");
  if (op === "connect") {
    const r = await connectMailbox(id, {
      fromAddress: String(body?.fromAddress ?? ""),
      username: String(body?.username ?? ""),
      password: String(body?.password ?? ""),
      imapHost: String(body?.imapHost ?? ""),
      imapPort: Number(body?.imapPort ?? 993),
      imapSecure: body?.imapSecure !== false,
      smtpHost: String(body?.smtpHost ?? ""),
      smtpPort: Number(body?.smtpPort ?? 587),
      smtpSecure: body?.smtpSecure === true,
    });
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: 400 });
  }
  if (op === "sync") {
    const r = await syncInbox(id);
    return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: 400 });
  }
  if (op === "compose") {
    // Never sends here — parks a mail.send pending action the employee must confirm.
    const to = String(body?.to ?? "").trim();
    const subject = String(body?.subject ?? "").trim();
    const text = String(body?.text ?? "");
    if (!to || !subject) return NextResponse.json({ error: "收件人與主旨必填" }, { status: 400 });
    if (!(await getMailbox(id))) return NextResponse.json({ error: "尚未連接信箱" }, { status: 400 });
    const p = await createPendingAction(id, "mail.send", { to, subject, text });
    return NextResponse.json({ ok: true, approvalId: p.id, expiresAt: p.expiresAt.toISOString() }, { status: 201 });
  }
  if (op === "disconnect") {
    await disconnectMailbox(id);
    return NextResponse.json({ ok: true });
  }
  return new Response("Bad op", { status: 400 });
}
