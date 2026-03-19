import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateWeeklyCoachingReport } from "@/lib/intelligence/coaching-engine"

export const runtime = "nodejs"
export const maxDuration = 300 // 5 minutes for processing multiple agents

/**
 * Weekly Coaching Report Generation
 * Schedule: Monday 7:00 AM (configure in vercel.json)
 * 
 * Generates AI coaching reports for all active agents
 */
export async function GET(request: NextRequest) {
  // Verify CRON_SECRET
  const authHeader = request.headers.get("authorization")
  const expectedToken = `Bearer ${process.env.CRON_SECRET}`

  if (authHeader !== expectedToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()

  // Get all active agents
  const { data: agents, error: agentsError } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("is_active", true)

  if (agentsError) {
    return NextResponse.json(
      { error: "Failed to fetch agents", details: agentsError.message },
      { status: 500 }
    )
  }

  if (!agents || agents.length === 0) {
    return NextResponse.json({ message: "No active agents found", generated: 0 })
  }

  let generated = 0
  let errors = 0
  const errorDetails: Array<{ agentId: string; error: string }> = []

  // Process agents sequentially to avoid rate limits
  for (const agent of agents) {
    try {
      await generateWeeklyCoachingReport(agent.id, agent.brokerage_id)
      generated++
    } catch (error) {
      errors++
      errorDetails.push({
        agentId: agent.id,
        error: error instanceof Error ? error.message : "Unknown error",
      })
      console.error(`[weekly-coaching] Failed for agent ${agent.id}:`, error)
    }

    // Small delay between agents to avoid overwhelming AI API
    if (agents.length > 10) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  return NextResponse.json({
    message: "Weekly coaching reports generated",
    generated,
    errors,
    total_agents: agents.length,
    ...(errorDetails.length > 0 && { error_details: errorDetails }),
  })
}
