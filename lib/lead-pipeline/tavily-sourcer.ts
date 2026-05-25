// lib/lead-pipeline/tavily-sourcer.ts
// Tavily agentic-search intent source — buyer / seller / INVESTOR. Tavily ranks
// real-time web content with snippets; we run three territory-scoped queries
// (buyer, seller, investor) and classify each result with detectIntent +
// isInvestor. Unlike Exa (neural author-anchored discovery), Tavily surfaces
// the open web's freshest pages, so we extract any email / phone embedded in the
// snippet to anchor identity for the viability gate; pages with no identity and
// no property address are dropped. Investors are tagged as buyers with an
// "investor" marker so downstream routing can specialize.

import { tavilySearch, type TavilyResult } from "@/lib/external/tavily-client"
import { detectIntent, isInvestor } from "./social-sourcer"
import { isViableRecord, type NormalizedScrapedRecord } from "./raw-record-types"

export interface TavilyMarket {
  city: string | null
  state: string | null
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/

/** Pure: a Tavily ranked result → buyer/seller/investor raw record. */
export function normalizeTavilyResult(result: TavilyResult, market: TavilyMarket): NormalizedScrapedRecord {
  const text = `${result.title ?? ""} ${result.content ?? ""}`
  const intent = detectIntent(text)
  const investor = isInvestor(text)
  // Investors are buyers acquiring income/flip property; honor explicit seller phrasing.
  const intentType: "buyer" | "seller" | "unknown" =
    intent === "seller" ? "seller" : investor || intent === "buyer" ? "buyer" : "unknown"

  const email = result.content?.match(EMAIL_RE)?.[0]
  const phone = result.content?.match(PHONE_RE)?.[0]

  const signals: string[] = [intent === "seller" ? "selling" : "looking_to_buy", "ai_search_match"]
  if (investor) signals.push("investor")

  return {
    sourceRecordId: `tavily-${Buffer.from(String(result.url ?? result.title ?? text)).toString("base64").slice(0, 40)}`,
    source: "tavily_intent",
    behaviorType: "search_signal",
    intentType,
    intentSignals: signals,
    email: email ?? undefined,
    phone: phone ?? undefined,
    city: market.city,
    state: market.state,
    sourceUrl: result.url,
    motivationScore: investor ? 55 : 48,
    rawPayload: { title: result.title, url: result.url, content: result.content, score: result.score },
  }
}

/** Discover buyer / seller / investor intent for a territory via Tavily. */
export async function sourceTavilyIntent(market: TavilyMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const where = [market.city, market.state].filter(Boolean).join(", ")
  if (!where) return { records: [], cost: 0 }
  const queries = [
    `people looking to buy a home or first-time homebuyers in ${where}`,
    `homeowners thinking of selling their house or for sale by owner in ${where}`,
    `real estate investors looking for rental or investment property in ${where}`,
  ]
  const all: NormalizedScrapedRecord[] = []
  let cost = 0
  for (const query of queries) {
    const r = await tavilySearch({ query, maxResults: 20, searchDepth: "basic", includeAnswer: false, days: 120 }).catch(
      () => ({ answer: null, results: [] as TavilyResult[], cost: 0 }),
    )
    cost += r.cost ?? 0
    for (const result of r.results ?? []) {
      const rec = normalizeTavilyResult(result, market)
      if (isViableRecord(rec)) all.push(rec)
    }
  }
  return { records: all, cost }
}
