// lib/buyer-search/investor-offmarket-match.ts
//
// INVESTOR OFF-MARKET DEAL MATCH (Shopping Agent) — the buyer-side pure core. A qualified INVESTOR
// buyer (a lead the AI ISA converted to a contact on exhibited intent) carries a buy-box
// (property_preferences). Regular buyers are matched to MLS inventory by the existing retail matchers;
// investors want the OPPOSITE — OFF-MARKET distressed inventory, and the platform already scraped a pool
// of it (motivated-seller `leads`: probate / pre-foreclosure / tax-lien / tired-landlord / absentee /
// high-equity). This scores our off-market leads against the investor's box, GEOGRAPHY-GATED (an
// investor works specific markets — a property outside the box's cities/zips is not a match at all) and
// weighted by DISTRESS (the more motivated the seller, the better the deal). No property price/spec
// filter beyond geography+distress+equity: promoted leads carry address + motivation + equity, not full
// specs — honest about what we have (a fast-follow enriches beds/baths/ARV). Pure + unit-tested; the
// runner does the I/O.

import type { BuyerCriteria } from "@/lib/buyer-search/buyer-criteria"

/** The investor's buy-box is just their BuyerCriteria (reuses the canonical property_preferences reader). */
export type InvestorBox = BuyerCriteria

export interface OffMarketProperty {
  /** The source record id (a lead OR a promoted contact — see `stage`). */
  recordId: string
  /** Where this off-market record lives in the raw→lead→contact lineage. */
  stage: "lead" | "contact"
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  motivationType: string | null
  motivationConfidence: number | null
  equityEstimate: number | null
}

// Distress strength — the more motivated the seller, the better the investor deal (more discount room).
const MOTIVATION_STRENGTH: Record<string, number> = {
  probate: 1.0, pre_foreclosure: 1.0, foreclosure: 1.0, notice_of_sale: 1.0,
  tax_lien: 0.9, divorce: 0.85, tired_landlord: 0.8, absentee: 0.8,
  vacant: 0.7, distressed: 0.7, high_equity: 0.65, inherited: 0.9,
  expired: 0.6, expired_listing: 0.6,
}
function motivationStrength(t: string | null): number {
  if (!t) return 0.5
  return MOTIVATION_STRENGTH[t.toLowerCase().replace(/[\s-]+/g, "_")] ?? 0.5
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase()

/** GEOGRAPHY GATE — is this property inside the investor's box? zip is the tightest match, then city. */
export function inBoxGeography(box: InvestorBox, prop: OffMarketProperty): "zip" | "city" | null {
  const zips = (box.zipCodes ?? []).map(norm).filter(Boolean)
  const cities = (box.cities ?? []).map(norm).filter(Boolean)
  if (prop.zip && zips.includes(norm(prop.zip))) return "zip"
  if (prop.city && cities.includes(norm(prop.city))) return "city"
  return null
}

export interface OffMarketMatch extends OffMarketProperty {
  matchScore: number
  reasons: string[]
}

/**
 * PURE: score one off-market property against the investor's box, 0..1 — or null when it's outside the
 * box geography (a hard gate; an investor doesn't want deals in markets they don't work). Location
 * specificity + distress strength + equity room. Honest on missing equity (unknown → neutral-low, never
 * inflated).
 */
export function scoreOffMarketFit(box: InvestorBox, prop: OffMarketProperty): OffMarketMatch | null {
  const geo = inBoxGeography(box, prop)
  if (!geo) return null

  const reasons: string[] = []
  const location = geo === "zip" ? 1.0 : 0.75
  reasons.push(geo === "zip" ? `In a target ZIP (${prop.zip}).` : `In a target city (${prop.city}).`)

  const motivation = motivationStrength(prop.motivationType)
  if (prop.motivationType) reasons.push(`${prop.motivationType.replace(/_/g, " ")} — motivated seller.`)

  let equityNorm = 0.3 // unknown equity → neutral-low, not inflated
  if (prop.equityEstimate != null && Number.isFinite(prop.equityEstimate)) {
    equityNorm = Math.min(1, Math.max(0, prop.equityEstimate / 300_000))
    if (prop.equityEstimate > 0) reasons.push(`~$${Math.round(prop.equityEstimate).toLocaleString()} estimated equity (room to negotiate).`)
  }

  const score = 0.45 * location + 0.35 * motivation + 0.20 * equityNorm
  return { ...prop, matchScore: Math.round(Math.min(1, Math.max(0, score)) * 100) / 100, reasons }
}

/** The bar below which an off-market deal isn't worth surfacing to the investor. */
export const OFFMARKET_THRESHOLD = 0.55

/**
 * PURE: rank the off-market properties for this investor's box, highest fit first, geography-gated
 * (out-of-box properties are dropped entirely — never surfaced as weak matches). Deduped across the
 * lineage: the SAME property can arrive as both a lead and its promoted contact, so we key by
 * normalized address (falling back to stage:recordId) and PREFER the contact stage — the canonical
 * single source of truth after promotion (raw → lead → contact).
 */
export function rankOffMarketMatches(box: InvestorBox, props: OffMarketProperty[]): OffMarketMatch[] {
  const byKey = new Map<string, OffMarketProperty>()
  for (const p of props) {
    const addr = norm(p.address)
    const key = addr || `${p.stage}:${p.recordId}`
    const prior = byKey.get(key)
    // Keep the canonical (contact) record when the same address appears at both stages.
    if (!prior || (prior.stage === "lead" && p.stage === "contact")) byKey.set(key, p)
  }
  const out: OffMarketMatch[] = []
  for (const p of byKey.values()) {
    const m = scoreOffMarketFit(box, p)
    if (m) out.push(m)
  }
  out.sort((a, b) => b.matchScore - a.matchScore)
  return out
}

/** The matches worth surfacing (at/above the bar). */
export function qualifiedOffMarketDeals(matches: OffMarketMatch[]): OffMarketMatch[] {
  return matches.filter((m) => m.matchScore >= OFFMARKET_THRESHOLD)
}

/** True when the box has enough geography to match on (an investor without a market can't be matched). */
export function boxHasGeography(box: InvestorBox | null): boolean {
  return !!box && ((box.cities?.length ?? 0) > 0 || (box.zipCodes?.length ?? 0) > 0)
}
