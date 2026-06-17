// lib/marketing/content-topics.ts
//
// CONTENT TOPICS (pure) — the copy a lead magnet / landing page should address isn't guessed, it's
// driven by what buyers and sellers are ACTUALLY asking. This extracts the real questions/themes from
// the gated web-search rail (Exa/Tavily over Reddit, forums, Q&A) so the AI writes copy that answers
// what people are genuinely searching — not generic boilerplate. Pure (no I/O): the runner fetches the
// search results and passes the texts here; this turns them into ranked content topics.

export interface ContentTopic {
  topic: string
  score: number
}

/** The search query that surfaces what people are asking for a given magnet/page. Pure. */
export function topicSearchQuery(magnetType: string, area?: string | null): string {
  const where = area?.trim() ? ` in ${area.trim()}` : ""
  switch (magnetType) {
    case "home_valuation": return `what questions do home sellers ask about home value and pricing${where} reddit`
    case "buyer_guide":    return `common questions and concerns first time home buyers ask${where} reddit forum`
    case "seller_guide":   return `what do home sellers worry about most when selling a house${where} reddit`
    case "market_report":  return `questions people ask about the local housing market trends${where}`
    case "listing_alert":  return `what home buyers want from new listing alerts${where}`
    case "open_house":     return `what buyers look for and ask at an open house${where}`
    default:               return `common real estate questions buyers and sellers ask${where} reddit`
  }
}

// Question/intent openers that mark a real buyer/seller question.
const QUESTION_OPENER = /^(how|what|when|where|why|should|can|do|does|is|are|will|would|which|who)\b/i
const RE_INTENT = /(home|house|buy|sell|seller|buyer|mortgage|loan|offer|closing|escrow|inspection|appraisal|price|value|equity|market|listing|down\s*payment|pre.?approv|contingenc|comps?)/i
// Steering / protected-class terms — a topic with these is dropped (never seeds Fair-Housing-risky copy).
const FH_BANNED = /\b(family|families|kids|children|safe neighborhood|christian|church|race|religion|ethnic|good schools for|adults only|no kids)\b/i

function sentences(text: string): string[] {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Normalize a candidate topic to a comparable key. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ?]/g, "").replace(/\s+/g, " ").trim()
}

/**
 * Extract the ranked content topics (real buyer/seller questions/themes) from web-search texts. A
 * candidate qualifies when it reads like a question OR carries real-estate intent; it's dropped if it
 * carries Fair-Housing / steering language. Deduped, ranked by recurrence × a length sweet spot. Pure.
 */
export function extractContentTopics(texts: string[], opts: { limit?: number } = {}): ContentTopic[] {
  const limit = opts.limit ?? 8
  const counts = new Map<string, { topic: string; n: number }>()

  for (const text of texts ?? []) {
    for (const raw of sentences(text)) {
      const isQuestion = raw.includes("?") || QUESTION_OPENER.test(raw)
      const hasIntent = RE_INTENT.test(raw)
      if (!isQuestion && !hasIntent) continue
      if (FH_BANNED.test(raw)) continue
      // length sweet spot: a real question, not a paragraph.
      const words = raw.split(/\s+/).length
      if (words < 3 || words > 20) continue
      const key = norm(raw)
      if (!key || key.length < 8) continue
      const entry = counts.get(key) ?? { topic: raw.replace(/\s+/g, " ").trim(), n: 0 }
      entry.n += 1
      counts.set(key, entry)
    }
  }

  return [...counts.values()]
    .map((e) => {
      const words = e.topic.split(/\s+/).length
      const lengthBonus = words >= 5 && words <= 12 ? 1 : 0
      const questionBonus = e.topic.includes("?") || QUESTION_OPENER.test(e.topic) ? 1 : 0
      return { topic: e.topic, score: e.n * 2 + lengthBonus + questionBonus }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
