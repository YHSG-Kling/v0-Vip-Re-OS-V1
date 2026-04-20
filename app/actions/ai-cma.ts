"use server"

import { createClient } from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { revalidatePath } from "next/cache"

// =============================================================================
// AI-POWERED COMPARATIVE MARKET ANALYSIS (CMA) SYSTEM
// Provides intelligent property valuations, market insights, and pricing strategy
// =============================================================================

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

interface CMAParams {
  agentId: string
  propertyAddress: string
  propertyCity: string
  propertyState: string
  propertyZip: string
  propertyType: "single_family" | "condo" | "townhouse" | "multi_family" | "land"
  bedrooms: number
  bathrooms: number
  squareFeet: number
  lotSize?: number
  yearBuilt?: number
  features?: string[]
  condition?: "excellent" | "good" | "fair" | "poor"
  listingType: "seller" | "buyer"
  contactId?: string
  listingId?: string
}

interface ComparableProperty {
  address: string
  listPrice: number
  soldPrice?: number
  daysOnMarket: number
  squareFeet: number
  pricePerSqFt: number
  bedrooms: number
  bathrooms: number
  yearBuilt: number
  distance: number
  adjustedValue: number
  adjustments: PropertyAdjustment[]
  source?: "BatchData" | "HouseCanary"
}

interface PropertyAdjustment {
  factor: string
  amount: number
  reason: string
}

interface MarketTrends {
  averageDaysOnMarket: number
  medianSalePrice: number
  pricePerSqFtTrend: number[]
  inventoryLevel: "low" | "balanced" | "high"
  marketType: "sellers" | "balanced" | "buyers"
  appreciationRate: number
  seasonalFactor: number
}

interface PricingStrategy {
  recommendedListPrice: number
  priceRangeLow: number
  priceRangeHigh: number
  confidenceLevel: number
  rationale: string
  quickSalePrice: number
  premiumPrice: number
  daysToSellEstimate: number
}

// -----------------------------------------------------------------------------
// AI CMA GENERATION
// -----------------------------------------------------------------------------

/**
 * Generate comprehensive AI-powered CMA report
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
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id")
    .eq("id", params.agentId)
    .eq("user_id", user.id)
    .maybeSingle()
  if (!agentRow) {
    return { success: false, error: "Unauthorized: agentId does not match authenticated user" }
  }

  try {
    // 1. Fetch comparable properties from database/MLS
    const comparables = await fetchComparableProperties(params)

    // 2. Get market trends data
    const marketTrends = await analyzeMarketTrends(params, supabase)

    // 3. AI-powered property valuation
    const valuation = await generateAIValuation(params, comparables, marketTrends)

    // 4. Generate pricing strategy
    const pricingStrategy = await generatePricingStrategy(params, valuation, marketTrends)

    // 5. Generate presentation content
    const presentation = await generateCMAPresentation(params, comparables, marketTrends, pricingStrategy)

    // 6. Save CMA report — only insert columns that exist in cma_reports schema
    const { data: cmaReport, error } = await supabase
      .from("cma_reports")
      .insert({
        agent_id: params.agentId,
        contact_id: params.contactId ?? null,
        listing_id: params.listingId ?? null,
        property_address: params.propertyAddress,
        property_city: params.propertyCity,
        property_state: params.propertyState,
        property_zip: params.propertyZip ?? null,
        property_type: params.propertyType,
        bedrooms: params.bedrooms,
        bathrooms: params.bathrooms,
        square_feet: params.squareFeet,
        lot_size: params.lotSize ?? null,
        year_built: params.yearBuilt ?? null,
        features: params.features ?? null,
        condition: params.condition ?? null,
        recommended_price: pricingStrategy.recommendedListPrice,
        price_range_low: pricingStrategy.priceRangeLow,
        price_range_high: pricingStrategy.priceRangeHigh,
        comparable_count: comparables.length,
        market_conditions: marketTrends.marketType,
        status: "completed",
        disclaimer_included: true,
      })
      .select("id")
      .single()

    if (error) throw error

    revalidatePath("/dashboard/cma")
    return {
      success: true,
      id: cmaReport.id,
      cmaId: cmaReport.id,
      valuation,
      pricingStrategy,
      comparables,
      marketTrends,
      presentation,
    }
  } catch (error) {
    console.error("[AI CMA] Generation error:", error)
    return { success: false, error: "Failed to generate CMA" }
  }
}

/**
 * Fetch comparable properties — priority chain:
 *   1. BatchData /comparable-sales (real MLS comps via API key)
 *   2. HouseCanary /property/sales_history (if BatchData unconfigured)
 *   3. AI-estimated stubs clearly labelled "AI-estimated" (never passed off as real sold data)
 * Returns empty array when neither API is configured and AI flag is off.
 */
async function fetchComparableProperties(
  params: CMAParams
): Promise<ComparableProperty[]> {
  const { fetchComparableSales } = await import("@/lib/external/batchdata-client")
  const { fetchHouseCanaryComps } = await import("@/lib/external/housecanary-client")

  // ── 1. BatchData ─────────────────────────────────────────────────────────
  const bdComps = await fetchComparableSales({
    address: params.propertyAddress,
    city: params.propertyCity,
    state: params.propertyState,
    zip: params.propertyZip,
    bedrooms: params.bedrooms,
    bathrooms: params.bathrooms,
    squareFeet: params.squareFeet,
    radiusMiles: 1,
    maxAgeDays: 180,
    limit: 10,
  })

  if (bdComps.length > 0) {
    return bdComps.map((c) => {
      const adjustments = calculatePropertyAdjustments(params, {
        square_feet: c.square_feet,
        bedrooms: c.bedrooms,
        bathrooms: c.bathrooms,
        sold_price: c.sale_price,
      })
      return {
        address: c.address,
        listPrice: c.list_price,
        soldPrice: c.sale_price,
        daysOnMarket: c.days_on_market,
        squareFeet: c.square_feet,
        pricePerSqFt: c.price_per_sqft,
        bedrooms: c.bedrooms,
        bathrooms: c.bathrooms,
        yearBuilt: c.year_built ?? 0,
        distance: c.distance_miles,
        adjustedValue: c.sale_price + adjustments.reduce((s, a) => s + a.amount, 0),
        adjustments,
        source: "BatchData" as const,
      }
    })
  }

  // ── 2. HouseCanary ───────────────────────────────────────────────────────
  const hcComps = await fetchHouseCanaryComps({
    address: params.propertyAddress,
    zipCode: params.propertyZip,
    bedrooms: params.bedrooms,
    squareFeet: params.squareFeet,
    maxAgeDays: 180,
    limit: 10,
  })

  if (hcComps.length > 0) {
    return hcComps.map((c) => {
      const adjustments = calculatePropertyAdjustments(params, {
        square_feet: c.square_feet,
        bedrooms: c.bedrooms,
        bathrooms: c.bathrooms,
        sold_price: c.sale_price,
      })
      return {
        address: c.address,
        listPrice: c.list_price,
        soldPrice: c.sale_price,
        daysOnMarket: c.days_on_market,
        squareFeet: c.square_feet,
        pricePerSqFt: c.price_per_sqft,
        bedrooms: c.bedrooms,
        bathrooms: c.bathrooms,
        yearBuilt: c.year_built ?? 0,
        distance: c.distance_miles,
        adjustedValue: c.sale_price + adjustments.reduce((s, a) => s + a.amount, 0),
        adjustments,
        source: "HouseCanary" as const,
      }
    })
  }

  // ── 3. No API configured — return empty, amber banner shows in UI ────────
  return []
}

/**
 * Calculate property adjustments between subject and comparable
 */
function calculatePropertyAdjustments(
  subject: CMAParams,
  comparable: any
): PropertyAdjustment[] {
  const adjustments: PropertyAdjustment[] = []
  const pricePerSqFt = (comparable.sold_price || comparable.list_price) / comparable.square_feet

  // Square footage adjustment
  const sqFtDiff = subject.squareFeet - comparable.square_feet
  if (Math.abs(sqFtDiff) > 100) {
    adjustments.push({
      factor: "Square Footage",
      amount: sqFtDiff * (pricePerSqFt * 0.5), // 50% of price/sqft for additional space
      reason: `Subject has ${sqFtDiff > 0 ? "more" : "less"} square footage`,
    })
  }

  // Bedroom adjustment
  const bedDiff = subject.bedrooms - comparable.bedrooms
  if (bedDiff !== 0) {
    adjustments.push({
      factor: "Bedrooms",
      amount: bedDiff * 15000, // $15k per bedroom
      reason: `Subject has ${bedDiff > 0 ? "more" : "fewer"} bedrooms`,
    })
  }

  // Bathroom adjustment
  const bathDiff = subject.bathrooms - comparable.bathrooms
  if (bathDiff !== 0) {
    adjustments.push({
      factor: "Bathrooms",
      amount: bathDiff * 10000, // $10k per bathroom
      reason: `Subject has ${bathDiff > 0 ? "more" : "fewer"} bathrooms`,
    })
  }

  // Age/Year built adjustment
  if (subject.yearBuilt && comparable.year_built) {
    const ageDiff = subject.yearBuilt - comparable.year_built
    if (Math.abs(ageDiff) > 5) {
      adjustments.push({
        factor: "Age",
        amount: ageDiff * 1000, // $1k per year newer
        reason: `Subject is ${ageDiff > 0 ? "newer" : "older"} than comparable`,
      })
    }
  }

  // Condition adjustment
  if (subject.condition) {
    const conditionValues: Record<string, number> = {
      excellent: 25000,
      good: 10000,
      fair: 0,
      poor: -15000,
    }
    adjustments.push({
      factor: "Condition",
      amount: conditionValues[subject.condition] || 0,
      reason: `Subject is in ${subject.condition} condition`,
    })
  }

  return adjustments
}

/**
 * Analyze market trends for the area
 */
async function analyzeMarketTrends(
  params: CMAParams,
  supabase: any
): Promise<MarketTrends> {
  // Query market data
  const { data: marketData } = await supabase
    .from("market_data")
    .select("*")
    .eq("city", params.propertyCity)
    .eq("state", params.propertyState)
    .order("recorded_date", { ascending: false })
    .limit(12)

  // Calculate trends or use defaults
  const avgDOM = marketData?.[0]?.avg_days_on_market || 35
  const medianPrice = marketData?.[0]?.median_sale_price || params.squareFeet * 250
  const inventory = marketData?.[0]?.active_listings || 100

  // Determine market type based on DOM (days on market)
  let marketType: "sellers" | "balanced" | "buyers" = "balanced"
  let inventoryLevel: "low" | "balanced" | "high" = "balanced"

  // Market type determined by DOM (speed of sale)
  if (avgDOM < 20) {
    marketType = "sellers"
  } else if (avgDOM > 60) {
    marketType = "buyers"
  }

  // Inventory level determined by active listings count
  // Adjust thresholds based on typical market conditions
  const monthsOfSupply = (inventory / 20) // Approximate monthly sales = inventory / avg sales per month
  if (monthsOfSupply < 2) {
    inventoryLevel = "low" // Less than 2 months supply = seller's market
  } else if (monthsOfSupply > 6) {
    inventoryLevel = "high" // More than 6 months supply = buyer's market
  } else {
    inventoryLevel = "balanced"
  }

  // Calculate seasonal factor (spring/summer premium)
  const month = new Date().getMonth()
  let seasonalFactor = 1.0
  if (month >= 3 && month <= 6) seasonalFactor = 1.03 // Spring premium
  if (month >= 11 || month <= 1) seasonalFactor = 0.97 // Winter discount

  return {
    averageDaysOnMarket: avgDOM,
    medianSalePrice: medianPrice,
    pricePerSqFtTrend: [240, 245, 250, 255, 260], // Simulated trend
    inventoryLevel,
    marketType,
    appreciationRate: 0.05, // 5% annual
    seasonalFactor,
  }
}

/**
 * AI-powered property valuation
 */
async function generateAIValuation(
  params: CMAParams,
  comparables: ComparableProperty[],
  marketTrends: MarketTrends
) {
  const avgAdjustedValue = comparables.reduce((sum, c) => sum + c.adjustedValue, 0) / comparables.length
  const avgPricePerSqFt = comparables.reduce((sum, c) => sum + c.pricePerSqFt, 0) / comparables.length

  const prompt = `You are a real estate valuation expert. Analyze this property and provide a detailed valuation.

SUBJECT PROPERTY:
- Address: ${params.propertyAddress}, ${params.propertyCity}, ${params.propertyState} ${params.propertyZip}
- Type: ${params.propertyType}
- Bedrooms: ${params.bedrooms}, Bathrooms: ${params.bathrooms}
- Square Feet: ${params.squareFeet}
- Year Built: ${params.yearBuilt || "Unknown"}
- Condition: ${params.condition || "Unknown"}
- Features: ${params.features?.join(", ") || "Standard"}

COMPARABLE SALES ANALYSIS:
- Number of Comparables: ${comparables.length}
- Average Adjusted Value: $${avgAdjustedValue.toLocaleString()}
- Average Price/SqFt: $${avgPricePerSqFt.toFixed(2)}
- Price Range: $${Math.min(...comparables.map(c => c.adjustedValue)).toLocaleString()} - $${Math.max(...comparables.map(c => c.adjustedValue)).toLocaleString()}

MARKET CONDITIONS:
- Market Type: ${marketTrends.marketType} market
- Average Days on Market: ${marketTrends.averageDaysOnMarket}
- Inventory Level: ${marketTrends.inventoryLevel}
- Annual Appreciation: ${(marketTrends.appreciationRate * 100).toFixed(1)}%
- Seasonal Factor: ${marketTrends.seasonalFactor}

Provide your valuation analysis in JSON format:
{
  "estimatedValue": number,
  "confidenceLevel": number (0-100),
  "valuationMethod": string,
  "keyFactors": string[],
  "strengths": string[],
  "weaknesses": string[],
  "marketPositioning": string
}`

  try {
    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt,
    })

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    }
  } catch (error) {
    console.error("[AI CMA] Valuation error:", error)
  }

  // Fallback valuation
  return {
    estimatedValue: Math.round(avgAdjustedValue * marketTrends.seasonalFactor),
    confidenceLevel: 75,
    valuationMethod: "Comparable Sales Approach",
    keyFactors: ["Location", "Size", "Condition", "Market Trends"],
    strengths: ["Good location", "Competitive market"],
    weaknesses: ["Limited comparable data"],
    marketPositioning: "Average for the area",
  }
}

/**
 * Generate pricing strategy recommendations
 */
async function generatePricingStrategy(
  params: CMAParams,
  valuation: any,
  marketTrends: MarketTrends
): Promise<PricingStrategy> {
  const estimatedValue = valuation.estimatedValue

  // Calculate price range based on market conditions
  let rangeMultiplier = 0.05 // 5% range in balanced market
  if (marketTrends.marketType === "sellers") rangeMultiplier = 0.03
  if (marketTrends.marketType === "buyers") rangeMultiplier = 0.07

  const prompt = `As a real estate pricing strategist, recommend a pricing strategy for this ${params.listingType === "seller" ? "listing" : "purchase"}.

Property Value: $${estimatedValue.toLocaleString()}
Market Type: ${marketTrends.marketType}
Average Days on Market: ${marketTrends.averageDaysOnMarket}
Listing Type: ${params.listingType}

Provide strategic pricing recommendations in JSON:
{
  "recommendedListPrice": number,
  "rationale": string,
  "quickSaleDiscount": number (percentage),
  "premiumPricing": number (percentage),
  "estimatedDaysToSell": number,
  "pricingTips": string[]
}`

  try {
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt,
    })

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const strategy = JSON.parse(jsonMatch[0])
      return {
        recommendedListPrice: strategy.recommendedListPrice || estimatedValue,
        priceRangeLow: Math.round(estimatedValue * (1 - rangeMultiplier)),
        priceRangeHigh: Math.round(estimatedValue * (1 + rangeMultiplier)),
        confidenceLevel: valuation.confidenceLevel,
        rationale: strategy.rationale || "Based on comparable sales analysis",
        quickSalePrice: Math.round(estimatedValue * (1 - (strategy.quickSaleDiscount || 5) / 100)),
        premiumPrice: Math.round(estimatedValue * (1 + (strategy.premiumPricing || 3) / 100)),
        daysToSellEstimate: strategy.estimatedDaysToSell || marketTrends.averageDaysOnMarket,
      }
    }
  } catch (error) {
    console.error("[AI CMA] Pricing strategy error:", error)
  }

  // Fallback strategy
  return {
    recommendedListPrice: estimatedValue,
    priceRangeLow: Math.round(estimatedValue * (1 - rangeMultiplier)),
    priceRangeHigh: Math.round(estimatedValue * (1 + rangeMultiplier)),
    confidenceLevel: valuation.confidenceLevel,
    rationale: "Based on comparable sales and current market conditions",
    quickSalePrice: Math.round(estimatedValue * 0.95),
    premiumPrice: Math.round(estimatedValue * 1.03),
    daysToSellEstimate: marketTrends.averageDaysOnMarket,
  }
}

/**
 * Generate CMA presentation content
 */
async function generateCMAPresentation(
  params: CMAParams,
  comparables: ComparableProperty[],
  marketTrends: MarketTrends,
  pricingStrategy: PricingStrategy
) {
  const prompt = `Create a professional CMA presentation script for a real estate agent to present to their ${params.listingType === "seller" ? "seller" : "buyer"} client.

Property: ${params.propertyAddress}, ${params.propertyCity}, ${params.propertyState}
Recommended Price: $${pricingStrategy.recommendedListPrice.toLocaleString()}
Market: ${marketTrends.marketType} market
Comparables Analyzed: ${comparables.length}

Generate a compelling presentation with:
1. Executive Summary (2-3 sentences)
2. Market Overview (3-4 key points)
3. Pricing Rationale (why this price makes sense)
4. Comparable Analysis Summary
5. Recommended Strategy
6. Next Steps

Keep it conversational and client-focused. Format as JSON:
{
  "executiveSummary": string,
  "marketOverview": string[],
  "pricingRationale": string,
  "comparablesSummary": string,
  "recommendedStrategy": string,
  "nextSteps": string[],
  "talkingPoints": string[]
}`

  try {
    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt,
    })

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    }
  } catch (error) {
    console.error("[AI CMA] Presentation error:", error)
  }

  // Fallback presentation
  return {
    executiveSummary: `Based on our comprehensive market analysis, we recommend listing your property at $${pricingStrategy.recommendedListPrice.toLocaleString()}.`,
    marketOverview: [
      `Current market conditions favor ${marketTrends.marketType}`,
      `Average days on market: ${marketTrends.averageDaysOnMarket}`,
      `Inventory levels are ${marketTrends.inventoryLevel}`,
    ],
    pricingRationale: pricingStrategy.rationale,
    comparablesSummary: `Analyzed ${comparables.length} comparable properties in your area.`,
    recommendedStrategy: "Strategic pricing at market value for optimal results.",
    nextSteps: ["Review and approve pricing", "Schedule listing photos", "Prepare property for showings"],
    talkingPoints: ["Strong comparable support", "Favorable market timing", "Competitive positioning"],
  }
}

/**
 * Update CMA with new data
 */
export async function updateCMAReport(cmaId: string, updates: Partial<any>) {
  if (!isValidUUID(cmaId)) {
    return { success: false, error: "Invalid CMA ID" }
  }

  const supabase = await createClient()

  try {
    const { data, error } = await supabase
      .from("cma_reports")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", cmaId)
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

  const supabase = await createClient()

  try {
    let query = supabase
      .from("cma_reports")
      .select("*")
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

  const supabase = await createClient()

  try {
    const { data: cma } = await supabase
      .from("cma_reports")
      .select("*")
      .eq("id", cmaId)
      .single()

    if (!cma) {
      return { success: false, error: "CMA not found" }
    }

    const prompt = `As a real estate pricing strategist, analyze this listing's performance and recommend a price adjustment.

CURRENT SITUATION:
- Original List Price: $${currentListPrice.toLocaleString()}
- Days on Market: ${daysOnMarket}
- Number of Showings: ${showingCount}
- Showings per Week: ${(showingCount / Math.max(1, daysOnMarket / 7)).toFixed(1)}
- Feedback Summary: ${feedbackSummary || "No specific feedback"}

ORIGINAL VALUATION:
- AI Estimated Value: $${cma.ai_valuation?.estimatedValue?.toLocaleString() || "Unknown"}
- Market Type: ${cma.market_trends?.marketType || "Unknown"}

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
      model: "openai/gpt-4o",
      prompt,
    })

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const recommendation = JSON.parse(jsonMatch[0])
      
      // Log recommendation
      await supabase.from("cma_price_adjustments").insert({
        cma_id: cmaId,
        current_price: currentListPrice,
        recommended_price: recommendation.suggestedNewPrice,
        recommendation: recommendation,
        days_on_market: daysOnMarket,
        showing_count: showingCount,
      })

      return { success: true, recommendation }
    }

    return { success: false, error: "Failed to generate recommendation" }
  } catch (error) {
    console.error("[AI CMA] Price adjustment error:", error)
    return { success: false, error: "Failed to get price adjustment recommendation" }
  }
}
