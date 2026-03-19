/**
 * Daily Market Data Refresh Cron
 * Schedule: 5:00 AM daily in vercel.json
 * Iterates all active market_data_sources and refreshes market data
 */

import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { refreshMarketData } from "@/lib/intelligence/market-insight-generator"

export const dynamic = "force-dynamic"
export const maxDuration = 300 // 5 minutes

export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()
  let refreshed = 0
  let errors = 0

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
      return NextResponse.json({
        message: "No active market sources to refresh",
        refreshed: 0,
        errors: 0,
      })
    }

    // Process each source
    for (const source of sources) {
      try {
        const result = await refreshMarketData(
          source.brokerage_id,
          source.market_area,
          source.zip_code,
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

    return NextResponse.json({
      message: "Market data refresh complete",
      refreshed,
      errors,
      total: sources.length,
    })
  } catch (error) {
    console.error("[MarketRefresh] Cron error:", error)
    return NextResponse.json(
      { error: "Market data refresh failed" },
      { status: 500 }
    )
  }
}
