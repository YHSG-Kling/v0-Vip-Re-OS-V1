/**
 * Daily AI Briefing Cron Job — Layer 12 AI Intelligence Mesh
 * 
 * Runs at 6 AM daily to generate personalized briefings for all active agents.
 * Schedule: 0 6 * * * (6 AM daily)
 * 
 * Authorization: Bearer CRON_SECRET
 */

import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateDailyBriefing } from "@/lib/intelligence/daily-briefing-generator"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

// Vercel Cron config
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300 // 5 minutes for processing all agents

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  // Initialize cron context
  const contextResult = await createCronRunContextAction({
    cron_name: "daily-briefing",
    cron_path: "/app/api/cron/daily-briefing/route.ts",
  })

  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }

  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })

  if (!startRecordResult.success) {
    console.error("[DailyBriefingCron] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = createServiceClient()
    const startTime = Date.now()

    // Query all active agents
    const { data: agents, error: agentsError } = await supabase
      .from("agents")
      .select("id, brokerage_id")
      .eq("is_active", true)

    if (agentsError) {
      throw new Error(`Failed to fetch agents: ${agentsError.message}`)
    }

    if (!agents || agents.length === 0) {
      await recordCronSuccessAction({
        context_id: contextId,
        records_processed: 0,
        metadata: { message: "No active agents found" },
      })
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

    // Record success
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: agents.length,
      output_count: generated,
      metadata: {
        total_agents: agents.length,
        generated,
        errors,
        error_sample_count: Math.min(errorDetails.length, 10),
      },
    })

    return NextResponse.json({
      message: "Daily briefing generation complete",
      generated,
      errors,
      total_agents: agents.length,
      duration_ms: duration,
      ...(errorDetails.length > 0 && { error_details: errorDetails.slice(0, 10) }),
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[DailyBriefingCron] Cron failed:", error)

    await recordCronFailureAction({
      context_id: contextId,
      error: error as Error | string,
      stage: "main-processing",
    })

    return NextResponse.json(
      { error: errorMessage, context_id: contextId },
      { status: 500 }
    )
  }
}
