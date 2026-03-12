import { generateAIResponse } from "@/lib/ai"
import { createServiceClient } from "@/lib/supabase/service"
import { processKernelEvent } from "@/lib/kernel"
import { KernelEvent } from "@/lib/kernel/events"

export interface PricePredictionResult {
  success: boolean
  predictionId?: string
  predictedPrice?: number
  confidenceScore?: number
  trendDirection?: "up" | "down" | "stable"
  trendPercentage?: number
  daysToSellEstimate?: number
  marketFactors?: Record<string, string>
  error?: string
}

/**
 * Generate AI price prediction for a listing.
 * Writes to price_predictions, records pricing_history, checks trend thresholds,
 * and fires PRICE_ALERT_TRIGGERED if warranted.
 */
export async function generatePricePrediction(
  listingId: string,
  brokerageId: string,
  actorUserId: string
): Promise<PricePredictionResult> {
  const supabase = createServiceClient()

  // Load listing
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("*")
    .eq("id", listingId)
    .single()

  if (listingError || !listing) {
    return { success: false, error: "Listing not found" }
  }

  // Load most recent CMA for price context
  const { data: cma } = await supabase
    .from("cma_reports")
    .select("recommended_price, price_range_low, price_range_high, market_conditions, quality_score, created_at")
    .eq("listing_id", listingId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Load pricing history for trend context
  const { data: priceHistory } = await supabase
    .from("pricing_history")
    .select("price, price_type, recorded_at")
    .eq("listing_id", listingId)
    .order("recorded_at", { ascending: false })
    .limit(10)

  // Load recent ai_comp_scores average for market quality signal
  const { data: compScores } = await supabase
    .from("ai_comp_scores")
    .select("score, confidence_level, created_at")
    .eq("listing_id", listingId)
    .order("created_at", { ascending: false })
    .limit(20)

  const avgCompScore =
    compScores && compScores.length > 0
      ? Math.round(compScores.reduce((sum, s) => sum + s.score, 0) / compScores.length)
      : null

  const historyContext =
    priceHistory && priceHistory.length > 0
      ? priceHistory
          .map(
            (h) =>
              `${h.price_type ?? "price"}: $${Number(h.price).toLocaleString()} on ${new Date(h.recorded_at).toLocaleDateString()}`
          )
          .join("\n")
      : "No prior pricing history"

  const prompt = `You are a real estate pricing AI. Generate a price prediction for this listing.

LISTING:
Address: ${listing.address ?? "unknown"}, ${listing.city ?? ""}, ${listing.state ?? ""}
Property Type: ${listing.property_type ?? "unknown"}
Beds: ${listing.bedrooms ?? "?"}  Baths: ${listing.bathrooms ?? "?"}  SqFt: ${listing.square_feet ?? "?"}
Current List Price: ${listing.list_price ? "$" + Number(listing.list_price).toLocaleString() : "not set"}
Lifecycle Stage: ${listing.lifecycle_stage ?? listing.status ?? "unknown"}

CMA CONTEXT:
${cma ? `Recommended Price: $${Number(cma.recommended_price).toLocaleString()}\nRange: $${Number(cma.price_range_low).toLocaleString()} - $${Number(cma.price_range_high).toLocaleString()}\nMarket: ${cma.market_conditions ?? "unknown"}\nCMA Quality Score: ${cma.quality_score ?? "?"}/100` : "No CMA available"}

COMP QUALITY: Average AI comp score ${avgCompScore ?? "unknown"}/100

PRICING HISTORY:
${historyContext}

Respond ONLY with valid JSON (no markdown):
{
  "predicted_price": <number>,
  "confidence_score": <integer 0-100>,
  "trend_direction": "<up|down|stable>",
  "trend_percentage": <number, positive decimal e.g. 2.5>,
  "days_to_sell_estimate": <integer>,
  "market_factors": {
    "supply_demand": "<brief note>",
    "seasonal": "<brief note>",
    "comp_pressure": "<brief note>",
    "days_on_market_trend": "<brief note>"
  }
}`

  let parsed: {
    predicted_price: number
    confidence_score: number
    trend_direction: string
    trend_percentage: number
    days_to_sell_estimate: number
    market_factors: Record<string, string>
  }

  try {
    const response = await generateAIResponse({
      prompt,
      maxTokens: 500,
      metadata: {
        userId: actorUserId,
        brokerageId: brokerageId,
        feature: "home_value_estimate",
      },
    })
    parsed = JSON.parse(response.text.trim())
  } catch {
    return { success: false, error: "AI prediction failed or returned invalid JSON" }
  }

  const predictedPrice = Math.round(Number(parsed.predicted_price) || 0)
  const confidenceScore = Math.max(0, Math.min(100, Number(parsed.confidence_score) || 0))
  const trendDirection = (["up", "down", "stable"].includes(parsed.trend_direction)
    ? parsed.trend_direction
    : "stable") as "up" | "down" | "stable"
  const trendPercentage = Math.abs(Number(parsed.trend_percentage) || 0)
  const daysToSellEstimate = Math.max(1, Number(parsed.days_to_sell_estimate) || 30)
  const marketFactors = parsed.market_factors ?? {}

  if (predictedPrice <= 0) {
    return { success: false, error: "AI returned invalid predicted price" }
  }

  // INSERT price_predictions
  const { data: inserted, error: insertError } = await supabase
    .from("price_predictions")
    .insert({
      listing_id: listingId,
      brokerage_id: brokerageId,
      predicted_price: predictedPrice,
      confidence_score: confidenceScore,
      trend_direction: trendDirection,
      trend_percentage: trendPercentage,
      days_to_sell_estimate: daysToSellEstimate,
      market_factors: marketFactors,
    })
    .select("id")
    .single()

  if (insertError || !inserted) {
    return { success: false, error: "Failed to save prediction" }
  }

  // Record in pricing_history
  await supabase.from("pricing_history").insert({
    listing_id: listingId,
    brokerage_id: brokerageId,
    price: predictedPrice,
    price_type: "ai_prediction",
    notes: `Confidence: ${confidenceScore}% | Trend: ${trendDirection} ${trendPercentage}%`,
  })

  // Check thresholds — insert price_trend_alert if needed
  const currentListPrice = Number(listing.list_price) || 0
  if (currentListPrice > 0) {
    const priceDeltaPct = Math.abs((predictedPrice - currentListPrice) / currentListPrice) * 100
    if (priceDeltaPct >= 5) {
      const severity = priceDeltaPct >= 10 ? "high" : "medium"
      const direction = predictedPrice < currentListPrice ? "below" : "above"
      await supabase.from("price_trend_alerts").insert({
        listing_id: listingId,
        brokerage_id: brokerageId,
        alert_type: "price_gap",
        severity,
        message: `AI prediction ($${predictedPrice.toLocaleString()}) is ${priceDeltaPct.toFixed(1)}% ${direction} current list price ($${currentListPrice.toLocaleString()}).`,
        recommended_action:
          direction === "below"
            ? "Consider a price reduction to align with market prediction."
            : "Market may support a higher list price — review comps.",
      })

      // Fire PRICE_ALERT_TRIGGERED kernel event
      await supabase.from("lifecycle_events").insert({
        brokerage_id: brokerageId,
        entity_type: "listing",
        entity_id: listingId,
        event_type: KernelEvent.PRICE_ALERT_TRIGGERED,
        actor_user_id: actorUserId,
        metadata: {
          prediction_id: inserted.id,
          predicted_price: predictedPrice,
          current_list_price: currentListPrice,
          delta_pct: priceDeltaPct,
          severity,
        },
      })
      await processKernelEvent({
        event: KernelEvent.PRICE_ALERT_TRIGGERED,
        brokerageId,
        entityType: "listing",
        entityId: listingId,
      }).catch(() => {})
    }
  }

  return {
    success: true,
    predictionId: inserted.id,
    predictedPrice,
    confidenceScore,
    trendDirection,
    trendPercentage,
    daysToSellEstimate,
    marketFactors,
  }
}
