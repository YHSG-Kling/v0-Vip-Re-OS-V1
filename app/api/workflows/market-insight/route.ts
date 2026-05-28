// app/api/workflows/market-insight/route.ts
// Starts the durable market-insight workflow (Vercel Workflow DevKit). Returns the
// runId immediately; the refresh + AI insight run asynchronously with per-step retry.
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
