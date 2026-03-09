/**
 * Daily AI Briefing Cron Job — Layer 12 AI Intelligence Mesh
 * 
 * Runs at 6 AM daily to generate personalized briefings for all active agents.
 * Schedule: 0 6 * * * (6 AM daily)
 * 
 * Authorization: Bearer CRON_SECRET
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateDailyBriefing } from "@/lib/intelligence/daily-briefing-generator"

// Vercel Cron config
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300 // 5 minutes for processing all agents

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()
  const startTime = Date.now()

  // Query all active agents
  const { data: agents, error: agentsError } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("is_active", true)

  if (agentsError) {
    console.error("[DailyBriefingCron] Error fetching agents:", agentsError)
    return NextResponse.json(
      { error: "Failed to fetch agents", details: agentsError.message },
      { status: 500 }
    )
  }

  if (!agents || agents.length === 0) {
    return NextResponse.json({
      message: "No active agents found",
      generated: 0,
      errors: 0,
      duration_ms: Date.now() - startTime,
    })
  }

  let generated = 0
  let errors = 0
  const errorDetails: Array<{ agentId: string; error: string }> = []

  // Process agents sequentially to avoid rate limits
  // In production, this could be batched or use a queue
  for (const agent of agents) {
    try {
      await generateDailyBriefing(agent.id, agent.brokerage_id, false)
      generated++
    } catch (err) {
      errors++
      const errorMessage = err instanceof Error ? err.message : "Unknown error"
      errorDetails.push({ agentId: agent.id, error: errorMessage })
      console.error(`[DailyBriefingCron] Failed for agent ${agent.id}:`, err)
    }

    // Small delay to avoid rate limits
    if (agents.length > 10) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  const duration = Date.now() - startTime

  console.log(
    `[DailyBriefingCron] Completed: ${generated} generated, ${errors} errors, ${duration}ms`
  )

  return NextResponse.json({
    message: "Daily briefing generation complete",
    generated,
    errors,
    total_agents: agents.length,
    duration_ms: duration,
    ...(errorDetails.length > 0 && { error_details: errorDetails.slice(0, 10) }),
  })
}
