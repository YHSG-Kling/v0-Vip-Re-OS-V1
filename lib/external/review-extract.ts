/**
 * lib/external/review-extract.ts
 *
 * THE SCHEMA + PURE SCORING CORE for the review-as-acquisition lane (lane 74D,
 * docs/lead-acquisition-coverage-2026-09.md item #31 — "review/reputation chatter (as an
 * ACQUISITION signal, not just reputation response)"). Same shape as
 * lib/external/nextdoor-extract.ts: a schema-bound HTML→JSON extraction pass for a page type
 * ZenRows/Zyte can only hand back as raw HTML (a tenant's public Google Business Profile / Zillow
 * agent-profile / Facebook Page review feed), with all JUDGEMENT (real-estate-question intent)
 * computed HERE, deterministically, from the extracted text — never model-authored.
 *
 * WHY THIS IS DISTINCT FROM lib/reputation/*. lib/reputation/review-landed.ts::onReviewLanded and
 * lib/kernel/reputation.ts exist for the tenant's OWN review COLLECTION (a client leaves a review
 * through this repo's own request flow, or the tenant records one manually) — REVIEW_PLATFORMS
 * (google | zillow | realtor_com | internal | facebook | yelp) is that flow's platform vocabulary,
 * reused HERE (not re-derived) so a review this lane discovers on the tenant's PUBLIC profile
 * carries the same platform spelling a manually-recorded one would. Neither lib/reputation/* file
 * SOURCES a lead — they write/close out `agent_reviews` rows the tenant already knows about. This
 * lane reads reviews and QUESTIONS left publicly by strangers, which is acquisition, not response.
 *
 * WHAT THE MODEL IS AND IS NOT ALLOWED TO PRODUCE (same rule as nextdoor-extract.ts): the model
 * extracts OBSERVABLE FACTS ONLY — reviewer display name, review/comment text, star rating (when
 * shown), a permalink, a posted-at date. It is never asked for an intent classification or a
 * relevance score; those are JUDGEMENTS, computed here deterministically from the extracted text.
 *
 * Pure module: no I/O, no env, no globals. The network half (scrape + extractFromHtml call) lives
 * in lib/lead-pipeline/review-acquisition-sourcer.ts, mirroring nextdoor-extract.ts /
 * zenrows-client.ts::scrapeNextdoor's split.
 */

import { REVIEW_PLATFORMS, type ReviewPlatform } from "@/lib/kernel/reputation"

export type { ReviewPlatform }
export { REVIEW_PLATFORMS }

/** One review/comment entry, in the shape review-acquisition-sourcer.ts consumes. */
export interface ReviewEntry {
  reviewer_name: string | null
  /** Review/comment body text. Never empty — a record without text is dropped by the normalizer. */
  review_text: string
  /** 1-5 when the page shows a star rating; null when it does not (e.g. a Facebook comment). */
  rating: number | null
  url: string | null
  posted_at: string | null
  /** Deterministic — the real-estate-question phrases actually present in `review_text`. */
  matched_signals: string[]
  /** Deterministic bucket derived from `review_text` — never model-authored. */
  intentType: "buyer" | "seller" | "agent_seeking" | "none"
  /** How this record was produced, so a consumer can tell a schema-bound extraction from the
   *  degraded fallback. */
  extraction: "llm_schema" | "regex_fallback"
}

/** The OUTPUT SCHEMA handed to extractFromHtml. Facts only — see the header. */
export const REVIEW_PAGE_SCHEMA = [
  "{",
  '  "reviewer_name": string | null,  // display name of the reviewer/commenter, exactly as written',
  '  "review_text":   string,         // the review or comment body text, plain text, no HTML',
  '  "rating":        number | null,  // 1-5 star rating if shown, else null',
  '  "url":           string | null,  // absolute permalink to the review/comment, if present',
  '  "posted_at":     string | null   // ISO-8601 if the page states an absolute date, else null',
  "}",
].join("\n")

export const REVIEW_EXTRACT_INSTRUCTIONS = [
  "Extract every review and every visible comment/question thread visible on this business review page",
  "(Google Business Profile, a Zillow agent profile, or a Facebook Page).",
  "Copy text verbatim from the page. Do NOT summarize, translate, or rewrite a review's content.",
  "Do NOT infer, score, rank, or classify anything — omit any field you cannot read directly.",
  'Return relative time text ("3 weeks ago") as null for posted_at; only an absolute date becomes ISO-8601.',
  "Skip navigation, adverts, sidebars, and the business's own replies — reviewer-authored text only.",
].join(" ")

// ── Deterministic real-estate-question intent scoring ───────────────────────
// DISTINCT vocabulary from lib/external/nextdoor-extract.ts's phrase buckets (that module scores
// neighborhood-post intent; this scores a REVIEWER'S question/comment left on the tenant's OWN
// business page — a different content shape: often gratitude for a past deal alongside a NEW ask,
// or a stranger's question under someone else's review). Never merged — CLAUDE.md §6 is about one
// spelling per FUNCTION, and these are different functions.
const BUYER_QUESTION_PHRASES = [
  "do you have any listings", "do you have anything in", "looking to buy", "looking for a house",
  "looking for a home", "when can we see", "is this still available", "any homes for sale",
  "price range", "first time home buyer", "first-time home buyer", "pre-approved", "preapproved",
]
const SELLER_QUESTION_PHRASES = [
  "what's my home worth", "what is my home worth", "interested in selling", "thinking of selling",
  "thinking about selling", "sell my house", "free home valuation", "market analysis on my house",
  "cma for my house",
]
const AGENT_SEEKING_PHRASES = [
  "do you serve", "do you work in", "can you help us", "are you taking new clients",
  "looking for an agent", "need a realtor", "recommend a realtor",
]

/** PURE. Classifies one review/comment's text into an intent bucket + the phrases that fired.
 *  Returns intentType "none" (matched_signals: []) for ordinary praise/complaint text with no
 *  real-estate QUESTION in it — the deliberate negative case a positive control checks. */
export function classifyReviewIntent(text: string): { intentType: ReviewEntry["intentType"]; matched: string[] } {
  const t = (text ?? "").toLowerCase()
  if (!t.trim()) return { intentType: "none", matched: [] }

  const buckets: Array<{ type: ReviewEntry["intentType"]; phrases: string[] }> = [
    { type: "buyer", phrases: BUYER_QUESTION_PHRASES },
    { type: "seller", phrases: SELLER_QUESTION_PHRASES },
    { type: "agent_seeking", phrases: AGENT_SEEKING_PHRASES },
  ]

  const matched: string[] = []
  let winner: ReviewEntry["intentType"] = "none"
  for (const b of buckets) {
    for (const phrase of b.phrases) {
      if (t.includes(phrase)) {
        matched.push(phrase)
        if (winner === "none") winner = b.type
      }
    }
  }
  return { intentType: winner, matched: [...new Set(matched)] }
}

/** Trim + collapse whitespace; null for anything that is not usable text. */
function cleanString(v: unknown, maxLen = 500): string | null {
  if (typeof v !== "string") return null
  const s = v.replace(/\s+/g, " ").trim()
  if (!s) return null
  return s.slice(0, maxLen)
}

function cleanRating(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n) || n < 1 || n > 5) return null
  return Math.round(n)
}

/**
 * PURE. Turn extractFromHtml's loose `Array<Record<string, any>>` into the typed review shape,
 * scoring each one deterministically. A record with no readable `review_text` is dropped — there
 * is nothing to classify and nothing to store.
 */
export function normalizeExtractedReviews(
  records: Array<Record<string, any>>,
  opts: { sourceUrl?: string; limit?: number } = {},
): ReviewEntry[] {
  const out: ReviewEntry[] = []
  for (const rec of records ?? []) {
    if (!rec || typeof rec !== "object") continue
    const review_text = cleanString(rec.review_text, 2000)
    if (!review_text) continue
    const { intentType, matched } = classifyReviewIntent(review_text)
    out.push({
      reviewer_name: cleanString(rec.reviewer_name, 160),
      review_text,
      rating: cleanRating(rec.rating),
      url: cleanString(rec.url, 500) ?? opts.sourceUrl ?? null,
      posted_at: cleanString(rec.posted_at, 40),
      matched_signals: matched,
      intentType,
      extraction: "llm_schema",
    })
    if (opts.limit && out.length >= opts.limit) break
  }
  return out
}

/**
 * PURE. The DEGRADED path — a block-level regex over the raw HTML, review text only, the same
 * posture lib/external/nextdoor-extract.ts::regexFallbackPosts takes. Kept for when the AI Gateway
 * is unconfigured or refuses; every record is stamped `extraction: "regex_fallback"`. A reviewer
 * NAME is not something a bare regex can reliably attribute to a text block, so `reviewer_name`
 * stays null on this path (never guessed) — a fallback record can still be classified for intent,
 * but it can only ever mint through the SAME identity policy every low-identity source uses.
 */
export function regexFallbackReviews(html: string, opts: { sourceUrl?: string; limit?: number } = {}): ReviewEntry[] {
  const out: ReviewEntry[] = []
  const matches = (html ?? "").match(/class="[^"]*review[^"]*"[^>]*>([\s\S]*?)<\/div>/gi) ?? []
  for (const match of matches.slice(0, opts.limit ?? 30)) {
    const text = match.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    if (text.length <= 20) continue
    const review_text = text.slice(0, 500)
    const { intentType, matched } = classifyReviewIntent(review_text)
    out.push({
      reviewer_name: null,
      review_text,
      rating: null,
      url: opts.sourceUrl ?? null,
      posted_at: null,
      matched_signals: matched,
      intentType,
      extraction: "regex_fallback",
    })
  }
  return out
}
