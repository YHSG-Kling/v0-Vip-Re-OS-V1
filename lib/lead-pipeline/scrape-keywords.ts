// lib/lead-pipeline/scrape-keywords.ts
//
// SCRAPE KEYWORDS — the ONE place a keyword-reading scrape source gets its search terms (lane 83A,
// wave 83; owner verbatim: "on scrape sources, make sure keywords are setup and correct.").
//
// WHAT WAS WRONG (measured 2026-09-26 against live hrvaqgvukzxfskkcrwbt):
//   • lead_scraping_keywords held 0 rows. Every keyword lane in the cron (Nextdoor, Facebook groups,
//     Instagram, Reddit, Craigslist) was gated on `keywordsBySource[...]`, so none of them ever ran.
//   • Nothing could have written a row: the admin panel offered keyword types
//     buying_intent/selling_intent/life_event/distress/custom, and the live CHECK
//     (lead_scraping_keywords_keyword_type_check) admits only buyer/motivated_seller/fsbo/expired/
//     investor — every insert was refused; the insert also never stamped the NOT NULL brokerage_id
//     and left `sources` at its '{}' default (a row that applies to no source).
//   • The cron read EVERY brokerage's rows for every territory (no brokerage predicate), and typed a
//     Nextdoor match as buyer only when keyword_type === "buying_intent" — a value the CHECK refuses —
//     so every Nextdoor match would have been filed as a SELLER.
//   • Craigslist joined three keywords with spaces — Craigslist search ANDs words — and the fixed
//     "wanted" query ANDed eight words, so both queries matched next to nothing.
//
// THE RULE NOW: every keyword-reading source has a CODE-DEFAULT set per population it declares in
// acquisition-coverage.ts::SOURCE_ACQUISITION (seller / buyer / relocation / realtor-seeking /
// investor), rendered per TERRITORY at run time ({city}/{state} tokens) — so a territory never runs
// keywordless and never needs a seeding job. A brokerage's own lead_scraping_keywords rows ADD to the
// defaults for its own territories only. Every default term must classify back to its own
// population through classifyIntentText (scripts/scrape-keywords-guard.ts proves it), which is what
// "correct" means here: the same lexicon that picks the search term reads the post it finds.

import type { SourceKey } from "./source-intent-map"
import { resolveSourceKey } from "./source-intent-map"
import { SOURCE_ACQUISITION, type AcquisitionIntent } from "./acquisition-coverage"

// ─── Lexicon — reads a post/comment/query into populations ───────────────────

const INTENT_PATTERNS: Record<AcquisitionIntent, RegExp> = {
  sell: /\b(sell(ing)?\s+(my|our|the|a)\s+(house|home|condo|townhouse|property|place)|thinking (of|about) selling|for sale by owner|fsbo|by owner|list(ing)? (my|our) (house|home)|what('?s| is) my (house|home) worth|how much (is|would|could) (my|our) (house|home)|home valuation|make me move|need to sell|downsiz\w*|inherited (a |the )?(house|home|property)|estate sale|behind on (my |our )?mortgage|pre-?foreclosure|tired landlord|cash offer for (my|our) (house|home))\b/i,
  buy: /\b(looking to buy|house hunting|home ?search(ing)?|first[- ]time (home ?)?buyers?|first home|pre-?approved|buying (a|our first|my first) (house|home|condo)|iso\b|in search of|wanted to buy|looking for (a|an) (house|home|condo|townhouse)|homes? for sale)\b/i,
  relocate: /\b(moving to|moving (here|there|back)|relocat(ing|ion|e)\b|job transfer|transferr?(ing|ed) to|new job in|pcs(ing)? to)\b/i,
  realtor_seeking: /\b(recommend(ation)?s? (for )?(a|an|me a|your|any)? ?(good |great )?(realtor|real estate agent|agent|buyer'?s agent|listing agent)|(realtor|agent) recommendations?|need (a|an) (good |great )?(realtor|real estate agent|agent)|looking for (a|an) (good |great )?(realtor|real estate agent|agent)|best (realtor|real estate agent)|iso (a )?realtor|who (did you|do you) use to (buy|sell))\b/i,
  investor: /\b(investment propert(y|ies)|rental propert(y|ies)|income propert(y|ies)|cash buyers?|cash flow|1031|fix(-| and | ?& ?)flip|buy and hold|off[- ]market|wholesal\w*|brrrr|multifamily|duplex|tenant[- ]occupied|cap rate|(real estate )?investors?)\b/i,
}

/** PURE — every population a piece of text evidences (a post, a comment, a search term). */
export function classifyIntentText(text: string | null | undefined): AcquisitionIntent[] {
  const t = String(text ?? "")
  if (!t.trim()) return []
  return (Object.keys(INTENT_PATTERNS) as AcquisitionIntent[]).filter((i) => INTENT_PATTERNS[i].test(t))
}

/** The canonical signal a normalizer stamps per population (acquisition-coverage.ts reads these). */
const INTENT_SIGNAL: Record<AcquisitionIntent, string> = {
  sell: "selling", buy: "looking_to_buy", relocate: "relocating", realtor_seeking: "need_a_realtor", investor: "investor",
}

/** PURE — canonical intent signals for a text (added by every social normalizer beside its own). */
export function intentSignalsFromText(text: string | null | undefined): string[] {
  return classifyIntentText(text).map((i) => INTENT_SIGNAL[i])
}

/**
 * PURE — the record-level intentType a text resolves to. A relocator and an investor are buyers
 * (they acquire); a person only asking for an agent stays "unknown" (buyer or seller is resolved at
 * enrichment/qualification) unless the same text also says which.
 */
export function intentTypeFromText(text: string | null | undefined): "buyer" | "seller" | "unknown" {
  const i = new Set(classifyIntentText(text))
  const sells = i.has("sell")
  const buys = i.has("buy") || i.has("relocate") || i.has("investor")
  if (sells && !buys) return "seller"
  if (buys && !sells) return "buyer"
  return "unknown"
}

// ─── Per-source policy ───────────────────────────────────────────────────────

/** How a source spends its terms: an OR search string, a list of search terms, or hashtags. */
export type KeywordShape = "or_query" | "terms" | "hashtags"

export type KeywordPolicy =
  | { reads: true; shape: KeywordShape; /** terms per population per run — bounds the spend */ perIntent: number }
  | { reads: false; why: string }

/**
 * EVERY SourceKey says whether it reads keywords — compile-enforced, so a new source cannot be
 * added without answering. The `why` of a non-reader is the documentation the owner asked for.
 */
export const SCRAPE_KEYWORD_POLICY: Record<SourceKey, KeywordPolicy> = {
  nextdoor_intent:      { reads: true, shape: "or_query", perIntent: 2 },
  facebook_group:       { reads: true, shape: "terms", perIntent: 3 },
  facebook_marketplace: { reads: true, shape: "terms", perIntent: 2 },
  instagram_intent:     { reads: true, shape: "hashtags", perIntent: 2 },
  reddit_intent:        { reads: true, shape: "terms", perIntent: 3 },
  craigslist_fsbo:      { reads: true, shape: "or_query", perIntent: 3 },
  craigslist_wanted:    { reads: true, shape: "or_query", perIntent: 3 },
  // tiktok_intent's keyword policy retired with the SourceKey (lane 84C; owner 2026-09-26
  // "don't need tiktok." — lib/lead-pipeline/source-intent-map.ts carries the tombstone).
  batchdata_motivated:         { reads: false, why: "BatchData quickLists (motivation triggers from lead_scraping_motivated_params), not text search" },
  expired_listing:             { reads: false, why: "BatchData 'expired-listing' quickList — structured, no text" },
  batchdata_smart_search:      { reads: false, why: "BatchData subscription push (webhook) — criteria, no text" },
  batchdata_buybox:            { reads: false, why: "BatchData Buy Box — investor criteria per listing" },
  batchdata_cash_buyer:        { reads: false, why: "BatchData 'cash-buyer' quickList — structured owner list" },
  zenrows_zillow:              { reads: false, why: "portal FSBO/saved-search pages built from lead_scraping_property_params (price/beds), not keywords" },
  zenrows_realtor:             { reads: false, why: "portal FSBO/saved-search pages built from lead_scraping_property_params" },
  zenrows_homes:               { reads: false, why: "portal FSBO/saved-search pages built from lead_scraping_property_params" },
  realty_site_chatter:         { reads: false, why: "the territory's own portal market page; buyer/seller/agent CTAs are DOM markers (scraper-parsers.ts), not search terms" },
  google_phrase_intent:        { reads: false, why: "territory phrases from source-intent-map.ts::buildTerritoryPhrases" },
  agent_seeking_phrase_intent: { reads: false, why: "territory phrases from buildAgentSeekingPhrases" },
  new_construction_intent:     { reads: false, why: "territory phrases from buildNewConstructionPhrases" },
  reddit_relocation:           { reads: false, why: "fixed territory relocation + agent-seeking phrase set (social-sourcer.ts::sourceRedditRelocation)" },
  facebook_recommend_realtor:  { reads: false, why: "fixed 'recommend a realtor' phrase set against the territory's groups" },
  linkedin_relocation:         { reads: false, why: "fixed new-role/relocation phrases + the territory location" },
  rental_listing:              { reads: false, why: "Craigslist 'apa' section, fixed by-owner query" },
  exa_buyer_intent:            { reads: false, why: "Exa neural queries built from the territory (exa-sourcer.ts)" },
  tavily_intent:               { reads: false, why: "Tavily queries built from the territory (tavily-sourcer.ts)" },
  permit_prelisting_intent:    { reads: false, why: "Exa permit/probate/coming-soon queries built from the territory (permit-sourcer.ts)" },
  osint_signal:                { reads: false, why: "public court/record filings by territory" },
  review_acquisition_intent:   { reads: false, why: "the tenant's own configured review page URLs" },
  external_behavior:           { reads: false, why: "portal property-view discovery by territory (lead-intelligence.ts)" },
  site_visitor_intent:         { reads: false, why: "first-party website dwell data" },
  email_engagement_intent:     { reads: false, why: "first-party email engagement data" },
  rental_to_buyer_graduation:  { reads: false, why: "the tenant's own renter contacts" },
  inbound_email_unknown:       { reads: false, why: "the tenant's own inbound mailbox (AI-classified)" },
}

/** Derived — never a hand list. */
export const KEYWORD_SOURCE_KEYS: SourceKey[] = (Object.keys(SCRAPE_KEYWORD_POLICY) as SourceKey[])
  .filter((k) => SCRAPE_KEYWORD_POLICY[k].reads)

// ─── Defaults (territory tokens {city} / {state}) ────────────────────────────
// Sources: platform listening vocabulary used by seller-intent monitors (SellerRadar: relocation,
// inheritance, downsizing on Reddit/Facebook groups/Nextdoor/Craigslist), motivated-seller PPC lists
// (reimarketingpro.com 2026: urgency/condition/situation words), Nextdoor agent playbooks
// (realestateagentleads.com 2026-05).

export const DEFAULT_SCRAPE_KEYWORDS: Record<string, Partial<Record<AcquisitionIntent, readonly string[]>>> = {
  nextdoor_intent: {
    sell: ["thinking of selling", "what is my home worth", "downsizing"],
    buy: ["looking to buy a house", "house hunting", "first time home buyer"],
    relocate: ["moving to {city}", "relocating to {city}", "job transfer"],
    realtor_seeking: ["recommend a realtor", "need a real estate agent", "looking for a realtor"],
  },
  facebook_group: {
    sell: ["thinking of selling", "selling my house", "for sale by owner", "how much is my house worth"],
    buy: ["looking to buy a house", "house hunting", "pre-approved"],
    relocate: ["moving to {city}", "relocating to {city}", "job transfer to {city}"],
    realtor_seeking: ["recommend a realtor", "need a realtor", "looking for a real estate agent"],
    investor: ["investment property", "cash buyer", "off market"],
  },
  facebook_marketplace: {
    sell: ["house for sale by owner", "fsbo"],
    buy: ["ISO house", "looking to buy a house", "wanted to buy house"],
    relocate: ["relocating to {city}", "moving to {city}"],
    realtor_seeking: ["looking for a realtor", "need a realtor"],
  },
  instagram_intent: {
    sell: ["{city} fsbo", "for sale by owner {city}"],
    buy: ["house hunting {city}", "first time home buyer"],
    relocate: ["moving to {city}", "relocating to {city}"],
  },
  reddit_intent: {
    sell: ["selling my house", "thinking about selling", "inherited a house"],
    buy: ["looking to buy", "first time home buyer", "house hunting"],
    investor: ["investment property", "rental property", "buy and hold"],
  },
  craigslist_fsbo: {
    sell: ["by owner", "fsbo", "for sale by owner"],
    investor: ["investment property", "tenant occupied", "cash flow"],
  },
  craigslist_wanted: {
    buy: ["wanted to buy", "ISO house", "looking for a house"],
    relocate: ["relocating to {city}", "moving to {city}"],
    investor: ["cash buyer", "investor looking to buy"],
  },
  // tiktok_intent's default terms retired with the SourceKey (lane 84C; owner 2026-09-26
  // "don't need tiktok.").
}

// ─── Brokerage keyword rows (lead_scraping_keywords) ─────────────────────────

/** lead_scraping_keywords.keyword_type → population. relocation / realtor_seeking land with m662. */
export const KEYWORD_TYPE_INTENT: Record<string, AcquisitionIntent> = {
  buyer: "buy",
  motivated_seller: "sell",
  fsbo: "sell",
  expired: "sell",
  investor: "investor",
  relocation: "relocate",
  realtor_seeking: "realtor_seeking",
}

export interface ScrapeKeywordRow {
  brokerage_id?: string | null
  keyword: string
  keyword_type?: string | null
  sources?: string[] | null
  weight?: number | null
  is_active?: boolean | null
}

export interface ResolvedKeywords {
  source: SourceKey
  /** Population → rendered terms (defaults first, then this brokerage's rows). */
  byIntent: Partial<Record<AcquisitionIntent, string[]>>
  /** Round-robin across populations, capped per population — slicing never drops a population. */
  terms: string[]
  fromBrokerageRows: number
}

function render(term: string, market: { city?: string | null; state?: string | null }, shape: KeywordShape): string | null {
  if (/\{city\}/.test(term) && !market.city) return null
  if (/\{state\}/.test(term) && !market.state) return null
  const t = term.replace(/\{city\}/g, market.city ?? "").replace(/\{state\}/g, market.state ?? "").replace(/\s+/g, " ").trim()
  if (shape === "hashtags") return t.toLowerCase().replace(/[^a-z0-9]/g, "") || null
  return t || null
}

/**
 * PURE — the keyword set ONE territory runs for ONE source: the code defaults for every population
 * the source declares, plus the market's OWN brokerage's active rows whose `sources` resolve to this
 * source (a Craigslist row lands on whichever Craigslist lane declares its population). Rows of any
 * other brokerage are never read (the cron used to read every tenant's rows for every territory).
 */
export function resolveSourceKeywords(
  source: SourceKey,
  market: { city?: string | null; state?: string | null; brokerage_id?: string | null },
  rows: readonly ScrapeKeywordRow[] = [],
): ResolvedKeywords {
  const policy = SCRAPE_KEYWORD_POLICY[source]
  const empty: ResolvedKeywords = { source, byIntent: {}, terms: [], fromBrokerageRows: 0 }
  if (!policy.reads) return empty
  const declared = SOURCE_ACQUISITION[source].intents
  const byIntent: Partial<Record<AcquisitionIntent, string[]>> = {}
  const add = (i: AcquisitionIntent, term: string) => {
    const r = render(term, market, policy.shape)
    if (!r) return
    const list = (byIntent[i] ??= [])
    if (!list.some((x) => x.toLowerCase() === r.toLowerCase())) list.push(r)
  }
  for (const i of declared) for (const t of DEFAULT_SCRAPE_KEYWORDS[source]?.[i] ?? []) add(i, t)

  let fromBrokerageRows = 0
  for (const row of rows) {
    if (row.is_active === false || !row.keyword?.trim()) continue
    if (!market.brokerage_id || row.brokerage_id !== market.brokerage_id) continue
    const intent = (row.keyword_type && KEYWORD_TYPE_INTENT[row.keyword_type]) || classifyIntentText(row.keyword)[0]
    if (!intent || !declared.includes(intent)) continue
    const targets = (row.sources ?? []).map((s) => resolveSourceKey(s))
    const craigslist = targets.some((k) => k === "craigslist_fsbo" || k === "craigslist_wanted")
    const hit = targets.includes(source) || (craigslist && (source === "craigslist_fsbo" || source === "craigslist_wanted"))
    if (!hit) continue
    add(intent, row.keyword.trim())
    fromBrokerageRows++
  }

  const terms: string[] = []
  const lists = declared.map((i) => (byIntent[i] ?? []).slice(0, policy.perIntent))
  for (let n = 0; n < policy.perIntent; n++) for (const l of lists) if (l[n]) terms.push(l[n])
  return { source, byIntent, terms, fromBrokerageRows }
}

/** PURE — the search string an or_query source sends (Craigslist `|`, Nextdoor OR). */
export function renderKeywordQuery(source: SourceKey, terms: readonly string[]): string {
  if (source === "craigslist_fsbo" || source === "craigslist_wanted") return terms.map((t) => `"${t}"`).join(" | ")
  return terms.join(" OR ")
}

/**
 * PURE — the first resolved term a post contains, with its population. Used by the Nextdoor lane
 * (which filters posts itself) in place of the old `keyword_type === "buying_intent"` test.
 */
export function matchResolvedKeyword(text: string | null | undefined, resolved: ResolvedKeywords): { term: string; intent: AcquisitionIntent } | null {
  const t = String(text ?? "").toLowerCase()
  if (!t) return null
  for (const [intent, list] of Object.entries(resolved.byIntent) as Array<[AcquisitionIntent, string[]]>) {
    for (const term of list) if (t.includes(term.toLowerCase())) return { term, intent }
  }
  return null
}
