// lib/lead-pipeline/exa-sourcer.ts
// Exa neural-search BUYER-intent source — AI-native discovery of people
// describing a home search in their own words across the open web (forums,
// blogs, social), which keyword scrapers miss. Each result is classified by
// detectIntent and anchored on the author handle (the viability gate drops
// anonymous/identity-less pages). This is the cutting-edge AI buyer channel that
// complements the social/search scrapers and OSINT/Google.

import { exaSearch, type ExaResult } from "@/lib/external/exa-client"
import { normalizeExaIntentRow } from "@/lib/external/exa-intent-normalizer"
import { detectIntent } from "./social-sourcer"
import { isViableRecord, type NormalizedScrapedRecord } from "./raw-record-types"

export interface ExaMarket {
  city: string | null
  state: string | null
}

/** Pure: an Exa neural result → buyer-intent raw record (author = identity anchor). */
export function normalizeExaResult(result: ExaResult, market: ExaMarket): NormalizedScrapedRecord {
  const text = `${result.title ?? ""} ${result.text ?? ""}`
  const legacy = detectIntent(text)

  // Rich intent — buyer / seller / investor / agent / generic with persona, property addresses,
  // prices, and a context blob. Feeds downstream lead-creation + AI-ISA scripts via
  // raw_data.normalized_preview.intent.
  const rich = normalizeExaIntentRow(result)
  // Coarse legacy bucket for back-compat with the existing intentType union. Honor rich result when
  // confident; fall back to the keyword detector. Investor/agent fold into 'unknown' since the legacy
  // union is buyer/seller/unknown only.
  const intentType: "buyer" | "seller" | "unknown" =
    rich.intent === "buyer"  ? "buyer"  :
    rich.intent === "seller" ? "seller" :
    rich.intent === "generic" || rich.intent === "investor" || rich.intent === "agent"
      ? (legacy === "seller" ? "seller" : legacy === "buyer" ? "buyer" : "unknown")
      : "unknown"

  return {
    sourceRecordId: `exa-${result.id}`,
    source: "exa_buyer_intent",
    behaviorType: "search_signal",
    intentType,
    intentSignals: [
      intentType,
      rich.persona ?? "no_persona",
      "ai_neural_match",
      ...rich.matched.slice(0, 3),
    ],
    username: result.author ?? undefined,
    city: market.city,
    state: market.state,
    sourceUrl: result.url,
    motivationScore: Math.round(Math.max(rich.scores.buyer, rich.scores.seller, rich.scores.investor) * 100),
    // Rich intent flows into raw_data.normalized_preview.intent (canonical lead-gate downstream).
    intent: {
      winner:            rich.intent,
      persona:           rich.persona,
      scores:            rich.scores,
      matched:           rich.matched,
      propertyAddresses: rich.propertyAddresses,
      prices:            rich.prices,
    },
    propertyAddress: rich.propertyAddresses[0] ?? null,
    rawPayload: {
      id: result.id, url: result.url, title: result.title, author: result.author,
      published: result.publishedDate,
      // Preserve the full normalized intent + extracted addresses/prices for audit + AI-ISA.
      intent: rich,
    },
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
