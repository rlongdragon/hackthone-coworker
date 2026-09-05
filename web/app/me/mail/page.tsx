import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireEmployee } from "@/lib/authz";
import { getMailbox, listInbox } from "@/lib/mail-store";
import { MailClient } from "./mail-client";

export default async function MailPage() {
  const me = await requireEmployee();
  const acct = await getMailbox(me.id);
  const inbox = acct ? await listInbox(me.id) : [];
  return (
    <main className="mx-auto w-full max-w-3xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link href="/me" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="size-4" /> 今日總覽
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">我的信箱</h1>
      </div>
      <MailClient
        initialAccount={acct ? { fromAddress: acct.fromAddress, username: acct.username, imapHost: acct.imapHost, imapPort: acct.imapPort, smtpHost: acct.smtpHost, smtpPort: acct.smtpPort, lastSyncAt: acct.lastSyncAt?.toISOString() ?? null, disabled: !!acct.disabledAt } : null}
        initialInbox={inbox.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() }))}
      />
    </main>
  );
}
