"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { isValidUUID } from "@/lib/validations"
import { revalidatePath } from "next/cache"

// =============================================================================
// AI-POWERED COMPARATIVE MARKET ANALYSIS (CMA) SYSTEM
//
// THERE IS ONE CMA ENGINE AND IT IS NOT IN THIS FILE.
// ---------------------------------------------------------------------------
// Owner ruling: "the same cma should be used for all." This file used to carry
// a SECOND, private valuation stack — its own comp fetch, its own hardcoded
// adjustment constants, and a GPT-4o call that authored `estimatedValue`, the
// number written to cma_reports.recommended_price and shown to sellers. That
// stack has been deleted (its tombstones now sit in lib/cma/ai-cma-report.ts
// beside the code that replaced each piece) and the generator composes
// lib/cma/ai-cma-orchestrator.runAiCma — the same engine app/actions/home-value.ts,
// app/actions/calculators.ts, lib/workflow/adapters/avm-cma.ts and
// lib/workflow/intelligence/listing-presentation-builder.ts already use.
//
// WHAT THIS FILE STILL OWNS (lane 86F): the "use server" SESSION door
// (generateAICMA proves the caller owns the agents row, then calls the core),
// and the CMA readers/updaters below. PERSISTENCE — the only writer of
// cma_reports / cma_comparables / cma_price_adjustments — the market_data read
// and the pricing-strategy / presentation-script narratives moved with the body
// to lib/cma/ai-cma-report.ts::generateCmaReport, so the autonomous
// listing-appt-prep chain can run them without a session.
//
// DIVISION OF LABOUR, stated once so it is not re-blurred: runAiCma produces
// EVERY NUMBER. The models called from the core produce PROSE and may position
// a list price INSIDE the comp-derived range — never outside it, never in its
// absence. See clampToRange in lib/cma/ai-cma-report.ts.
// =============================================================================

// -----------------------------------------------------------------------------
// TYPES + THE GENERATOR — MOVED (lane 86F)
// -----------------------------------------------------------------------------
// The CMAParams type, generateAICMA's body and every helper it used
// (persistComparables, analyzeMarketTrends, generatePricingStrategy,
// generateCMAPresentation, the unit adapters and the tombstones for the deleted
// valuation stack) moved to lib/cma/ai-cma-report.ts::generateCmaReport — a
// server-only core on the service client with a verified tenant. The autonomous
// listing-appt-prep chain calls it directly (this action's cookie gate refused
// every unattended run "Unauthorized"); this action stays the SESSION door.
import { generateCmaReport, type CMAParams } from "@/lib/cma/ai-cma-report"

/**
 * Generate comprehensive AI-powered CMA report — the SESSION door.
 *
 * Proves the caller owns `params.agentId` (the agents row is read on the
 * RLS-bound cookie client WITH user_id = the authenticated user), then hands the
 * core that row's brokerage and the user's id. The contact/tenant gates, the
 * comps and every write run in the core, BEFORE anything is spent.
 */
export async function generateAICMA(params: CMAParams) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  // Validate that the caller owns this agentId
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: "Unauthorized" }
  }
  const { data: agentRow, error: agentRowError } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("id", params.agentId)
    .eq("user_id", user.id)
    .maybeSingle()
  if (agentRowError) {
    return { success: false, error: `Agent lookup refused: ${agentRowError.message}` }
  }
  if (!agentRow) {
    return { success: false, error: "Unauthorized: agentId does not match authenticated user" }
  }
  if (!agentRow.brokerage_id) {
    return {
      success: false,
      error: "Your agent profile carries no brokerage, so the CMA would be written where no CMA surface can read it. No comps were purchased.",
    }
  }

  const result = await generateCmaReport(createServiceClient(), {
    brokerageId: agentRow.brokerage_id as string,
    agentUserId: user.id,
    params,
  })
  if (result?.success) revalidatePath("/dashboard/cma")
  return result
}

/**
 * Update CMA with new data
 */
export async function updateCMAReport(cmaId: string, updates: Partial<any>) {
  if (!isValidUUID(cmaId)) {
    return { success: false, error: "Invalid CMA ID" }
  }

  // Auth gate — previously open. Any caller could mutate any CMA in the
  // database (the price-strategy / valuation report that goes to sellers).
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = createServiceClient()

  try {
    // Strip caller-supplied tenant-control fields from the update payload
    const safeUpdates = { ...updates }
    delete safeUpdates.brokerage_id
    delete safeUpdates.id
    delete safeUpdates.agent_id

    const { data, error } = await supabase
      .from("cma_reports")
      .update({
        ...safeUpdates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", cmaId)
      .eq("brokerage_id", ctx.brokerageId)
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard/cma")
    return { success: true, cma: data }
  } catch (error) {
    console.error("[AI CMA] Update error:", error)
    return { success: false, error: "Failed to update CMA" }
  }
}

/**
 * Get CMA reports for agent
 */
export async function getCMAReports(agentId: string, filters?: { status?: string; contactId?: string }) {
  if (!isValidUUID(agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  // Auth gate — previously open. Any caller could read any agent's CMAs
  // by passing the agent_id.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = createServiceClient()

  try {
    // Always scope by caller's brokerage; agent_id narrows within it.
    let query = supabase
      .from("cma_reports")
      .select("*")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })

    if (filters?.status) {
      query = query.eq("status", filters.status)
    }
    if (filters?.contactId) {
      query = query.eq("contact_id", filters.contactId)
    }

    const { data, error } = await query

    if (error) throw error

    return { success: true, reports: data }
  } catch (error) {
    console.error("[AI CMA] Fetch error:", error)
    return { success: false, error: "Failed to fetch CMA reports" }
  }
}

/**
 * AI-powered price adjustment recommendation
 */
export async function getAIPriceAdjustmentRecommendation(
  cmaId: string,
  currentListPrice: number,
  daysOnMarket: number,
  showingCount: number,
  feedbackSummary?: string
) {
  if (!isValidUUID(cmaId)) {
    return { success: false, error: "Invalid CMA ID" }
  }

  // Auth gate — burns paid AI inference and reads sensitive CMA data.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = createServiceClient()

  try {
    // COLUMNS VERIFIED LIVE. This read was `select("*")` and the prompt below then
    // interpolated `cma.ai_valuation?.estimatedValue` and `cma.market_trends?.marketType`
    // — NEITHER COLUMN EXISTS on cma_reports (checked against
    // information_schema.columns: the valuation lives in recommended_price /
    // price_range_low / price_range_high and the market read is market_conditions).
    // `select("*")` is why nothing ever complained: the optional chains resolved
    // to undefined and the prompt shipped "AI Estimated Value: $Unknown / Market
    // Type: Unknown" on EVERY call. So every price-adjustment recommendation this
    // action has ever produced was made with no knowledge of what the CMA
    // concluded — it was reasoning from days-on-market and showing count alone
    // while presenting itself as an adjustment to a valuation it never saw.
    // The columns are now named explicitly, which is also what stops the next
    // phantom from hiding.
    const { data: cma, error: cmaError } = await supabase
      .from("cma_reports")
      .select("id, recommended_price, price_range_low, price_range_high, market_conditions, property_address, comparable_count")
      .eq("id", cmaId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    // A refused read must not fall through to "CMA not found" and must certainly
    // not fall through to a paid model call.
    if (cmaError) {
      console.error("[AI CMA] price adjustment CMA read failed:", cmaError.message)
      return { success: false, error: "Could not load that CMA." }
    }
    if (!cma) {
      return { success: false, error: "CMA not found" }
    }

    const valuationLine =
      cma.recommended_price != null
        ? `- CMA recommended price: $${Number(cma.recommended_price).toLocaleString()}` +
          (cma.price_range_low != null && cma.price_range_high != null
            ? ` (range $${Number(cma.price_range_low).toLocaleString()}–$${Number(cma.price_range_high).toLocaleString()})`
            : "")
        : "- CMA recommended price: not recorded on this report"

    const prompt = `As a real estate pricing strategist, analyze this listing's performance and recommend a price adjustment.

CURRENT SITUATION:
- Original List Price: $${currentListPrice.toLocaleString()}
- Days on Market: ${daysOnMarket}
- Number of Showings: ${showingCount}
- Showings per Week: ${(showingCount / Math.max(1, daysOnMarket / 7)).toFixed(1)}
- Feedback Summary: ${feedbackSummary || "No specific feedback"}

ORIGINAL VALUATION:
${valuationLine}
- Comparables used: ${cma.comparable_count ?? "not recorded"}
- Market conditions at the time of the CMA: ${cma.market_conditions || "not recorded"}

BENCHMARKS:
- If showings/week < 2 in seller's market = overpriced
- If showings/week < 1 in balanced market = significantly overpriced
- If DOM > 2x market average with low showings = price reduction needed

Provide adjustment recommendation in JSON:
{
  "recommendedAction": "reduce" | "hold" | "increase",
  "suggestedNewPrice": number,
  "percentageChange": number,
  "rationale": string,
  "urgency": "immediate" | "soon" | "monitor",
  "expectedImpact": string
}`

    const { text } = await generateText({
      brokerageId: ctx.brokerageId,
      userId: ctx.userId,
      agentId: ctx.agentId,
      model: "openai/gpt-4o",
      prompt,
    })

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const recommendation = JSON.parse(jsonMatch[0])
      
      // Log recommendation onto the canonical cma_price_adjustments columns
      // (cma_report_id/adjustment_type/adjustment_amount/rationale). The legacy
      // cma_id/current_price/recommended_price/recommendation/days_on_market/showing_count
      // columns never existed on the live table.
      // supabase-js RESOLVES a refused insert, so this `await` reported a logged
      // recommendation whether or not one was stored. `logged` carries the truth
      // to the caller instead; the recommendation itself is still returned,
      // because the model call is already paid for.
      const { error: adjustmentError } = await supabase.from("cma_price_adjustments").insert({
        cma_report_id: cmaId,
        adjustment_type: "price_recommendation",
        adjustment_amount: (recommendation.suggestedNewPrice ?? currentListPrice) - currentListPrice,
        rationale: `Recommended ${recommendation.recommendedAction ?? "adjustment"}: $${currentListPrice.toLocaleString()} → $${(recommendation.suggestedNewPrice ?? currentListPrice).toLocaleString()} (${recommendation.percentageChange ?? 0}%). DOM ${daysOnMarket}, ${showingCount} showings. ${recommendation.rationale ?? ""}`.trim(),
      })
      if (adjustmentError) {
        console.error("[AI CMA] cma_price_adjustments insert refused:", adjustmentError.message)
      }

      return { success: true, recommendation, logged: !adjustmentError }
    }

    return { success: false, error: "Failed to generate recommendation" }
  } catch (error) {
    console.error("[AI CMA] Price adjustment error:", error)
    return { success: false, error: "Failed to get price adjustment recommendation" }
  }
}
