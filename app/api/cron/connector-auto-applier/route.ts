// app/api/cron/connector-auto-applier/route.ts
// Auto-applies low-risk connector-healing proposals (currently `retry_other_actor` and a
// human-confirmed `rotate_key` path — see lib/agentic-os/connector-auto-applier for rules).
// Higher-risk kinds (endpoint_change / auth_change / shape_update / param_rename) stay in the
// superadmin queue for explicit human approval.
//
// Auth: CRON_SECRET. Writes via the service client (RLS bypass).
import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { autoApplyPendingProposals } from "@/lib/agentic-os/connector-auto-applier"

export const dynamic = "force-dynamic"
// Bounded — each pass does a small handful of UPDATE statements + at most one short SELECT per
// candidate. 60s is comfortable.
export const maxDuration = 60

export async function GET(req: Request) {
  const unauthorized = verifyCronAuth(req)
  if (unauthorized) return unauthorized

  const url = new URL(req.url)
  // Defensive: reject NaN (Number("abc") / Number(null) / Number(undefined)) so cap*5 and .limit()
  // downstream get a sane integer.
  const raw = Number(url.searchParams.get("max"))
  const cap = Number.isFinite(raw) ? Math.max(1, Math.min(50, Math.floor(raw))) : 20
  const result = await autoApplyPendingProposals({ maxApplications: cap })
  return NextResponse.json({ success: result.errors === 0, ...result })
}
