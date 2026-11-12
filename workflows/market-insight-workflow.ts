// workflows/market-insight-workflow.ts
// First Vercel Workflow (Workflow DevKit) in the app — a durable, retryable
// market-insight refresh. Demonstrates the "use workflow" orchestrator + "use step"
// pattern over REAL business logic (no toy): step 1 refreshes the territory's market
// data through the provider waterfall (RentCast → OSINT → CMA), step 2 generates the
// AI insight. Each step is independently retried and its result persisted for replay,
// so a transient vendor/AI failure no longer loses the whole refresh.
//
// Durable execution (retry/replay/suspend) is validated on a Vercel deploy via
// `npx workflow web`; the step functions are plain async functions and are
// unit-testable directly.
//
// THE RETURN VALUE IS THE RUN'S STORED TENANT (lane B, 2026-09-03). The Workflow
// DevKit's `Run` handle (node_modules/@workflow/core/dist/runtime/run.d.ts) exposes
// status / returnValue / workflowName / timestamps and NOT the arguments the run was
// started with, so a reader handed only a runId has nothing to bind the run to a
// brokerage — except what the workflow itself durably stores. `brokerageId` and
// `marketArea` are therefore echoed into the result, and the run-status reader
// (app/api/workflows/market-insight/[runId]/route.ts) refuses to release a completed
// result whose brokerageId is not the session's. Remove them and that reader fails
// closed on every run.

import { refreshMarketData, generateMarketInsight } from "@/lib/intelligence/market-insight-generator"

export interface MarketInsightRunResult {
  /** The tenant the run was started for — the binding the status reader checks. */
  brokerageId: string
  marketArea: string
  source: string
  insightId: string
  cached: boolean
}

async function refreshStep(brokerageId: string, marketArea: string, zipCode?: string, city?: string, state?: string) {
  "use step"
  return refreshMarketData(brokerageId, marketArea, zipCode, city, state)
}

async function generateStep(brokerageId: string, marketArea: string, zipCode?: string, agentId?: string) {
  "use step"
  return generateMarketInsight({ brokerageId, marketArea, zipCode, agentId, forceRegenerate: true })
}

export async function marketInsightWorkflow(params: {
  brokerageId: string
  marketArea: string
  zipCode?: string
  city?: string
  state?: string
  agentId?: string
}): Promise<MarketInsightRunResult> {
  "use workflow"
  const refresh = await refreshStep(params.brokerageId, params.marketArea, params.zipCode, params.city, params.state)
  const insight = await generateStep(params.brokerageId, params.marketArea, params.zipCode, params.agentId)
  return {
    brokerageId: params.brokerageId,
    marketArea: params.marketArea,
    source: refresh.source,
    insightId: insight.insightId,
    cached: insight.cached,
  }
}
