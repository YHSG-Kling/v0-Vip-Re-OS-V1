"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"

// ============================================================================
// AI MARKET INTELLIGENCE SYSTEM
// Real-time market trends, predictions, and actionable insights
// ============================================================================

// Auth gate — same pattern as ai-lead-nurturing / ai-listing-presentation.
// Resolves the caller's brokerage so listings reads stay tenant-scoped.
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

/**
 * Generate comprehensive market report with AI analysis
 */
export async function generateMarketReport(params: {
  agentId: string
  zipCode?: string
  city?: string
  county?: string
  propertyType?: "single_family" | "condo" | "townhouse" | "multi_family" | "land"
  timeframe?: "30_days" | "90_days" | "6_months" | "1_year"
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()

  try {
    // Get market data from database.
    //
    // `county` is NOT a column on market_data — the table geolocates by zip_code, city, state
    // and the curated `market_area` label, and NO table in the schema has a `county` column at
    // all. PostgREST rejects the ENTIRE request when an .or() string names an unknown column,
    // so this read returned null for every caller (county supplied or not) and every "market
    // report" below has been generated from an empty market_data set.
    // The county term is DROPPED rather than repointed: `market_area` is a free-text area label
    // written by market_data_sources ("Austin Metro"), not a county, so ilike-matching a county
    // name against it would be a guess. Restoring county filtering needs a real
    // market_data.county column first. params.county still reaches the model below, in the
    // prompt's "Market Area" line.
    //
    // NB: this comment sits ABOVE the statement on purpose — a comment BETWEEN chained calls
    // ends the contiguous method chain that schema-drift-guard attributes filters by, which
    // would hide this very .or() from the check that found it.
    const { data: marketData } = await supabase
      .from("market_data")
      .select("*")
      .or(`zip_code.eq.${params.zipCode},city.ilike.%${params.city}%`)
      .order("data_date", { ascending: false })
      .limit(100)

    // Get recent sales for analysis
    const { data: recentSales } = await supabase
      .from("listings")
      .select("*")
      // tenant anchor (scope burn-down): sales history from the caller's own brokerage
      .eq("brokerage_id", auth.brokerageId)
      .eq("status", "sold")
      .order("go_live_date", { ascending: false })
      .limit(50)

    // Generate AI market analysis
    const { object: analysis } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
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
          recommendation: z.string()
        })),
        hotNeighborhoods: z.array(z.object({
          name: z.string(),
          reason: z.string(),
          avgPrice: z.number()
        })),
        buyerTrends: z.array(z.string()),
        sellerRecommendations: z.array(z.string()),
        investmentOpportunities: z.array(z.object({
          type: z.string(),
          description: z.string(),
          potentialROI: z.string()
        })),
        forecast: z.object({
          threeMonth: z.string(),
          sixMonth: z.string(),
          oneYear: z.string()
        }),
        competitorAnalysis: z.object({
          avgListingPrice: z.number(),
          avgSellingPrice: z.number(),
          priceReductionRate: z.number(),
          topPerformingAgents: z.array(z.string())
        })
      }),
      prompt: `Analyze the real estate market data and provide comprehensive insights:

Market Area: ${params.zipCode || params.city || params.county || "General"}
Property Type: ${params.propertyType || "All types"}
Timeframe: ${params.timeframe || "90 days"}

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
8. Competitor analysis`
    })

    // pass 14: market_reports was a PHANTOM table (insert errored on every run;
    // no reader anywhere — the adapters consume the returned analysis directly and
    // persist it onto the documents record they own). The dead write is removed.

    return {
      success: true,
      report: analysis,
      reportId: undefined
    }
  } catch (error) {
    console.error("[v0] Generate market report error:", error)
    return handleError(error, "generateMarketReport")
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * TOMBSTONE — `predictPropertyPrice` was REMOVED (orphan burn-down, Lane A).
 *
 * SURVIVOR: `app/actions/ai-listing-intake.ts:aiSuggestListPrice` (declared at
 * app/actions/ai-listing-intake.ts:412). It answers the same question — "what
 * should this property be priced at" — and unlike this one it has a real surface:
 * ListingIntelligenceCard on the listing lifecycle page
 * (app/components/dashboard/listings/lifecycle/listing-intelligence-card.tsx).
 * This function had no caller anywhere in the tree.
 *
 * MERGED ONTO THE SURVIVOR BEFORE THIS DELETE, in this order:
 *   1. COMPARABLE-SALES RETRIEVAL — the only thing this function did that the
 *      survivor could not. It read the caller's own brokerage's SOLD listings in
 *      the same zip within an adjacent-bedroom band and priced against them. The
 *      survivor took `comparables` as an optional parameter that its one caller
 *      never supplied, so every list-price recommendation the product has ever
 *      shown was generated from the string "No comps provided". That read now
 *      lives in aiSuggestListPrice, with the refusal surfaced instead of being
 *      read as "no comps exist".
 *   2. `confidenceLevel`, `marketPositioning`, `comparablesSummary` and
 *      `marketTiming` — output fields the survivor's schema lacked.
 *
 * Nothing was dropped: `estimatedPrice` / `priceRangeLow` / `priceRangeHigh` /
 * `pricePerSqft` / `valueFactors` / `listingRecommendation` are the survivor's
 * `suggestedListPrice` / `priceRangeLow` / `priceRangeHigh` / `pricePerSqFt` /
 * `adjustments` / (`suggestedListPrice` + `reasoning` + `daysOnMarketEstimate`).
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Get real-time market alerts for an agent's focus areas.
 *
 * The `requireCaller()` gate below is NEW and is the whole point of this note.
 * Three of the four exports in this file (generateMarketReport,
 * predictPropertyPrice) call it as their first act; this one did not — and it
 * is a `"use server"` export, so it was an anonymously reachable endpoint that
 * ran a `generateObject` model call on every hit. Unauthenticated, unmetered,
 * unbounded AI spend: a loop against this URL bills the platform until someone
 * notices the invoice. The gate it needed already existed one screen up.
 *
 * The agent read is now tenant-anchored too. `params.agentId` was previously
 * only UUID-shape-checked and then used to read another row's
 * `specializations`; it is now required to be an agent of the caller's own
 * brokerage.
 */
export async function getMarketAlerts(params: {
  agentId: string
  alertTypes?: ("price_change" | "new_listing" | "market_shift" | "opportunity")[]
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()

  try {
    // Get agent's focus areas — tenant anchor: the named agent must be in the
    // caller's brokerage. Destructure the error: a refused read must not look
    // like "this agent has no specializations" and then still spend on a model.
    const { data: agentProfile, error: agentErr } = await supabase
      .from("agents")
      .select("specializations")
      .eq("id", params.agentId)
      .eq("brokerage_id", auth.brokerageId)
      .maybeSingle()

    if (agentErr) {
      return { success: false, error: "Could not load that agent." }
    }
    if (!agentProfile) {
      return { success: false, error: "Agent not found in your brokerage" }
    }

    // Get recent market changes
    const { data: recentChanges } = await supabase
      .from("market_data")
      .select("*")
      .order("data_date", { ascending: false })
      .limit(50)

    const { object: alerts } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        alerts: z.array(z.object({
          type: z.enum(["price_change", "new_listing", "market_shift", "opportunity", "warning"]),
          priority: z.enum(["high", "medium", "low"]),
          title: z.string(),
          description: z.string(),
          area: z.string(),
          actionRequired: z.boolean(),
          suggestedAction: z.string().optional(),
          expiresAt: z.string().optional()
        })),
        marketSnapshot: z.object({
          overallTrend: z.string(),
          keyMetric: z.string(),
          comparedToLastMonth: z.string()
        })
      }),
      prompt: `Generate market alerts based on recent data:

Specializations: ${JSON.stringify(agentProfile?.specializations || [])}

Recent Market Data:
${JSON.stringify(recentChanges || [], null, 2)}

Generate relevant alerts for:
1. Significant price changes
2. New listing opportunities
3. Market condition shifts
4. Investment opportunities
5. Warning signs`
    })

    return {
      success: true,
      alerts: alerts.alerts,
      snapshot: alerts.marketSnapshot
    }
  } catch (error) {
    console.error("[v0] Get market alerts error:", error)
    return handleError(error, "getMarketAlerts")
  }
}

/**
 * Analyze neighborhood trends and demographics
 */
export async function analyzeNeighborhood(params: {
  agentId: string
  neighborhood: string
  city: string
  state: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()

  try {
    // Get listings in the area
    const { data: areaListings } = await supabase
      .from("listings")
      .select("*")
      // tenant anchor (scope burn-down): area sample limited to the caller's brokerage
      .eq("brokerage_id", auth.brokerageId)
      .ilike("city", `%${params.city}%`)
      .order("created_at", { ascending: false })
      .limit(50)

    const { object: analysis } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        overview: z.string(),
        demographics: z.object({
          primaryBuyerProfile: z.string(),
          averageIncome: z.string(),
          familyComposition: z.string(),
          ageDistribution: z.string()
        }),
        amenities: z.object({
          schools: z.array(z.string()),
          parks: z.array(z.string()),
          shopping: z.array(z.string()),
          dining: z.array(z.string()),
          transportation: z.array(z.string())
        }),
        marketMetrics: z.object({
          avgHomePrice: z.number(),
          priceGrowthYoY: z.number(),
          avgDaysOnMarket: z.number(),
          inventoryMonths: z.number()
        }),
        lifestyle: z.object({
          walkScore: z.number(),
          transitScore: z.number(),
          bikeScore: z.number(),
          crimeRating: z.string(),
          schoolRating: z.string()
        }),
        buyerAppeal: z.array(z.object({
          segment: z.string(),
          appealLevel: z.enum(["high", "medium", "low"]),
          reasons: z.array(z.string())
        })),
        investmentPotential: z.object({
          rating: z.enum(["excellent", "good", "fair", "poor"]),
          reasoning: z.string(),
          rentalYield: z.string(),
          appreciationForecast: z.string()
        }),
        competitiveAnalysis: z.object({
          activeListings: z.number(),
          avgListPrice: z.number(),
          priceReductionRate: z.number(),
          marketType: z.string()
        })
      }),
      prompt: `Provide comprehensive neighborhood analysis:

Neighborhood: ${params.neighborhood}
City: ${params.city}, ${params.state}

Area Listings Data:
${JSON.stringify(areaListings?.slice(0, 20) || [], null, 2)}

Analyze:
1. Neighborhood overview and character
2. Demographics and buyer profiles
3. Local amenities and lifestyle factors
4. Market metrics and trends
5. Investment potential
6. Competitive landscape`
    })

    return {
      success: true,
      analysis
    }
  } catch (error) {
    console.error("[v0] Analyze neighborhood error:", error)
    return handleError(error, "analyzeNeighborhood")
  }
}
