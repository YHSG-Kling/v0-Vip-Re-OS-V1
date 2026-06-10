"use server"

import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createClient } from "@/lib/supabase/server"
import {
  generateMarketInsight,
  refreshMarketData,
  getLatestMarketInsight,
  getMarketData,
  getMarketTrends,
  getMarketDataSources,
} from "@/lib/intelligence/market-insight-generator"
import { generateObject } from "@/lib/ai/generate"
import { z } from "zod"

// ─── Get Market Sources ──────────────────────────────────────────────────────

export async function getAgentMarketSources() {
  const { brokerageId } = await getAgentContext()
  return getMarketDataSources(brokerageId!)
}

// ─── Add Market Source ───────────────────────────────────────────────────────

export async function addMarketSource(params: {
  marketArea: string
  city?: string
  state?: string
  zipCode?: string
}) {
  const { brokerageId, agentId } = await getAgentContext()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("market_data_sources")
    .insert({
      brokerage_id: brokerageId,
      market_area: params.marketArea,
      city: params.city || null,
      state: params.state || null,
      zip_codes: params.zipCode ? [params.zipCode] : [],
      is_active: true,
      source_type: "manual_import",
    })
    .select("id")
    .single()

  if (error) {
    throw new Error(`Failed to add market source: ${error.message}`)
  }

  // Trigger initial data refresh
  await refreshMarketData(
    brokerageId!,
    params.marketArea,
    params.zipCode,
    params.city,
    params.state
  )

  return { sourceId: data.id }
}

// ─── Refresh Market Data ─────────────────────────────────────────────────────

export async function refreshMarketDataAction(marketArea: string) {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  // Get source info
  const { data: source } = await supabase
    .from("market_data_sources")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("market_area", marketArea)
    .single()

  const result = await refreshMarketData(
    brokerageId!,
    marketArea,
    source?.zip_code,
    source?.city,
    source?.state
  )

  return result
}

// ─── Generate Insight ────────────────────────────────────────────────────────

export async function generateInsightAction(
  marketArea: string,
  forceRegenerate = false
) {
  const { brokerageId, agentId } = await getAgentContext()
  const supabase = await createClient()

  // Get source info for zipCode
  const { data: source } = await supabase
    .from("market_data_sources")
    .select("zip_code")
    .eq("brokerage_id", brokerageId)
    .eq("market_area", marketArea)
    .single()

  const result = await generateMarketInsight({
    brokerageId: brokerageId!,
    agentId: agentId!,
    marketArea,
    zipCode: source?.zip_code,
    forceRegenerate,
  })

  return result
}

// ─── Get Current Insight ─────────────────────────────────────────────────────

export async function getCurrentInsight(marketArea: string) {
  const { brokerageId } = await getAgentContext()
  return getLatestMarketInsight(brokerageId!, marketArea)
}

// ─── Get Market Stats ────────────────────────────────────────────────────────

export async function getCurrentMarketData(marketArea: string) {
  const { brokerageId } = await getAgentContext()
  return getMarketData(brokerageId!, marketArea)
}

// ─── Get Trend Data ──────────────────────────────────────────────────────────

export async function getTrendData(marketArea: string) {
  const { brokerageId } = await getAgentContext()
  return getMarketTrends(brokerageId!, marketArea, 6)
}

// ─── Get Recent CMA Reports ──────────────────────────────────────────────────

export async function getRecentCMAReports(marketArea: string) {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data } = await supabase
    .from("cma_reports")
    .select("id, property_address, estimated_value, created_at, agent_id")
    .eq("brokerage_id", brokerageId)
    .ilike("property_address", `%${marketArea}%`)
    .order("created_at", { ascending: false })
    .limit(10)

  return data || []
}

// ─── Generate Share Email ────────────────────────────────────────────────────

export async function generateMarketUpdateEmail(
  marketArea: string,
  contactIds: string[]
) {
  const { brokerageId, agentId } = await getAgentContext()
  const supabase = await createClient()

  // Get insight
  const insight = await getLatestMarketInsight(brokerageId!, marketArea)
  if (!insight) {
    throw new Error("No insight available for this market")
  }

  // Get agent info
  const { data: agent } = await supabase
    .from("agents")
    .select("first_name, last_name, email, phone")
    .eq("id", agentId)
    .single()

  // Generate email with AI
  const { object: email } = await generateObject({
    model: "anthropic/claude-sonnet-4-20250514",
    schema: z.object({
      subject: z.string(),
      body: z.string(),
    }),
    system:
      "You are a real estate agent writing a professional market update email to clients. Be informative but concise. Include a call to action.",
    prompt: `Generate a market update email for ${marketArea}.

Insight Data:
- Headline: ${insight.headline}
- Summary: ${insight.summary}
- Market Type: ${insight.price_trend === "up" ? "Seller's" : insight.price_trend === "down" ? "Buyer's" : "Balanced"} Market
- Median Price: $${insight.key_stats?.median_price?.toLocaleString() || "N/A"}
- Avg DOM: ${insight.key_stats?.dom || "N/A"} days
- Buyer Signals: ${insight.buyer_indicators?.join(", ") || "None"}
- Seller Signals: ${insight.seller_indicators?.join(", ") || "None"}

Agent: ${agent?.first_name} ${agent?.last_name}
Phone: ${agent?.phone || "N/A"}
Email: ${agent?.email || "N/A"}`,
  })

  return {
    subject: email.subject,
    body: email.body,
    contactIds,
    isDraft: true,
  }
}

// ─── Get Sellers in Market ───────────────────────────────────────────────────

export async function getSellersInMarket(marketArea: string) {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  // Get contacts with active seller listings in this market
  const { data } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone")
    .eq("brokerage_id", brokerageId)
    .eq("contact_type", "seller")
    .eq("status", "active")
    .ilike("address", `%${marketArea}%`)
    .limit(50)

  return data || []
}
