import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  recalculateCampaignROI,
  recalculateChannelPerformance,
} from "@/lib/campaigns/roi-calculator"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

/**
 * CRON — Recalculate ROI
 * 
 * Runs periodically (recommended: every 24 hours) to recalculate ROI metrics
 * for recently active marketing campaigns and update channel performance.
 * 
 * IDEMPOTENT: Uses ON CONFLICT upsert — safe to re-run.
 * 
 * Steps:
 *   1. SELECT marketing_campaigns WHERE status IN ('live','paused','ended')
 *      AND updated_at > now() - interval '25 hours'
 *   2. For each campaign: call recalculateCampaignROI()
 *   3. Call recalculateChannelPerformance() for current month window
 */

export const runtime = "nodejs"
export const maxDuration = 300 // 5 minutes max

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const contextResult = await createCronRunContextAction({
    cron_name: "recalculate-roi",
    cron_path: "/app/api/cron/recalculate-roi/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[RecalculateROI] Failed to record cron start:", startRecordResult.error)
  }

  const supabase = createServiceClient()
  const results = {
    campaigns_processed: 0,
    campaigns_success: 0,
    campaigns_failed: 0,
    channels_updated: 0,
    errors: [] as string[],
  }

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // STEP 1: Fetch recently active marketing campaigns
    // Only recalculate campaigns updated in the last 25 hours
    // ══════════════════════════════════════════════════════════════════════════
    const twentyFiveHoursAgo = new Date()
    twentyFiveHoursAgo.setHours(twentyFiveHoursAgo.getHours() - 25)

    const { data: campaigns, error: fetchError } = await supabase
      .from("marketing_campaigns")
      .select("id, brokerage_id, campaign_name, campaign_type, status")
      .in("status", ["live", "paused", "ended"])
      .gte("updated_at", twentyFiveHoursAgo.toISOString())
      .order("updated_at", { ascending: false })
      .limit(100)

    if (fetchError) {
      throw new Error(`Failed to fetch campaigns: ${fetchError.message}`)
    }

    if (!campaigns || campaigns.length === 0) {
      await recordCronSuccessAction({ context_id: contextId, records_processed: 0, metadata: { message: "No recently active campaigns to process" } })
      return NextResponse.json({
        success: true,
        message: "No recently active campaigns to process",
        results,
      })
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 2: Recalculate ROI for each campaign
    // ══════════════════════════════════════════════════════════════════════════
    for (const campaign of campaigns) {
      results.campaigns_processed++

      try {
        const roiResult = await recalculateCampaignROI(
          campaign.id,
          campaign.brokerage_id,
          true // useServiceClient
        )

        if (roiResult.success) {
          results.campaigns_success++
        } else {
          results.campaigns_failed++
          results.errors.push(
            `Campaign ${campaign.id} (${campaign.campaign_name}): ${roiResult.error}`
          )
        }
      } catch (campaignError: any) {
        results.campaigns_failed++
        results.errors.push(
          `Campaign ${campaign.id}: ${campaignError.message}`
        )
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 3: Recalculate channel performance for current month
    // ══════════════════════════════════════════════════════════════════════════
    const now = new Date()
    const windowStart = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString()
      .slice(0, 10)
    const windowEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)
      .toISOString()
      .slice(0, 10)

    // Get unique brokerage IDs from processed campaigns
    const brokerageIds = [...new Set(campaigns.map((c) => c.brokerage_id))]

    for (const brokerageId of brokerageIds) {
      try {
        const channelResult = await recalculateChannelPerformance(
          brokerageId,
          windowStart,
          windowEnd,
          true // useServiceClient
        )

        if (channelResult.success) {
          results.channels_updated += channelResult.channels?.length ?? 0
        } else {
          results.errors.push(
            `Channel perf for brokerage ${brokerageId}: ${channelResult.error}`
          )
        }
      } catch (channelError: any) {
        results.errors.push(
          `Channel perf for brokerage ${brokerageId}: ${channelError.message}`
        )
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: results.campaigns_processed,
      output_count: results.channels_updated,
      metadata: results,
    })

    return NextResponse.json({
      success: true,
      message: `Processed ${results.campaigns_processed} campaigns, updated ${results.channels_updated} channel metrics`,
      results,
    })
  } catch (error: any) {
    console.error("[Cron] recalculate-roi error:", error)
    await recordCronFailureAction({ context_id: contextId, error, stage: "main-processing" })
    return NextResponse.json(
      { success: false, error: error.message, results, context_id: contextId },
      { status: 500 }
    )
  }
}
