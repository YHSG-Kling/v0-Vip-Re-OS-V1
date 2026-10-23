// app/api/workflows/market-insight/[runId]/route.ts
// THE RUN-STATUS READER for the durable market-insight workflow — the half that
// app/api/workflows/market-insight/route.ts (POST) was missing: it returned a runId
// nothing read.
//
// WHAT THE SDK EXPOSES (workflow@4.2.5, node_modules/@workflow/core/dist/runtime/run.d.ts):
//   getRun<TResult>(runId): Run<TResult>   — sync handle; throws WorkflowRunNotFoundError
//                                            only when a property is awaited
//   run.status        : Promise<"pending" | "running" | "completed" | "failed" | "cancelled">
//                       (@workflow/world runs.d.ts:4-10 WorkflowRunStatusSchema)
//   run.returnValue   : Promise<TResult>   — POLLS until completed; only read here once
//                                            status is already "completed"
//   run.workflowName / createdAt / startedAt / completedAt / readable
// It does NOT expose the arguments the run was started with, so the tenant is bound
// through the value the workflow durably stores (workflows/market-insight-workflow.ts
// echoes brokerageId into its result).
//
// TENANCY (CLAUDE.md §4), fail closed:
//   · session gate first (getAgentContext) — no session, no answer;
//   · a run the SDK cannot find → 404;
//   · a COMPLETED run whose stored brokerageId is not the session's → 404, the same
//     answer as "missing", so a foreign id cannot be told apart from a wrong one;
//   · the result is never widened: only {source, insightId, cached} is released; the
//     insight row itself is re-read by the client through the session-scoped actions
//     (getCurrentInsight …), which carry their own brokerage predicate.
// BLIND SPOT, PUBLISHED (§2): before a run completes the SDK holds nothing that names
// its tenant, so a NON-terminal run answers with its bare status enum to any
// authenticated tenant user who already possesses the id. Run ids are unguessable
// (`wrun_` + random, @workflow/core util.js:48) and the enum carries no tenant data;
// a table-backed runId→brokerage binding would close even that, and needs a
// migration this lane may not apply.
import { NextResponse } from "next/server"
import { getRun } from "workflow/api"
import { WorkflowRunNotFoundError } from "workflow/internal/errors"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import type { MarketInsightRunResult } from "@/workflows/market-insight-workflow"

const RUN_ID_SHAPE = /^[A-Za-z0-9_-]{8,128}$/

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { brokerageId } = await getAgentContext()
  if (!brokerageId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 })
  }

  const { runId } = await params
  if (!runId || !RUN_ID_SHAPE.test(runId)) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 })
  }

  const run = getRun<MarketInsightRunResult>(runId)
  let status: Awaited<typeof run.status>
  try {
    status = await run.status
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error)) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 })
    }
    throw error
  }

  if (status !== "completed") {
    // pending | running | failed | cancelled — no result exists to bind a tenant to.
    return NextResponse.json({ runId, status })
  }

  const result = await run.returnValue
  if (!result || result.brokerageId !== brokerageId) {
    // Foreign tenant: identical to a missing run.
    return NextResponse.json({ error: "Run not found" }, { status: 404 })
  }

  return NextResponse.json({
    runId,
    status,
    result: { source: result.source, insightId: result.insightId, cached: result.cached },
  })
}
