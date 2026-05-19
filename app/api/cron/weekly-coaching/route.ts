import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateWeeklyCoachingReport } from "@/lib/intelligence/coaching-engine"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const runtime = "nodejs"
export const maxDuration = 300 // 5 minutes for processing multiple agents

/**
 * Weekly Coaching Report Generation
 * Schedule: Monday 7:00 AM (configure in vercel.json)
 *
 * Generates AI coaching reports for all active agents
 */
export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "weekly-coaching",
    cron_path: "/app/api/cron/weekly-coaching/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[WeeklyCoaching] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = createServiceClient()

    const { data: agents, error: agentsError } = await supabase
      .from("agents")
      .select("id, brokerage_id")
      .eq("is_active", true)

    if (agentsError) {
      await recordCronFailureAction({ context_id: contextId, error: agentsError, stage: "database-fetch" })
      return NextResponse.json(
        { error: "Failed to fetch agents", details: agentsError.message, context_id: contextId },
        { status: 500 }
      )
    }

    if (!agents || agents.length === 0) {
      await recordCronSuccessAction({ context_id: contextId, records_processed: 0, metadata: { message: "No active agents found" } })
      return NextResponse.json({ message: "No active agents found", generated: 0 })
    }

    let generated = 0
    let errors = 0
    const errorDetails: Array<{ agentId: string; error: string }> = []

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

      if (agents.length > 10) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: agents.length,
      output_count: generated,
      metadata: { generated, errors, total_agents: agents.length },
    })

    return NextResponse.json({
      message: "Weekly coaching reports generated",
      generated,
      errors,
      total_agents: agents.length,
      ...(errorDetails.length > 0 && { error_details: errorDetails }),
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[WeeklyCoaching] Cron failed:", error)
    await recordCronFailureAction({ context_id: contextId, error: error as Error | string, stage: "main-processing" })
    return NextResponse.json({ error: errorMessage, context_id: contextId }, { status: 500 })
  }
}
