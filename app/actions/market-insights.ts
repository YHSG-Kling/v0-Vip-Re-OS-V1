"use server"

import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createClient } from "@/lib/supabase/server"
import { generateTextRouted } from "@/lib/ai/models"

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface MarketInsightResult {
  marketTemperature: "Seller's Market" | "Balanced Market" | "Buyer's Market"
  keyInsight: string
  actionItems: string[]
  opportunityAlert: string | null
  generatedAt: string
  snapshot: {
    avgListPrice: number | null
    avgSalePrice: number | null
    avgDaysOnMarket: number | null
    activeListings: number
    recentSales: number
    activeBuyerContacts: number
    totalBuyerContacts: number
  }
}

// ─── Helper: validate UUID ──────────────────────────────────────────────────────

function isValidUUID(id: any): id is string {
  return typeof id === "string" && id.length > 0 && id !== "null" && id !== "undefined"
}

// ─── Main Action ───────────────────────────────────────────────────────────────

export async function generateMarketInsights(): Promise<{
  insights: MarketInsightResult | null
  error?: string
}> {
  try {
    const context = await getAgentContext()

    if (!context.isAuthenticated) {
      return { insights: null, error: "Not authenticated" }
    }

    const { agentId, brokerageId } = context

    if (!isValidUUID(agentId) || !isValidUUID(brokerageId)) {
      return { insights: null, error: "Agent context not available" }
    }

    const supabase = await createClient()

    // ── 1. Query listings table ───────────────────────────────────────────────
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString()

    const [activeListingsResult, soldListingsResult, transactionsResult, buyerContactsResult] =
      await Promise.allSettled([
        // Active listings: avg list price, avg days on market, count
        supabase
          .from("listings")
          .select("id, list_price, days_on_market, status")
          .eq("agent_id", agentId)
          .eq("status", "active"),

        // Sold/closed listings in last 30 days
        supabase
          .from("listings")
          .select("id, list_price, sold_price, status")
          .eq("agent_id", agentId)
          .in("status", ["sold", "closed"])
          .gte("updated_at", thirtyDaysAgoStr)
          .limit(20),

        // Recent transactions (closings)
        supabase
          .from("transactions")
          .select("id, purchase_price, close_date, stage")
          .eq("agent_id", agentId)
          .in("stage", ["closed", "funded"])
          .gte("close_date", thirtyDaysAgo.toISOString().split("T")[0])
          .limit(20),

        // Buyer contacts: count all buyers and active-stage buyers
        supabase
          .from("contacts")
          .select("id, lead_type, lead_stage, status")
          .eq("agent_id", agentId)
          .in("lead_type", ["buyer", "Buyer"]),
      ])

    // ── 2. Process results ────────────────────────────────────────────────────

    const activeListings =
      activeListingsResult.status === "fulfilled"
        ? (activeListingsResult.value.data ?? [])
        : []

    const soldListings =
      soldListingsResult.status === "fulfilled"
        ? (soldListingsResult.value.data ?? [])
        : []

    const transactions =
      transactionsResult.status === "fulfilled"
        ? (transactionsResult.value.data ?? [])
        : []

    const buyerContacts =
      buyerContactsResult.status === "fulfilled"
        ? (buyerContactsResult.value.data ?? [])
        : []

    // Compute market snapshot from real DB data
    const activePrices = activeListings
      .map((l) => l.list_price)
      .filter((p): p is number => typeof p === "number" && p > 0)

    const avgListPrice =
      activePrices.length > 0
        ? Math.round(activePrices.reduce((a, b) => a + b, 0) / activePrices.length)
        : null

    const domValues = activeListings
      .map((l) => l.days_on_market)
      .filter((d): d is number => typeof d === "number" && d >= 0)

    const avgDaysOnMarket =
      domValues.length > 0
        ? Math.round(domValues.reduce((a, b) => a + b, 0) / domValues.length)
        : null

    // Average sale price: prefer sold listings sold_price, fall back to transactions purchase_price
    const salePrices: number[] = [
      ...soldListings
        .map((l) => l.sold_price ?? l.list_price)
        .filter((p): p is number => typeof p === "number" && p > 0),
      ...transactions
        .map((t) => t.purchase_price)
        .filter((p): p is number => typeof p === "number" && p > 0),
    ]

    const avgSalePrice =
      salePrices.length > 0
        ? Math.round(salePrices.reduce((a, b) => a + b, 0) / salePrices.length)
        : null

    const activeBuyerStages = new Set(["active", "hot", "nurture", "qualified", "touring"])
    const activeBuyerContacts = buyerContacts.filter(
      (c) =>
        activeBuyerStages.has((c.lead_stage ?? "").toLowerCase()) ||
        activeBuyerStages.has((c.status ?? "").toLowerCase())
    ).length

    const snapshot = {
      avgListPrice,
      avgSalePrice,
      avgDaysOnMarket,
      activeListings: activeListings.length,
      recentSales: soldListings.length + transactions.length,
      activeBuyerContacts,
      totalBuyerContacts: buyerContacts.length,
    }

    // ── 3. Call AI with the snapshot ──────────────────────────────────────────

    const systemPrompt = `You are a real estate market analyst AI. You analyze agent-specific pipeline data and generate actionable market insights. Be specific, data-driven, and focus on actionable recommendations.

Output ONLY valid JSON — no markdown, no extra text — matching this exact schema:
{
  "marketTemperature": "Seller's Market" | "Balanced Market" | "Buyer's Market",
  "keyInsight": "1 sentence with specific data point (e.g. 'Inventory is down 23% vs last month with only 4 active listings and an avg DOM of 18 days')",
  "actionItems": ["specific action 1", "specific action 2", "specific action 3"],
  "opportunityAlert": "1 sentence opportunity or null if none"
}

Rules:
- marketTemperature: Seller's Market if low inventory + fast DOM (<30 days), Buyer's Market if high inventory + slow DOM (>60 days), otherwise Balanced Market
- keyInsight: reference actual numbers from the snapshot
- actionItems: exactly 3, be specific to this agent's data (mention addresses/counts when available)
- opportunityAlert: highlight buyer/listing match opportunities or pricing opportunities — null if no clear opportunity`

    const userPrompt = `Generate market insights from this agent's pipeline data:

Market Snapshot:
- Active listings: ${snapshot.activeListings}
- Average list price: ${snapshot.avgListPrice ? `$${snapshot.avgListPrice.toLocaleString()}` : "No data"}
- Average days on market: ${snapshot.avgDaysOnMarket !== null ? `${snapshot.avgDaysOnMarket} days` : "No data"}
- Recent sales (last 30 days): ${snapshot.recentSales}
- Average sale price: ${snapshot.avgSalePrice ? `$${snapshot.avgSalePrice.toLocaleString()}` : "No data"}
- Active buyer contacts in pipeline: ${snapshot.activeBuyerContacts}
- Total buyer contacts: ${snapshot.totalBuyerContacts}

Price-to-sale ratio: ${snapshot.avgListPrice && snapshot.avgSalePrice ? ((snapshot.avgSalePrice / snapshot.avgListPrice) * 100).toFixed(1) + "%" : "No data"}

Generate insights that help this agent take action today.`

    const { text } = await generateTextRouted({
      feature: "market_insight_generation",
      system: systemPrompt,
      prompt: userPrompt,
      maxTokens: 600,
      temperature: 0.3,
    })

    // ── 4. Parse AI response ──────────────────────────────────────────────────

    let aiResult: {
      marketTemperature: MarketInsightResult["marketTemperature"]
      keyInsight: string
      actionItems: string[]
      opportunityAlert: string | null
    }

    try {
      const cleanedText = text.replace(/```json\n?|\n?```/g, "").trim()
      aiResult = JSON.parse(cleanedText)
    } catch {
      // Fallback if JSON parse fails
      aiResult = {
        marketTemperature:
          snapshot.avgDaysOnMarket !== null && snapshot.avgDaysOnMarket < 30
            ? "Seller's Market"
            : snapshot.avgDaysOnMarket !== null && snapshot.avgDaysOnMarket > 60
              ? "Buyer's Market"
              : "Balanced Market",
        keyInsight: `You have ${snapshot.activeListings} active listings with ${snapshot.recentSales} closings in the last 30 days.`,
        actionItems: [
          `Follow up with your ${snapshot.activeBuyerContacts} active buyer contacts`,
          `Review pricing on your ${snapshot.activeListings} active listings`,
          "Schedule time to update your market area comparables",
        ],
        opportunityAlert:
          snapshot.activeBuyerContacts > 0 && snapshot.activeListings > 0
            ? `${snapshot.activeBuyerContacts} active buyers in your pipeline — review for listing matches`
            : null,
      }
    }

    // Validate marketTemperature value
    const validTemperatures: MarketInsightResult["marketTemperature"][] = [
      "Seller's Market",
      "Balanced Market",
      "Buyer's Market",
    ]
    if (!validTemperatures.includes(aiResult.marketTemperature)) {
      aiResult.marketTemperature = "Balanced Market"
    }

    // Ensure actionItems is an array of exactly 3 strings
    if (!Array.isArray(aiResult.actionItems) || aiResult.actionItems.length === 0) {
      aiResult.actionItems = [
        "Review your active listings for pricing opportunities",
        "Follow up with active buyer contacts",
        "Update your CMA for current market conditions",
      ]
    }
    aiResult.actionItems = aiResult.actionItems.slice(0, 3)

    const result: MarketInsightResult = {
      marketTemperature: aiResult.marketTemperature,
      keyInsight: aiResult.keyInsight || "No market insight available",
      actionItems: aiResult.actionItems,
      opportunityAlert: aiResult.opportunityAlert || null,
      generatedAt: new Date().toISOString(),
      snapshot,
    }

    return { insights: result }
  } catch (err) {
    console.error("[MarketInsights] generateMarketInsights failed:", err)
    return {
      insights: null,
      error: err instanceof Error ? err.message : "Failed to generate market insights",
    }
  }
}
