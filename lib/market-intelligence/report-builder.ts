/**
 * lib/market-intelligence/report-builder.ts
 *
 * Lane 75B — the SESSION-FREE core of app/actions/ai-market-intelligence.ts's
 * `generateMarketReport`, extracted so lib/ai-isa/capability-catalogue.ts's
 * `send_market_report` customer-care capability can build the SAME AI market
 * analysis a staff-facing `"use server"` export builds, without becoming a
 * public HTTP endpoint itself.
 *
 * "use server" files: every export is a public HTTP endpoint (CLAUDE.md §4).
 * `generateMarketReport` takes `brokerageId` only implicitly, through
 * `requireCaller()`'s resolved session — a plain export of the same logic
 * taking `brokerageId` as a caller-supplied argument would be the IDOR shape
 * CLAUDE.md warns about (any caller names any tenant's brokerageId). This
 * module is therefore a PLAIN lib file (no "use server"), never itself
 * reachable over HTTP; `generateMarketReport` calls it AFTER resolving the
 * session's own tenant, and lib/ai-isa/capability-catalogue.ts calls it with
 * the brokerageId already LOCKED from the AI-agent surface's own ctx (never a
 * model-suppliable argument — the same discipline every other free tool in
 * lib/ai-isa/customer-context-tools.ts follows).
 */

import { createServiceClient } from "@/lib/supabase/service"
// ROUTED lane, not the raw shim: generateObjectRouted books the spend to
// ai_tool_usage under the TENANT (CLAUDE.md §5 — ai_tool_usage is the cost
// ledger that feeds meter_readings.ai_tokens and the overage projection; an
// unbooked call is a wrong invoice). The extraction from
// app/actions/ai-market-intelligence.ts carried that action's raw
// `generateObject` call with it, and ai-spend-booked-guard flagged this file
// as a NEW unbooked model call site (wave 75 chain).
import { generateObjectRouted } from "@/lib/ai/models"
import { z } from "zod"

export interface MarketReportInput {
  brokerageId: string
  zipCode?: string
  city?: string
  county?: string
  propertyType?: "single_family" | "condo" | "townhouse" | "multi_family" | "land"
  timeframe?: "30_days" | "90_days" | "6_months" | "1_year"
}

export const MarketReportSchema = z.object({
  summary: z.string(),
  marketCondition: z.enum(["buyers_market", "sellers_market", "balanced"]),
  trendDirection: z.enum(["appreciating", "depreciating", "stable"]),
  avgPriceChange: z.number(),
  avgDaysOnMarket: z.number(),
  inventoryLevel: z.enum(["low", "moderate", "high"]),
  demandLevel: z.enum(["low", "moderate", "high"]),
  priceRangeDemand: z.array(z.object({
    range: z.string(),
    demandLevel: z.string(),
    recommendation: z.string(),
  })),
  hotNeighborhoods: z.array(z.object({
    name: z.string(),
    reason: z.string(),
    avgPrice: z.number(),
  })),
  buyerTrends: z.array(z.string()),
  sellerRecommendations: z.array(z.string()),
  investmentOpportunities: z.array(z.object({
    type: z.string(),
    description: z.string(),
    potentialROI: z.string(),
  })),
  forecast: z.object({
    threeMonth: z.string(),
    sixMonth: z.string(),
    oneYear: z.string(),
  }),
  competitorAnalysis: z.object({
    avgListingPrice: z.number(),
    avgSellingPrice: z.number(),
    priceReductionRate: z.number(),
    topPerformingAgents: z.array(z.string()),
  }),
})

export type MarketReportAnalysis = z.infer<typeof MarketReportSchema>

export type MarketReportResult =
  | { success: true; report: MarketReportAnalysis }
  | { success: false; error: string }

/**
 * THE core builder — tenant-scoped by the CALLER-RESOLVED `input.brokerageId`
 * (never a request body). Both app/actions/ai-market-intelligence.ts's
 * session-gated `generateMarketReport` and the AI-agent `send_market_report`
 * capability call this — one implementation, never two divergent analyses
 * (CLAUDE.md §6).
 */
export async function buildMarketReportAnalysis(input: MarketReportInput): Promise<MarketReportResult> {
  const supabase = createServiceClient()
  try {
    // market_data geolocates by zip_code/city/state/market_area — `county` has
    // no live column (scripts/schema-snapshot.ts) and is passed to the model's
    // prompt only, never filtered on (see app/actions/ai-market-intelligence.ts's
    // own note on why an .or() naming an unknown column refuses the WHOLE query).
    const { data: marketData } = await supabase
      .from("market_data")
      .select("*")
      .or(`zip_code.eq.${input.zipCode ?? ""},city.ilike.%${input.city ?? ""}%`)
      .order("data_date", { ascending: false })
      .limit(100)

    const { data: recentSales } = await supabase
      .from("listings")
      .select("*")
      .eq("brokerage_id", input.brokerageId)
      .eq("status", "sold")
      .order("go_live_date", { ascending: false })
      .limit(50)

    const { object: analysis } = await generateObjectRouted({
      feature: "market_report",
      brokerageId: input.brokerageId,
      schema: MarketReportSchema,
      maxTokens: 4000,
      prompt: `Analyze the real estate market data and provide comprehensive insights:

Market Area: ${input.zipCode || input.city || input.county || "General"}
Property Type: ${input.propertyType || "All types"}
Timeframe: ${input.timeframe || "90 days"}

Recent Market Data:
${JSON.stringify(marketData?.slice(0, 20) || [], null, 2)}

Recent Sales:
${JSON.stringify(recentSales?.slice(0, 20) || [], null, 2)}

Provide actionable market intelligence including:
1. Overall market summary and condition
2. Price trends and forecasts
3. Inventory analysis
4. Hot neighborhoods and emerging areas
5. Buyer behavior trends
6. Seller recommendations
7. Investment opportunities
8. Competitor analysis`,
    })

    return { success: true, report: analysis }
  } catch (error) {
    console.error("[report-builder] buildMarketReportAnalysis failed:", error)
    return { success: false, error: error instanceof Error ? error.message : "Market report generation failed" }
  }
}
