"use server"

import { createClient } from "@/lib/supabase/server"
import { bookedGenerateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"
import { requireCaller, requireCallerWithAgent } from "@/lib/auth/require-caller"
// TOMBSTONE (wave 147, lane 147Z): `buildMarketReportAnalysis` (lib/market-intelligence/report-builder.ts) — the model-authored
// analysis — is retired (file deleted); generateMarketReport below rides lib/market-reports/producer.ts:265 produceMarketReport.

// Wave 98 (98C): every model call in this file is BOOKED to the SESSION tenant (lib/ai/generate.ts::bookedGenerateObject).
const generateObject = bookedGenerateObject("ai_market_intelligence")

// ============================================================================
// AI MARKET INTELLIGENCE SYSTEM
// Real-time market trends, predictions, and actionable insights
// ============================================================================

// Auth gate — same pattern as ai-lead-nurturing / ai-listing-presentation.
// Resolves the caller's brokerage so listings reads stay tenant-scoped.
// TOMBSTONE (§1.1, 2026-09-08): local `requireCaller` lived here; survivor
// lib/auth/require-caller.ts:requireCaller (this lane's fold-in of the
// 2026-09-03 wave-26 survivor)

/**
 * Generate comprehensive market report with AI analysis
 */
export async function generateMarketReport(params: {
  /** The panel's agents.id — kept for the existing caller; scope comes from the SESSION, never this value (§4). */
  agentId?: string
  zipCode?: string
  city?: string
  state?: string
  /** The workflow adapters' shape (lib/workflow/adapters/avm-cma.ts / draft-document.ts). */
  location?: { city?: string | null; state?: string | null; zip?: string | null }
  /** A report for ONE person — the document files to that contact (tenant-checked by the producer's render). */
  contactId?: string | null
}) {
  if (params.agentId !== undefined && !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  // Session tenant + the caller's agents.id (the C5 approval scope) — crossed via agents.user_id (§3, disjoint ids).
  const auth = await requireCallerWithAgent()
  if (!auth.ok) return { success: false, error: auth.error }

  // WAVE 147 (lane 147Z — lane 147E Outside-lane 2; owner ruling 6): the agent's on-demand analysis is THE market-report
  // PRODUCER now (lib/market-reports/producer.ts produceMarketReport — verified, dated, sourced data; the model writes around
  // {{datum}} tokens and never types a figure; fair housing on the public copy; a tenant-branded PDF in the document library;
  // ledgered marketing.market_report.produce). The old builder let the model invent every figure (avgPriceChange,
  // hotNeighborhoods[].avgPrice, forecasts, "topPerformingAgents") — tombstoned onto the producer. The panel receives readable
  // text (it rendered the old object as-is); the adapters receive the asset URL they already read (reportUrl).
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { produceMarketReport } = await import("@/lib/market-reports/producer")
    const loc = params.location ?? null
    const contactId = params.contactId && isValidUUID(params.contactId) ? params.contactId : null
    const result = await produceMarketReport(createServiceClient(), {
      brokerageId: auth.brokerageId, agentUserId: auth.userId, agentId: auth.agentId,
      actor: { type: "user", userId: auth.userId },
      territoryHint: { zip: params.zipCode ?? loc?.zip ?? null, city: params.city ?? loc?.city ?? null, state: params.state ?? loc?.state ?? null },
      contactId, reasonCode: "HUMAN_REQUESTED", purpose: "on_request",
    })
    if (!result.ok) return { success: false, error: `The market report was not produced (${result.stage}): ${result.reason}` }
    const n = result.report.narrative
    const text = [
      n.headline,
      ...n.sections.map((s) => [s.heading, s.body].filter(Boolean).join("\n")),
      result.report.unavailable.length ? `Not available for ${result.report.territory.label} as of ${result.report.asOf}: ${result.report.unavailable.map((u) => u.label).join(", ")}` : "",
      `Sources: ${[...new Set(result.report.data.map((d) => `${d.source.provider} (${d.source.dataset})`))].join("; ")} — as of ${result.report.asOf}.`,
      result.approver.ok ? "" : `Before anyone outside the brokerage receives it: ${result.approver.reason}`,
    ].filter(Boolean).join("\n\n")
    return {
      success: true,
      report: text,
      reportUrl: result.assetUrl,
      documentId: result.documentId,
      territory: result.report.territory.label,
      asOf: result.report.asOf,
      validation: result.validation,
      reportId: result.documentId ?? undefined,
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
