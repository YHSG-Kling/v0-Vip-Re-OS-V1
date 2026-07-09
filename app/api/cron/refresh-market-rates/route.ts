/**
 * Market Rate Refresh Cron
 *
 * Populates public.market_rate_snapshots with the authoritative weekly Freddie
 * Mac PMMS 30yr/15yr fixed rates (via FRED). This is the real feed the Wealth
 * Advisor depends on — without an authoritative row, refinance dollar-savings
 * recommendations are suppressed (see lib/wealth-advisor/scan-opportunities.ts).
 *
 * Schedule: daily (PMMS publishes weekly on Thursdays; a daily upsert keeps
 * today's row fresh and idempotent on rate_date).
 */

import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { fetchFreddieMacRates } from "@/lib/wealth-advisor/fetch-market-rates"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "refresh-market-rates",
    cron_path: "/app/api/cron/refresh-market-rates/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const rates = await fetchFreddieMacRates()
    if (!rates) {
      await recordCronFailureAction({
        context_id: contextId,
        error: "FRED returned no usable 30yr observation",
        stage: "fetch",
      })
      return NextResponse.json({ error: "No usable rate data from source" }, { status: 502 })
    }

    const supabase = createServiceClient()
    const today = new Date().toISOString().slice(0, 10)

    // Upsert on the unique rate_date so a daily run is idempotent. We stamp the
    // row with today's date (when the cron observed it) and keep the source's
    // observation date inside the payload via fetched_at semantics.
    const { error } = await supabase
      .from("market_rate_snapshots")
      .upsert(
        {
          rate_date: today,
          rate_30yr_fixed_bps: rates.rate30yrFixedBps,
          rate_15yr_fixed_bps: rates.rate15yrFixedBps,
          rate_5_1_arm_bps: null,
          rate_jumbo_30yr_bps: null,
          source: rates.source,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "rate_date" },
      )

    if (error) {
      await recordCronFailureAction({ context_id: contextId, error, stage: "upsert" })
      return NextResponse.json({ error: "Failed to persist rate snapshot" }, { status: 500 })
    }

    // MARKET-MOMENT REELS — the play no competitor runs: a meaningful 30yr
    // drop stages a circle-avatar MarketUpdateReel per active agent in the
    // SAME tick the snapshot lands (agents' faces on the news within the
    // hour, gated before anything posts). Best-effort — never blocks rates.
    let marketMoment: { rateMoment: boolean; marketReels: number; errors: number } | null = null
    try {
      const { runMarketMomentReels } = await import("@/lib/video/video-plays")
      marketMoment = await runMarketMomentReels(supabase)
    } catch (e) { console.warn("[refresh-market-rates] market-moment play failed:", (e as Error).message) }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: 1,
      output_count: 1,
      metadata: {
        rate_30yr_fixed_bps: rates.rate30yrFixedBps,
        rate_15yr_fixed_bps: rates.rate15yrFixedBps,
        observation_date: rates.rateDate,
        source: rates.source,
        ...(marketMoment ? { rate_moment: marketMoment.rateMoment, market_reels_staged: marketMoment.marketReels } : {}),
      },
    })

    return NextResponse.json({
      message: "Market rate snapshot refreshed",
      rate_30yr_fixed_bps: rates.rate30yrFixedBps,
      rate_15yr_fixed_bps: rates.rate15yrFixedBps,
      observation_date: rates.rateDate,
      source: rates.source,
    })
  } catch (error) {
    await recordCronFailureAction({ context_id: contextId, error: error as Error | string, stage: "main-processing" })
    return NextResponse.json({ error: "Market rate refresh failed", context_id: contextId }, { status: 500 })
  }
}
