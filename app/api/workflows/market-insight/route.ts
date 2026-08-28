// app/api/workflows/market-insight/route.ts
// Starts the durable market-insight workflow (Vercel Workflow DevKit). Returns the
// runId immediately; the refresh + AI insight run asynchronously with per-step retry.
//
// ── UNRESOLVED, DELIBERATELY, and this is the reasoning so it is not re-litigated ──
// Census category 6b: nothing in the tree addresses this route, and it cannot be an
// external door (getAgentContext resolves a session). So it IS an open loop. It is
// NOT, however, a duplicate to retire, and the difference matters:
//
//   · SAME BUSINESS PROCESS as app/actions/market-insight-actions.ts —
//     refreshMarketDataAction then generateInsightAction, in that order, for the same
//     tenant and market area — which app/dashboard/market-insights/market-insights-client.tsx
//     already drives from "Refresh Data" and the generate button. Those two are the
//     wired, synchronous survivors, and they resolve zip/city/state from the
//     market_data_sources row, which this route does not.
//   · DIFFERENT CAPABILITY: durable per-step retry and replay (workflows/market-insight-workflow.ts,
//     "use workflow" / "use step"), so a transient vendor or AI failure no longer loses
//     the whole refresh. It is also the ONLY Workflow DevKit lane in the repo. Deleting
//     it would erase that capability, not relocate it — CLAUDE.md §1 forbids exactly that.
//
// Closing it honestly means a durable-refresh path with a RUN-STATUS READER: the runId
// returned below is written to nobody today, and wiring the dashboard button here
// without a reader would trade a synchronous result the agent can see for an async id
// nothing reads — a writer with no reader, which is the defect one level down. That is
// a feature decision (does the market-insights refresh become asynchronous?), not a
// wiring fix, so it is reported rather than guessed. See
// lib/kernel/manager-registry.ts:agentic_os_door_verdicts for the sibling verdicts.
import { NextResponse } from "next/server"
import { start } from "workflow/api"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { marketInsightWorkflow } from "@/workflows/market-insight-workflow"

export async function POST(req: Request) {
  const { brokerageId, agentId } = await getAgentContext()
  if (!brokerageId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 })
  }

  let body: { marketArea?: string; zipCode?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.marketArea) {
    return NextResponse.json({ error: "marketArea is required" }, { status: 400 })
  }

  const run = await start(marketInsightWorkflow, [
    { brokerageId, marketArea: body.marketArea, zipCode: body.zipCode, agentId: agentId ?? undefined },
  ])

  return NextResponse.json({ runId: run.runId, status: "started" })
}
