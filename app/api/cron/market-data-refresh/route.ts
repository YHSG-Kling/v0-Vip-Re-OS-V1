/**
 * Daily Market Data Refresh Cron
 * Schedule: 5:00 AM daily in vercel.json
 * Iterates all active market_data_sources and refreshes market data
 */

import {
NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { refreshMarketData } from "@/lib/intelligence/market-insight-generator"
import { resolveActivePullGate } from "@/lib/lead-pipeline/scrape-territories"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 300 // 5 minutes

export async function GET(request: Request) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "market-data-refresh",
    cron_path: "/app/api/cron/market-data-refresh/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[MarketDataRefresh] Failed to record cron start:", startRecordResult.error)
  }

  const supabase = createServiceClient()
  let refreshed = 0
  let errors = 0
  let territoryTally: unknown = null

  try {
    // Get all active market data sources
    const { data: sources, error } = await supabase
      .from("market_data_sources")
      .select("*")
      .eq("is_active", true)

    if (error) {
      console.error("[MarketRefresh] Failed to fetch sources:", error.message)
      return NextResponse.json(
        { error: "Failed to fetch market sources" },
        { status: 500 }
      )
    }

    if (!sources || sources.length === 0) {
      await recordCronSuccessAction({ context_id: contextId, records_processed: 0, metadata: { message: "No active market sources" } })
      return NextResponse.json({
        message: "No active market sources to refresh",
        refreshed: 0,
        errors: 0,
      })
    }

    // Process each source
    // ACTIVE-TERRITORY PRE-CHECK (wave 92, lane 92B — owner: "checking the active territories before
    // scrapping and pulling data will cutdown on runs"): ONE resolution, every skipped run counted.
    // AREA-level: a RentCast MARKET sweep runs only for a live tenant's area inside one of that
    // tenant's active territories.
    const pullGate = await resolveActivePullGate(supabase)
    territoryTally = pullGate.tally
    for (const source of sources) {
      // market_data_sources carries `zip_codes` (an array — scripts/schema-snapshot.ts); the
      // singular `zip_code` this loop read does not exist, so RentCast's zip-level tier was never
      // asked. Read the first configured ZIP (the singular kept for any legacy row shape).
      const zip: string | undefined = source.zip_code ?? source.zip_codes?.[0] ?? undefined
      if (!pullGate.check(
        { brokerageId: source.brokerage_id, city: source.city, state: source.state, zip: zip ?? null },
        { requireArea: true },
      ).allowed) continue
      try {
        const result = await refreshMarketData(
          source.brokerage_id,
          source.market_area,
          zip,
          source.city,
          source.state
        )

        if (result.success) {
          refreshed++
          console.log(
            `[MarketRefresh] Refreshed ${source.market_area} via ${result.source}`
          )
        } else {
          errors++
          console.warn(`[MarketRefresh] No data for ${source.market_area}`)
        }
      } catch (err) {
        errors++
        console.error(
          `[MarketRefresh] Error refreshing ${source.market_area}:`,
          err
        )
      }

      // Rate limit: 1 second between API calls
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: sources.length,
      output_count: refreshed,
      metadata: { refreshed, errors, total: sources.length, territory_gate: territoryTally },
    })

    return NextResponse.json({
      message: "Market data refresh complete",
      refreshed,
      errors,
      total: sources.length,
    })
  } catch (error) {
    console.error("[MarketRefresh] Cron error:", error)
    await recordCronFailureAction({ context_id: contextId, error: error as Error | string, stage: "main-processing" })
    return NextResponse.json({ error: "Market data refresh failed", context_id: contextId }, { status: 500 })
  }
}
