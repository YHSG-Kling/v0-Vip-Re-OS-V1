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

    const { agentId } = context

    if (!isValidUUID(agentId)) {
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
          .limit(200),

        // Recent transactions (closings)
        supabase
          .from("transactions")
          .select("id, purchase_price, close_date, stage")
          .eq("agent_id", agentId)
          .in("stage", ["closed", "funded"])
          .gte("close_date", thirtyDaysAgo.toISOString().split("T")[0])
          .limit(200),

        // Buyer contacts: count all buyers and active-stage buyers
        supabase
          .from("contacts")
          .select("id, lead_type, lead_stage, status")
          .eq("agent_id", agentId)
          .in("lead_type", ["buyer", "Buyer"]),
      ])

    // ── 2. Process results ────────────────────────────────────────────────────
    // null = query failed (data unavailable), [] = query succeeded but empty

    if (activeListingsResult.status === "rejected") {
      console.warn("[MarketInsights] active listings query failed:", activeListingsResult.reason)
    } else if (activeListingsResult.value.error) {
      console.warn("[MarketInsights] active listings query error:", activeListingsResult.value.error.message)
    }

    if (soldListingsResult.status === "rejected") {
      console.warn("[MarketInsights] sold listings query failed:", soldListingsResult.reason)
    } else if (soldListingsResult.value.error) {
      console.warn("[MarketInsights] sold listings query error:", soldListingsResult.value.error.message)
    }

    if (transactionsResult.status === "rejected") {
      console.warn("[MarketInsights] transactions query failed:", transactionsResult.reason)
    } else if (transactionsResult.value.error) {
      console.warn("[MarketInsights] transactions query error:", transactionsResult.value.error.message)
    }

    if (buyerContactsResult.status === "rejected") {
      console.warn("[MarketInsights] buyer contacts query failed:", buyerContactsResult.reason)
    } else if (buyerContactsResult.value.error) {
      console.warn("[MarketInsights] buyer contacts query error:", buyerContactsResult.value.error.message)
    }

    const activeListings =
      activeListingsResult.status === "fulfilled" && !activeListingsResult.value.error
        ? (activeListingsResult.value.data ?? [])
        : null

    const soldListings =
      soldListingsResult.status === "fulfilled" && !soldListingsResult.value.error
        ? (soldListingsResult.value.data ?? [])
        : null

    const transactions =
      transactionsResult.status === "fulfilled" && !transactionsResult.value.error
        ? (transactionsResult.value.data ?? [])
        : null

    const buyerContacts =
      buyerContactsResult.status === "fulfilled" && !buyerContactsResult.value.error
        ? (buyerContactsResult.value.data ?? [])
        : null

    // Compute market snapshot from real DB data
    const activePrices = (activeListings ?? [])
      .map((l) => l.list_price)
      .filter((p): p is number => typeof p === "number" && p > 0)

    const avgListPrice =
      activePrices.length > 0
        ? Math.round(activePrices.reduce((a, b) => a + b, 0) / activePrices.length)
        : null

    const domValues = (activeListings ?? [])
      .map((l) => l.days_on_market)
      .filter((d): d is number => typeof d === "number" && d >= 0)

    const avgDaysOnMarket =
      domValues.length > 0
        ? Math.round(domValues.reduce((a, b) => a + b, 0) / domValues.length)
        : null

    // Average sale price: prefer sold listings sold_price, fall back to transactions purchase_price
    const salePrices: number[] = [
      ...(soldListings ?? [])
        .map((l) => l.sold_price ?? l.list_price)
        .filter((p): p is number => typeof p === "number" && p > 0),
      ...(transactions ?? [])
        .map((t) => t.purchase_price)
        .filter((p): p is number => typeof p === "number" && p > 0),
    ]

    const avgSalePrice =
      salePrices.length > 0
        ? Math.round(salePrices.reduce((a, b) => a + b, 0) / salePrices.length)
        : null

    const activeBuyerStages = new Set(["active", "hot", "nurture", "qualified", "touring"])
    const activeBuyerContactsCount = (buyerContacts ?? []).filter(
      (c) =>
        activeBuyerStages.has((c.lead_stage ?? "").toLowerCase()) ||
        activeBuyerStages.has((c.status ?? "").toLowerCase())
    ).length

    const snapshot = {
      avgListPrice,
      avgSalePrice,
      avgDaysOnMarket,
      activeListings: activeListings != null ? activeListings.length : 0,
      recentSales: transactions != null
        ? transactions.length
        : (soldListings != null ? soldListings.length : 0),
      activeBuyerContacts: activeBuyerContactsCount,
      totalBuyerContacts: buyerContacts != null ? buyerContacts.length : 0,
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
- keyInsight: reference actual numbers from the snapshot; if a metric shows "data temporarily unavailable" treat it as unknown
- actionItems: exactly 3, be specific to this agent's data (mention addresses/counts when available)
- opportunityAlert: highlight buyer/listing match opportunities or pricing opportunities — null if no clear opportunity`

    const userPrompt = `Generate market insights from this agent's pipeline data:

Market Snapshot:
- ${activeListings != null ? `Active listings: ${snapshot.activeListings}` : "Active listings: data temporarily unavailable"}
- Average list price: ${snapshot.avgListPrice ? `$${snapshot.avgListPrice.toLocaleString()}` : "No data"}
- Average days on market: ${snapshot.avgDaysOnMarket !== null ? `${snapshot.avgDaysOnMarket} days` : "No data"}
- ${soldListings != null && transactions != null ? `Recent sales (last 30 days): ${snapshot.recentSales}` : "Recent sales (last 30 days): data temporarily unavailable"}
- Average sale price: ${snapshot.avgSalePrice ? `$${snapshot.avgSalePrice.toLocaleString()}` : "No data"}
- ${buyerContacts != null ? `Active buyer contacts in pipeline: ${snapshot.activeBuyerContacts}` : "Active buyer contacts in pipeline: data temporarily unavailable"}
- ${buyerContacts != null ? `Total buyer contacts: ${snapshot.totalBuyerContacts}` : "Total buyer contacts: data temporarily unavailable"}

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

    // Ensure actionItems is an array padded to exactly 3 strings
    const FALLBACK_ACTION_ITEMS = [
      "Follow up with your 3 most recent leads this week",
      "Schedule a market update call with your active clients",
      "Review your listing strategy for properties over 30 days on market",
    ]
    if (!Array.isArray(aiResult.actionItems)) {
      aiResult.actionItems = []
    }
    const parsedItems = (aiResult.actionItems as unknown[])
      .slice(0, 3)
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    aiResult.actionItems = [
      ...parsedItems,
      ...FALLBACK_ACTION_ITEMS.slice(parsedItems.length),
    ].slice(0, 3)

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
      error: "Unable to generate market insights. Please try again.",
    }
  }
}
