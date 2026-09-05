import { NextResponse, type NextRequest } from "next/server";
import { auditSummary } from "@/lib/pep";
import { requireAdminApi } from "../_admin";

// GET /api/admin/governance/audit-summary?days=30
// A2A ledger roll-up: total queries, denied count, allowed/denied by scope.
export async function GET(req: NextRequest) {
  const gate = await requireAdminApi();
  if (gate instanceof Response) return gate;
  const raw = Number(req.nextUrl.searchParams.get("days") ?? "30");
  const days = Number.isFinite(raw) ? Math.min(365, Math.max(1, Math.floor(raw))) : 30;
  const summary = await auditSummary(days);
  return NextResponse.json({ days, ...summary });
}
