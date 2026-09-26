// app/api/admin/billing/live-agent-sessions/[brokerageId]/route.ts
// Superadmin support drill-down: a brokerage's metered live view-agent
// sessions (D-ID Express v4) for the last 30 days — the READER for the
// live_agent_sessions ledger columns (provider, did_agent_id, ended_at,
// minutes_billed) that m624/wave 60 started writing. Platform pays D-ID; the
// tenant is metered (CLAUDE.md §5) — so support must be able to see what a
// tenant was billed for, session by session, before an invoice question lands.
// Gate first (requireSuperadminAuth), then the service client — the pattern
// named at lib/kernel/manager-registry.ts. Caller: BillingDiagnosticsPanel.

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireSuperadminAuth } from "@/lib/kernel/api-auth"
import { listLiveAgentSessionsForBrokerage } from "@/lib/did/live-session-metering"

export async function GET(
  // Deliberately unread: the only inputs are the route param and the session
  // gate. Position kept because Next.js passes the route context second.
  _req: NextRequest,
  { params }: { params: Promise<{ brokerageId: string }> }
) {
  const supabase = await createClient()
  const auth = await requireSuperadminAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const { brokerageId } = await params
    const result = await listLiveAgentSessionsForBrokerage({ brokerageId, days: 30 })
    if (!result.success) return NextResponse.json({ success: false, error: result.error }, { status: 500 })
    return NextResponse.json(result, { status: 200 })
  } catch (error) {
    console.error("[API] /admin/billing/live-agent-sessions GET error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
