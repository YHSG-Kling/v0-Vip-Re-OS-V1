/**
 * lib/buyer-search/market-watch.ts
 *
 * Wave 62 — SCHEDULED per-buyer market watch (the automated matcher). For each active
 * buyer it runs their saved criteria against:
 *   • OUR listings  → persists durable property_matches (we own this inventory), and
 *   • external MLS (RentCast/IDX, via the buyer-search engine) → COMPLIANT, DISPLAY-ONLY
 *     short-TTL references in saved_properties (no stored photos — re-fetched at view
 *     time per RentCast/MLS rules), purged on a TTL.
 *
 * System-context (no user session) — driven by the buyer-market-watch cron. Criteria
 * reading is consolidated in loadBuyerCriteria (the SAME normalized read the on-demand
 * matcher should use) against the CORRECT property_preferences columns — the live table
 * has no preferred_bedrooms/cities columns and listings uses list_price (not price), the
 * drift that left the old matcher returning zero matches for any buyer with a budget.
 *
 * scoreCriteriaFit is pure (unit-tested). The actual touches (reel + buyer message) stay
 * deliverable-gated downstream — this only produces the matches.
 */
import { createServiceClient } from "@/lib/supabase/service"

// Criteria reading consolidated into the single normalized reader (no per-consumer drift).
import { loadBuyerCriteria, type BuyerCriteria } from "./buyer-criteria"
export { loadBuyerCriteria, type BuyerCriteria }

export interface ListingFacts {
  list_price?: number | null
  bedrooms?:   number | null
  bathrooms?:  number | null
  city?:       string | null
}

/**
 * Pure deterministic criteria-fit score 0–100. Hard dealbreakers (over max budget,
 * under min beds) disqualify (0). Otherwise a qualifying listing scores 60 + bonuses
 * for in-budget floor, baths, and a city match. No AI, no API — cheap to run per buyer.
 */
export function scoreCriteriaFit(c: BuyerCriteria, l: ListingFacts): number {
  const price = typeof l.list_price === "number" ? l.list_price : null
  // Hard dealbreakers.
  if (c.maxPrice != null && price != null && price > c.maxPrice) return 0
  if (c.minBeds != null && typeof l.bedrooms === "number" && l.bedrooms < c.minBeds) return 0

  let score = 60
  if (c.minPrice != null && price != null && price >= c.minPrice) score += 10
  if (c.minBaths != null && typeof l.bathrooms === "number" && l.bathrooms >= c.minBaths) score += 10
  if (c.cities.length > 0) {
    const city = (l.city ?? "").toLowerCase().trim()
    score += c.cities.some((x) => x.toLowerCase().trim() === city) ? 20 : -15
  } else {
    score += 10 // no city constraint → neutral-positive
  }
  return Math.max(0, Math.min(100, score))
}

export const MATCH_FIT_THRESHOLD = 70

export interface MarketWatchResult { matched: number; newMatches: number; reason?: string }

/**
 * Run the market watch for ONE buyer over OUR active listings: score by criteria, upsert
 * property_matches for fits ≥ threshold. Idempotent (upsert on contact_id, property_id).
 * Returns how many matched + how many are NEW (so the cron can gate a touch). The external
 * RentCast/IDX path is layered on by the cron (connector-gated, compliant references).
 */
export async function runMarketWatchForBuyer(
  supabase: ReturnType<typeof createServiceClient>, brokerageId: string, contactId: string,
): Promise<MarketWatchResult> {
  if (!brokerageId || !contactId) return { matched: 0, newMatches: 0, reason: "missing ids" }
  const criteria = await loadBuyerCriteria(supabase, contactId)
  if (!criteria) return { matched: 0, newMatches: 0, reason: "no criteria" }

  // OUR active inventory (correct column: list_price). Pre-filter the obvious bounds in SQL;
  // the pure scorer makes the final call.
  let q = supabase.from("listings")
    .select("id, list_price, bedrooms, bathrooms, city")
    .eq("brokerage_id", brokerageId).eq("status", "active").limit(200)
  if (criteria.maxPrice != null) q = q.lte("list_price", criteria.maxPrice)
  if (criteria.minBeds != null) q = q.gte("bedrooms", criteria.minBeds)
  const { data: listings } = await q
  const rows = (listings ?? []) as Array<ListingFacts & { id: string }>
  if (rows.length === 0) return { matched: 0, newMatches: 0, reason: "no inventory" }

  // Which of these are already matched for this buyer (to count NEW).
  const ids = rows.map((r) => r.id)
  const { data: existing } = await supabase.from("property_matches")
    .select("property_id").eq("contact_id", contactId).eq("brokerage_id", brokerageId).in("property_id", ids)
  const already = new Set((existing ?? []).map((e: any) => e.property_id as string))

  let matched = 0, newMatches = 0
  const upserts: Array<Record<string, unknown>> = []
  for (const l of rows) {
    const score = scoreCriteriaFit(criteria, l)
    if (score < MATCH_FIT_THRESHOLD) continue
    matched++
    if (!already.has(l.id)) newMatches++
    upserts.push({
      brokerage_id: brokerageId, contact_id: contactId, property_id: l.id,
      match_score: score, ai_generated: false,
      match_reasons: { source: "market_watch", fit_score: score },
    })
  }
  if (upserts.length > 0) {
    await supabase.from("property_matches").upsert(upserts, { onConflict: "contact_id,property_id" })
  }
  return { matched, newMatches }
}
