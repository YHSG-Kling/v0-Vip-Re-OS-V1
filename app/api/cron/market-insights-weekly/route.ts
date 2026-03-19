/**
 * Weekly Market Insights Generation Cron
 * Schedule: Mondays 6:30 AM in vercel.json
 * Generates AI insights for all active markets
 */

import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateMarketInsight } from "@/lib/intelligence/market-insight-generator"

export const dynamic = "force-dynamic"
export const maxDuration = 300 // 5 minutes

export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()
  let generated = 0
  let errors = 0

  try {
    // Get distinct market areas from active sources
    const { data: sources, error } = await supabase
      .from("market_data_sources")
      .select("brokerage_id, market_area, zip_code")
      .eq("is_active", true)

    if (error) {
      console.error("[WeeklyInsights] Failed to fetch sources:", error.message)
      return NextResponse.json(
        { error: "Failed to fetch market sources" },
        { status: 500 }
      )
    }

    if (!sources || sources.length === 0) {
      return NextResponse.json({
        message: "No active markets for insight generation",
        generated: 0,
        errors: 0,
      })
    }

    // Deduplicate by brokerage + market_area
    const uniqueMarkets = new Map<string, typeof sources[0]>()
    for (const source of sources) {
      const key = `${source.brokerage_id}:${source.market_area}`
      if (!uniqueMarkets.has(key)) {
        uniqueMarkets.set(key, source)
      }
    }

    // Generate insights for each unique market
    for (const source of uniqueMarkets.values()) {
      try {
        const result = await generateMarketInsight({
          brokerageId: source.brokerage_id,
          marketArea: source.market_area,
          zipCode: source.zip_code,
          forceRegenerate: false, // Use cache if available
        })

        if (!result.cached) {
          generated++
          console.log(`[WeeklyInsights] Generated for ${source.market_area}`)
        } else {
          console.log(`[WeeklyInsights] Cached for ${source.market_area}`)
        }
      } catch (err) {
        errors++
        console.error(
          `[WeeklyInsights] Error for ${source.market_area}:`,
          err
        )
      }

      // Rate limit: 2 seconds between AI calls
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }

    return NextResponse.json({
      message: "Weekly insights generation complete",
      generated,
      errors,
      total: uniqueMarkets.size,
    })
  } catch (error) {
    console.error("[WeeklyInsights] Cron error:", error)
    return NextResponse.json(
      { error: "Weekly insights generation failed" },
      { status: 500 }
    )
  }
}
