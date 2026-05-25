// lib/lead-pipeline/exa-sourcer.ts
// Exa neural-search BUYER-intent source — AI-native discovery of people
// describing a home search in their own words across the open web (forums,
// blogs, social), which keyword scrapers miss. Each result is classified by
// detectIntent and anchored on the author handle (the viability gate drops
// anonymous/identity-less pages). This is the cutting-edge AI buyer channel that
// complements the social/search scrapers and OSINT/Google.

import { exaSearch, type ExaResult } from "@/lib/external/exa-client"
import { detectIntent } from "./social-sourcer"
import { isViableRecord, type NormalizedScrapedRecord } from "./raw-record-types"

export interface ExaMarket {
  city: string | null
  state: string | null
}

/** Pure: an Exa neural result → buyer-intent raw record (author = identity anchor). */
export function normalizeExaResult(result: ExaResult, market: ExaMarket): NormalizedScrapedRecord {
  const text = `${result.title ?? ""} ${result.text ?? ""}`
  const intent = detectIntent(text)
  return {
    sourceRecordId: `exa-${result.id}`,
    source: "exa_buyer_intent",
    behaviorType: "search_signal",
    // Queries are buyer-focused; default unmatched to buyer, honor seller phrasing.
    intentType: intent === "seller" ? "seller" : "buyer",
    intentSignals: [intent === "seller" ? "selling" : "looking_to_buy", "ai_neural_match"],
    username: result.author ?? undefined,
    city: market.city,
    state: market.state,
    sourceUrl: result.url,
    motivationScore: 50,
    rawPayload: { id: result.id, url: result.url, title: result.title, author: result.author, published: result.publishedDate },
  }
}

/** Discover buyer-intent content for a territory via Exa neural search. */
export async function sourceExaBuyerIntent(market: ExaMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const where = [market.city, market.state].filter(Boolean).join(", ")
  if (!where) return { records: [], cost: 0 }
  // Recent content only — buyer intent is time-sensitive (last 120 days).
  const since = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const queries = [
    `first-time homebuyer looking to buy a house in ${where}`,
    `pre-approved and house hunting in ${where}`,
    `relocating to ${where} and need to buy a home`,
  ]
  const all: NormalizedScrapedRecord[] = []
  let cost = 0
  for (const query of queries) {
    const r = await exaSearch({ query, numResults: 20, startPublishedDate: since }).catch(() => ({ results: [] as ExaResult[], cost: 0 }))
    cost += r.cost ?? 0
    for (const result of r.results ?? []) {
      const rec = normalizeExaResult(result, market)
      if (isViableRecord(rec)) all.push(rec)
    }
  }
  return { records: all, cost }
}
