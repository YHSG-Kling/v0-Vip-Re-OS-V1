"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"

// ============================================================================
// AI MARKET INTELLIGENCE SYSTEM
// Real-time market trends, predictions, and actionable insights
// ============================================================================

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

  const supabase = await createClient()

  try {
    // Get market data from database
    const { data: marketData } = await supabase
      .from("market_data")
      .select("*")
      .or(`zip_code.eq.${params.zipCode},city.ilike.%${params.city}%,county.ilike.%${params.county}%`)
      .order("data_date", { ascending: false })
      .limit(100)

    // Get recent sales for analysis
    const { data: recentSales } = await supabase
      .from("listings")
      .select("*")
      .eq("status", "sold")
      .order("sold_date", { ascending: false })
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

    // Save the report
    const { data: report, error } = await supabase
      .from("market_reports")
      .insert({
        agent_id: params.agentId,
        report_type: "ai_market_intelligence",
        area: params.zipCode || params.city || params.county,
        property_type: params.propertyType,
        timeframe: params.timeframe,
        analysis: analysis,
        generated_at: new Date().toISOString()
      })
      .select()
      .single()

    return {
      success: true,
      report: analysis,
      reportId: report?.id
    }
  } catch (error) {
    console.error("[v0] Generate market report error:", error)
    return handleError(error, "generateMarketReport")
  }
}

/**
 * AI-powered price prediction for a specific property
 */
export async function predictPropertyPrice(params: {
  agentId: string
  propertyData: {
    address: string
    city: string
    state: string
    zipCode: string
    bedrooms: number
    bathrooms: number
    sqft: number
    lotSize?: number
    yearBuilt?: number
    propertyType: string
    features?: string[]
    condition?: string
  }
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get comparable sales
    const { data: comps } = await supabase
      .from("listings")
      .select("*")
      .eq("zip_code", params.propertyData.zipCode)
      .eq("status", "sold")
      .gte("bedrooms", params.propertyData.bedrooms - 1)
      .lte("bedrooms", params.propertyData.bedrooms + 1)
      .order("sold_date", { ascending: false })
      .limit(20)

    const { object: prediction } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        estimatedPrice: z.number(),
        priceRangeLow: z.number(),
        priceRangeHigh: z.number(),
        confidenceLevel: z.enum(["high", "medium", "low"]),
        pricePerSqft: z.number(),
        marketPositioning: z.enum(["below_market", "at_market", "above_market"]),
        comparablesSummary: z.string(),
        valueFactors: z.array(z.object({
          factor: z.string(),
          impact: z.enum(["positive", "negative", "neutral"]),
          adjustment: z.number(),
          explanation: z.string()
        })),
        listingRecommendation: z.object({
          suggestedListPrice: z.number(),
          strategy: z.string(),
          expectedDaysOnMarket: z.number()
        }),
        marketTiming: z.object({
          recommendation: z.enum(["list_now", "wait", "price_aggressively"]),
          reasoning: z.string()
        })
      }),
      prompt: `Predict the market value for this property:

Property Details:
${JSON.stringify(params.propertyData, null, 2)}

Comparable Sales:
${JSON.stringify(comps || [], null, 2)}

Provide:
1. Estimated market value with confidence range
2. Price per square foot analysis
3. Value adjustment factors (location, condition, features)
4. Optimal listing price recommendation
5. Market timing advice`
    })

    return {
      success: true,
      prediction
    }
  } catch (error) {
    console.error("[v0] Predict property price error:", error)
    return handleError(error, "predictPropertyPrice")
  }
}

/**
 * Get real-time market alerts for an agent's focus areas
 */
export async function getMarketAlerts(params: {
  agentId: string
  alertTypes?: ("price_change" | "new_listing" | "market_shift" | "opportunity")[]
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get agent's focus areas
    const { data: agentProfile } = await supabase
      .from("agents")
      .select("focus_areas, specializations")
      .eq("id", params.agentId)
      .single()

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

Agent Focus Areas: ${JSON.stringify(agentProfile?.focus_areas || [])}
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

  const supabase = await createClient()

  try {
    // Get listings in the area
    const { data: areaListings } = await supabase
      .from("listings")
      .select("*")
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
