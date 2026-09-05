import { NextResponse } from "next/server";
import { auditPermissionGraph, principalGraph } from "@/lib/red-team";
import { pepEnforced } from "@/lib/tool-store";
import { requireAdminApi } from "../_admin";

// GET /api/admin/governance/permission-graph
// Every active principal with its RBAC-derived scope grants, plus the static
// over-privilege audit (non-admin → org-scoped sensitive action).
export async function GET() {
  const gate = await requireAdminApi();
  if (gate instanceof Response) return gate;
  const [principals, audit] = await Promise.all([principalGraph(), auditPermissionGraph()]);
  return NextResponse.json({
    enforced: pepEnforced(),
    principals,
    overPrivilege: audit.findings,
  });
}
