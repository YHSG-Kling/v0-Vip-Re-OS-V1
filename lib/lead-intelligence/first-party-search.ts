// lib/lead-intelligence/first-party-search.ts
// ─────────────────────────────────────────────────────────────────────────────
// "LEAD PROPERTY SEARCHES STAY" — ON THEIR TRUTHFUL WRITER (wave 154, lane 154B; owner ruling R5, directive B3).
//
// Wave 153 retired the lead_property_searches read (app/actions/lead-intelligence.ts updateIntelligenceProfile) because its
// only writer scraped portal pages and never produced a row, and it retired google_search_activity because its writer filed a
// Google search ABOUT a person as that person's own behaviour. The PURPOSE — "what is this person looking for?" — survives on
// the one first-party writer that records a Contact's OWN search, with consent:
//   · lib/buyer-search/criteria-turn.ts recordStatedCriteriaTurn → property_preferences (per-field provenance, 'said' = the
//     buyer stated it) + buyer_criteria_utterances (literal words, parse, consent_basis stated by the door) — reached from the
//     portal search turn (app/actions/buyer-search/conversational-search.ts buyerConversationTurnAction, tenant from the
//     session gate), the voice call analysis and the email / SMS listener.
// This module is the PURE half the readers share: only fields the buyer SAID become profile preferences (an inferred or a
// default value is not their search), and the statements are summarised as counts / channels / consent bases — the words stay
// in the buyer's own "what you told us" view.
//
// TABLE DISPOSITION (CLAUDE.md §1 — every retirement names its survivor):
//   · lead_property_searches     — no genuine first-party event writes it; NOT restored. Survivor: buyer_criteria_utterances
//                                  (+ property_preferences provenance), read below. DROP is owner SQL (lane notes).
//   · google_search_activity     — a search engine never reports who searched; a results count is not a person's behaviour.
//                                  NOT restored, never repopulated. Survivor for a person's own search: the same as above.
//   · google_search_intelligence — aggregate phrase + "potential_leads_count" (a results count named as people). NOT
//                                  restored. Survivor for regional demand: lib/content-intel/search-demand.ts → the topic pool.

/** The subset of lib/buyer-search/buyer-criteria.ts BuyerCriteria this reader needs (structural — no import of the writer). */
export interface SaidCriteriaInput {
  minPrice: number | null
  maxPrice: number | null
  cities: string[]
  zipCodes: string[]
  propertyTypes: string[]
  provenance?: Partial<Record<string, { source: "said" | "inferred" | "default" }>>
}

export interface SaidSearchCriteria {
  propertyTypes: string[]
  locations: string[]
  /** "min-max" (either side may be empty) when the buyer SAID a price; null otherwise — never inferred. */
  priceRange: string | null
  /** Which fields were taken (all 'said'). */
  fields: string[]
}

/** PURE — only what the Contact SAID. A field without 'said' provenance is not their search and is left empty / null. */
export function saidSearchCriteria(c: SaidCriteriaInput | null | undefined): SaidSearchCriteria {
  const out: SaidSearchCriteria = { propertyTypes: [], locations: [], priceRange: null, fields: [] }
  if (!c) return out
  const said = (f: string) => c.provenance?.[f]?.source === "said"
  if (said("propertyTypes") && c.propertyTypes.length) { out.propertyTypes = [...new Set(c.propertyTypes)]; out.fields.push("propertyTypes") }
  const loc: string[] = []
  if (said("cities")) loc.push(...c.cities)
  if (said("zipCodes")) loc.push(...c.zipCodes)
  if (loc.length) { out.locations = [...new Set(loc)]; out.fields.push(...(said("cities") && c.cities.length ? ["cities"] : []), ...(said("zipCodes") && c.zipCodes.length ? ["zipCodes"] : [])) }
  const min = said("minPrice") ? c.minPrice : null
  const max = said("maxPrice") ? c.maxPrice : null
  if (min != null || max != null) { out.priceRange = `${min ?? ""}-${max ?? ""}`; out.fields.push(...(min != null ? ["minPrice"] : []), ...(max != null ? ["maxPrice"] : [])) }
  return out
}

export interface SearchStatementSummary {
  count: number
  lastAt: string | null
  channels: string[]
  consentBases: string[]
  /** Statements with no stated consent basis — counted, never treated as consented. */
  withoutStatedConsent: number
}

/** PURE — a Contact's own search statements as counts (no words). */
export function summarizeSearchStatements(rows: ReadonlyArray<{ channel: string | null; consent_basis: string | null; created_at: string | null }>): SearchStatementSummary {
  let lastAt: string | null = null
  const channels = new Set<string>(), bases = new Set<string>()
  let without = 0
  for (const r of rows) {
    if (r.created_at && (!lastAt || r.created_at > lastAt)) lastAt = r.created_at
    if (r.channel) channels.add(r.channel)
    if (r.consent_basis) bases.add(r.consent_basis)
    else without++
  }
  return { count: rows.length, lastAt, channels: [...channels], consentBases: [...bases], withoutStatedConsent: without }
}
