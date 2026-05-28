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

import { refreshMarketData, generateMarketInsight } from "@/lib/intelligence/market-insight-generator"

async function refreshStep(brokerageId: string, marketArea: string, zipCode?: string) {
  "use step"
  return refreshMarketData(brokerageId, marketArea, zipCode)
}

async function generateStep(brokerageId: string, marketArea: string, zipCode?: string, agentId?: string) {
  "use step"
  return generateMarketInsight({ brokerageId, marketArea, zipCode, agentId, forceRegenerate: true })
}

export async function marketInsightWorkflow(params: {
  brokerageId: string
  marketArea: string
  zipCode?: string
  agentId?: string
}) {
  "use workflow"
  const refresh = await refreshStep(params.brokerageId, params.marketArea, params.zipCode)
  const insight = await generateStep(params.brokerageId, params.marketArea, params.zipCode, params.agentId)
  return { source: refresh.source, insightId: insight.insightId, cached: insight.cached }
}
