// app/api/workflows/market-insight/route.ts
// Starts the durable market-insight workflow (Vercel Workflow DevKit). Returns the
// runId immediately; the refresh + AI insight run asynchronously with per-step retry.
//
// RESOLVED (lane B, 2026-09-03) — this route used to carry a deliberately-unresolved
// note: it was the only Workflow DevKit lane in the repo (a capability, not a
// duplicate of the synchronous refreshMarketDataAction → generateInsightAction pair),
// but the runId it returned was written to nobody, so wiring a button here would
// have traded a result the agent can see for an id nothing reads. Both halves now
// exist:
//
//   · THE READER: app/api/workflows/market-insight/[runId]/route.ts (GET) reads the
//     run through the SDK's `getRun(runId)` handle — status, and on completion the
//     durable return value, released only when its stored brokerageId equals the
//     session's (see the workflow file for why the tenant is stored in the result).
//   · THE SURFACE: app/dashboard/market-insights/market-insights-client.tsx
//     "Refresh + regenerate (durable)" POSTs here, polls the reader until the run is
//     terminal, then re-reads the insight through the session-scoped actions it
//     already uses. The synchronous buttons are untouched — they remain the
//     survivors for a refresh-only or regenerate-only click.
//
// TENANCY (CLAUDE.md §4): brokerage and agent come from the SESSION. The market's
// zip / city / state come from the tenant's own market_data_sources row — the same
// resolution refreshMarketDataAction performs — so the body names a market, never a
// location the tenant does not own. A market area with no source row is refused.
import { NextResponse } from "next/server"
import { start } from "workflow/api"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createClient } from "@/lib/supabase/server"
import { marketInsightWorkflow } from "@/workflows/market-insight-workflow"

export async function POST(req: Request) {
  const { brokerageId, agentId } = await getAgentContext()
  if (!brokerageId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 })
  }

  let body: { marketArea?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.marketArea || typeof body.marketArea !== "string") {
    return NextResponse.json({ error: "marketArea is required" }, { status: 400 })
  }

  // Session client (RLS applies) — the row must be this tenant's or it does not exist.
  const supabase = await createClient()
  const { data: source, error: sourceError } = await supabase
    .from("market_data_sources")
    .select("zip_codes, city, state")
    .eq("brokerage_id", brokerageId)
    .eq("market_area", body.marketArea)
    .maybeSingle()
  if (sourceError) {
    return NextResponse.json({ error: sourceError.message }, { status: 500 })
  }
  if (!source) {
    // Fail closed: an unknown market and a foreign one are the same answer.
    return NextResponse.json({ error: "Market area not found" }, { status: 404 })
  }

  const run = await start(marketInsightWorkflow, [
    {
      brokerageId,
      marketArea: body.marketArea,
      zipCode: source.zip_codes?.[0] ?? undefined,
      city: source.city ?? undefined,
      state: source.state ?? undefined,
      agentId: agentId ?? undefined,
    },
  ])

  return NextResponse.json({ runId: run.runId, status: "started" })
}
