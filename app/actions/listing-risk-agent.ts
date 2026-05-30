"use server"

/**
 * Listing Risk Radar — agent-facing reads.
 *
 * The listing-health-scan cron (migration 1030 / route created same commit)
 * runs every 12 hours and writes listing_health_scores per active listing.
 * This module surfaces those scores to the responsible LISTING agent for
 * the dashboard widget — mirrors getAgentAtRiskTransactions for transactions.
 *
 * Returns watch + at_risk + critical listings ranked by severity for the
 * agent's morning command card.
 */

import { createClient } from "@/lib/supabase/server"

export interface AgentListingRisk {
  listingId:         string
  propertyAddress:   string | null
  city:              string | null
  state:             string | null
  riskLevel:         "healthy" | "watch" | "at_risk" | "critical"
  healthScore:       number
  scoreDelta:        number | null
  daysOnMarket:      number | null
  topConcerns:       Array<{ category: string; severity: string; message: string }>
  scoredAt:          string
  openInterventions: number
  listPrice:         number | null
}

export async function getAgentAtRiskListings(params: {
  agentId:      string
  brokerageId?: string
  limit?:       number
}): Promise<AgentListingRisk[]> {
  const supabase = await createClient()
  const limit = params.limit ?? 5

  // 1. Most recent scores per listing where this agent owns the listing
  const { data: rows } = await supabase
    .from("listing_health_scores")
    .select(
      "listing_id, overall_score, previous_score, score_delta, risk_level, score_components, flags, days_on_market, scored_at, " +
        "listings!inner(address, city, state, agent_id, list_price, status)"
    )
    .in("risk_level", ["watch", "at_risk", "critical"])
    .order("scored_at", { ascending: false })
    .limit(80)

  if (!rows) return []

  const seenListing = new Set<string>()
  const out: AgentListingRisk[] = []

  for (const row of rows as unknown as Array<{
    listing_id: string
    overall_score: number
    previous_score: number | null
    score_delta: number | null
    risk_level: "watch" | "at_risk" | "critical"
    score_components: Array<{ category?: string; severity?: string; issues?: string[] }> | null
    flags: string[] | null
    days_on_market: number | null
    scored_at: string
    listings: {
      address: string | null
      city: string | null
      state: string | null
      agent_id: string | null
      list_price: number | null
      status: string | null
    } | null
  }>) {
    if (!row.listings) continue
    if (row.listings.agent_id !== params.agentId) continue
    // Only surface listings that are still on the market — don't nag the
    // agent about a listing that already went pending/closed.
    if (row.listings.status && !["active", "coming_soon"].includes(row.listings.status)) continue
    if (seenListing.has(row.listing_id)) continue
    seenListing.add(row.listing_id)

    // Build top-3 concerns from score_components (component-level) plus
    // top-line flags (overall-level) when component issues are sparse.
    const components = row.score_components ?? []
    const topFromComponents = components
      .filter((c) => Array.isArray(c.issues) && c.issues.length > 0 && (c.severity === "high" || c.severity === "critical"))
      .slice(0, 3)
      .map((c) => ({
        category: c.category ?? "general",
        severity: c.severity ?? "high",
        message: c.issues?.[0] ?? "",
      }))
    const topConcerns = topFromComponents.length > 0
      ? topFromComponents
      : (row.flags ?? []).slice(0, 3).map((m) => ({ category: "general", severity: "high", message: m }))

    out.push({
      listingId:        row.listing_id,
      propertyAddress:  row.listings.address,
      city:             row.listings.city,
      state:            row.listings.state,
      riskLevel:        row.risk_level,
      healthScore:      row.overall_score,
      scoreDelta:       row.score_delta,
      daysOnMarket:     row.days_on_market,
      topConcerns,
      scoredAt:         row.scored_at,
      openInterventions: 0,
      listPrice:        row.listings.list_price,
    })

    if (out.length >= limit) break
  }

  if (out.length === 0) return []

  // 2. Open interventions per listing
  const listingIds = out.map((r) => r.listingId)
  const { data: ivs } = await supabase
    .from("listing_health_interventions")
    .select("listing_id")
    .in("listing_id", listingIds)
    .eq("resolved", false)

  const ivCount = new Map<string, number>()
  for (const r of (ivs as Array<{ listing_id: string }>) ?? []) {
    ivCount.set(r.listing_id, (ivCount.get(r.listing_id) ?? 0) + 1)
  }
  for (const r of out) {
    r.openInterventions = ivCount.get(r.listingId) ?? 0
  }

  // Rank: critical → at_risk → watch; within each, lowest score first
  const order = { critical: 0, at_risk: 1, watch: 2, healthy: 3 } as const
  out.sort((a, b) => {
    const lvl = order[a.riskLevel] - order[b.riskLevel]
    if (lvl !== 0) return lvl
    return a.healthScore - b.healthScore
  })

  return out.slice(0, limit)
}
