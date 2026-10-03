/**
 * lib/external/nextdoor-extract.ts
 *
 * THE SCHEMA + PURE SCORING CORE for the Nextdoor neighborhood-post lane — the consumer that
 * `lib/external/llm-html-extractor.ts :: extractFromHtml` was written for and never got.
 *
 * WHY THIS EXISTS (the defect it closes).
 * `ZenrowsClient.scrapeNextdoor` promised a post object and delivered ONE field. Its body was
 *
 *     result.body.match(/class="[^"]*post[^"]*"[^>]*>([\s\S]*?)<\/div>/g)
 *       → posts.push({ content: text.slice(0, 500) })
 *
 * while BOTH of its live consumers read fields that regex can never produce:
 *
 *   · app/api/cron/lead-scraping/route.ts reads `post.author_name` and `post.post_id`. Both were
 *     ALWAYS undefined, so every Nextdoor raw lead was filed nameless under a synthetic
 *     `nextdoor-${Date.now()}-${Math.random()}` sourceRecordId — which defeats the dedupe key the
 *     raw-lead spine is built on: the same post re-scraped tomorrow lands as a brand-new record.
 *   · app/actions/lead-intelligence.ts :: searchNextdoorActivity reads `activity.type`,
 *     `activity.neighborhood`, `activity.matched_keywords`, `activity.url` and
 *     `activity.relevance_score`, then writes them into `nextdoor_activity`. All five were
 *     undefined, so the table's activity_type / neighborhood / detected_keywords / activity_url /
 *     relevance_score columns were written NULL on every insert, and the gate
 *     `activity.relevance_score > 70` was `undefined > 70` — permanently false. The lane only ever
 *     inserted on an exact first+last-name substring hit.
 *
 * That is not "a scraper we haven't wired yet". It is a declared contract with no implementation
 * behind it — exactly the shape a schema-bound HTML→JSON extractor exists to fill. Nextdoor has no
 * Apify/ZenRows structured actor in `lib/external/apify-actors.ts`; ZenRows hands back raw HTML and
 * nothing downstream of it knew how to read that HTML. So this is the "source has no actor at all"
 * case, and extractFromHtml is the actor.
 *
 * ── WHAT THE MODEL IS AND IS NOT ALLOWED TO PRODUCE ────────────────────────────
 * The model extracts OBSERVABLE FACTS ONLY — text that is physically on the page: post id, author
 * name, body text, neighborhood label, permalink, posted-at. It is never asked for a relevance
 * score, an intent classification, or a keyword list, because those are JUDGEMENTS and a judgement
 * from a generative model written into `nextdoor_activity.relevance_score` is a fabricated
 * observation that later reads as measurement. Those three are computed HERE, deterministically,
 * from the extracted text (`scoreNextdoorPost`) — same input, same score, every time, and auditable.
 *
 * Pure module: no I/O, no env, no globals. lib/external/zenrows-client.ts owns the network half.
 */

/** One neighborhood post, in the shape both live consumers already read. */
export interface NextdoorPost {
  /** Stable per-post handle — the raw-lead dedupe key. Null when the page carried none. */
  post_id: string | null
  author_name: string | null
  /** Post body text. Never null — a record without text is dropped by the normalizer. */
  content: string
  neighborhood: string | null
  /** Permalink to the post when the page exposes one. */
  url: string | null
  posted_at: string | null
  /** Deterministic bucket derived from `content` — never model-authored. */
  type: NextdoorActivityType
  /** Deterministic — the intent phrases actually present in `content`. */
  matched_keywords: string[]
  /** Deterministic 0-100 from `matched_keywords`. NULL when extraction fell back to the
   *  regex path, because there is no trustworthy text to score — an honest absence, not a 0. */
  relevance_score: number | null
  /** How this record was produced, so a consumer (and a human) can tell a schema-bound
   *  extraction from the degraded fallback. */
  extraction: "llm_schema" | "regex_fallback"
}

export type NextdoorActivityType =
  | "selling_intent"
  | "buying_intent"
  | "moving"
  | "home_services"
  | "recommendation_request"
  | "general"

/** The OUTPUT SCHEMA handed to extractFromHtml. Facts only — see the header. */
export const NEXTDOOR_POST_SCHEMA = [
  "{",
  '  "post_id":      string | null,  // the post\'s own id/permalink slug as it appears in the markup',
  '  "author_name":  string | null,  // display name of the poster, exactly as written',
  '  "content":      string,         // the post body text, plain text, no HTML',
  '  "neighborhood": string | null,  // the neighborhood label shown on the post',
  '  "url":          string | null,  // absolute permalink to the post, if present',
  '  "posted_at":    string | null   // ISO-8601 if the page states an absolute date, else null',
  "}",
].join("\n")

export const NEXTDOOR_EXTRACT_INSTRUCTIONS = [
  "Extract every neighborhood post visible in this Nextdoor search-results page.",
  "Copy text verbatim from the page. Do NOT summarize, translate, or rewrite a post's content.",
  "Do NOT infer, score, rank, or classify anything — omit any field you cannot read directly.",
  'Return relative time text ("3d ago") as null for posted_at; only an absolute date becomes ISO-8601.',
  "Skip navigation, adverts, sidebars, and comment threads — top-level posts only.",
].join(" ")

// ── Deterministic intent scoring ─────────────────────────────────────────────
// Phrases are the ones the lead spine already treats as real-estate intent
// (lib/lead-pipeline/source-intent-map.ts vocabulary), kept lowercase for matching.

const SELLING_PHRASES = [
  "selling my house", "selling our house", "selling my home", "putting my house on the market",
  "thinking of selling", "thinking about selling", "for sale by owner", "fsbo",
  "need to sell", "downsizing", "listing my house", "sell my house fast",
]
const BUYING_PHRASES = [
  "looking to buy", "house hunting", "first time home buyer", "first-time home buyer",
  "pre-approved", "preapproved", "looking for a house", "looking for a home",
  "any homes for sale", "moving to the area", "relocating here",
]
const MOVING_PHRASES = [
  "moving out of state", "moving away", "we are moving", "we're moving", "relocating",
  "job transfer", "new job in", "moving next month",
]
const SERVICE_PHRASES = [
  "recommend a realtor", "recommend an agent", "looking for a realtor", "need a realtor",
  "recommend a real estate agent", "recommend a mortgage", "recommend a lender",
]
const RECOMMENDATION_PHRASES = [
  "any recommendations", "recommendations for", "can anyone recommend", "does anyone know a",
]

/**
 * Weight per bucket, CALIBRATED AGAINST THE CONSUMER'S GATE, not picked for looks.
 *
 * app/actions/lead-intelligence.ts stores a nextdoor_activity row when the post names the lead OR
 * `relevance_score > 70`. So 70 is the line between "worth filing against a person's record" and
 * noise, and the weights are set so that ONE unmistakable phrase crosses it and one ambiguous
 * phrase does not:
 *   · "thinking of selling" (72)      → files on its own. It is the signal.
 *   · "recommend a realtor" (65)      → needs a second marker; on its own it is often a neighbor
 *                                       answering someone else's thread.
 *   · "house hunting" (60)            → same. Buyers browse for months before they are real.
 *   · "relocating" (45)               → circumstantial without more.
 *   · "any recommendations" (12)      → an ask, not an intent. It only ever tops something up.
 */
const BUCKETS: Array<{ type: NextdoorActivityType; phrases: string[]; weight: number }> = [
  { type: "selling_intent",        phrases: SELLING_PHRASES,        weight: 72 },
  { type: "buying_intent",         phrases: BUYING_PHRASES,         weight: 60 },
  { type: "home_services",         phrases: SERVICE_PHRASES,        weight: 65 },
  { type: "moving",                phrases: MOVING_PHRASES,         weight: 45 },
  { type: "recommendation_request", phrases: RECOMMENDATION_PHRASES, weight: 12 },
]

export interface NextdoorScore {
  type: NextdoorActivityType
  matched_keywords: string[]
  /** 0-100, capped. Deterministic for a given (content, extraKeywords). */
  relevance_score: number
}

/**
 * PURE. Score a post's text against the canonical intent vocabulary plus any caller-supplied
 * keywords (the scraping cron passes the brokerage's own configured keyword list).
 *
 * `type` is the highest-weight bucket that actually fired — not a guess, not a model opinion.
 * A post that matches nothing scores 0 and types as "general"; that is a real answer, and the
 * consumers' `relevance_score > 70` gate is now something a post can genuinely fail.
 */
export function scoreNextdoorPost(content: string, extraKeywords: string[] = []): NextdoorScore {
  const text = (content ?? "").toLowerCase()
  if (!text.trim()) return { type: "general", matched_keywords: [], relevance_score: 0 }

  const matched: string[] = []
  let score = 0
  let best: { type: NextdoorActivityType; weight: number } | null = null

  for (const bucket of BUCKETS) {
    let bucketHit = false
    for (const phrase of bucket.phrases) {
      if (text.includes(phrase)) {
        matched.push(phrase)
        bucketHit = true
      }
    }
    if (bucketHit) {
      // First phrase in a bucket pays full weight; further phrases in the SAME bucket pay a
      // third, so a post that repeats itself does not out-score a post with two real signals.
      const hits = bucket.phrases.filter((p) => text.includes(p)).length
      score += bucket.weight + Math.round((bucket.weight / 3) * (hits - 1))
      if (!best || bucket.weight > best.weight) best = { type: bucket.type, weight: bucket.weight }
    }
  }

  for (const kw of extraKeywords) {
    const k = (kw ?? "").trim().toLowerCase()
    if (k && text.includes(k) && !matched.includes(k)) {
      matched.push(k)
      score += 10
    }
  }

  return {
    type: best?.type ?? "general",
    matched_keywords: [...new Set(matched)],
    relevance_score: Math.max(0, Math.min(100, score)),
  }
}

/** Trim + collapse whitespace; null for anything that is not usable text. */
function cleanString(v: unknown, maxLen = 500): string | null {
  if (typeof v !== "string") return null
  const s = v.replace(/\s+/g, " ").trim()
  if (!s) return null
  return s.slice(0, maxLen)
}

/**
 * PURE. Turn extractFromHtml's loose `Array<Record<string, any>>` into the typed post shape,
 * scoring each one deterministically.
 *
 * REFUSAL RULES (a bad record is dropped, never patched into a plausible one):
 *   · no readable `content` → dropped. There is nothing to score and nothing to store.
 *   · the model returning a `relevance_score` / `type` / `matched_keywords` anyway → IGNORED.
 *     Those three are computed here; a model-authored value never reaches a consumer.
 */
export function normalizeExtractedPosts(
  records: Array<Record<string, any>>,
  opts: { keywords?: string[]; sourceUrl?: string; limit?: number } = {},
): NextdoorPost[] {
  const out: NextdoorPost[] = []
  for (const rec of records ?? []) {
    if (!rec || typeof rec !== "object") continue
    const content = cleanString(rec.content, 2000)
    if (!content) continue
    const scored = scoreNextdoorPost(content, opts.keywords ?? [])
    out.push({
      post_id:          cleanString(rec.post_id, 200),
      author_name:      cleanString(rec.author_name, 160),
      content,
      neighborhood:     cleanString(rec.neighborhood, 160),
      url:              cleanString(rec.url, 500) ?? opts.sourceUrl ?? null,
      posted_at:        cleanString(rec.posted_at, 40),
      type:             scored.type,
      matched_keywords: scored.matched_keywords,
      relevance_score:  scored.relevance_score,
      extraction:       "llm_schema",
    })
    if (opts.limit && out.length >= opts.limit) break
  }
  return out
}

/**
 * PURE. The DEGRADED path, preserved verbatim in behaviour from what shipped before: block-level
 * regex over the raw HTML, content only.
 *
 * It is kept — not deleted — because it is what the lane must fall back to when the AI Gateway is
 * unconfigured or refuses. But every record it produces is stamped `extraction: "regex_fallback"`
 * with `relevance_score: null`, so a consumer can tell a measured post from a scraped blob, and so
 * nothing downstream mistakes "we could not extract" for "this post scored zero".
 */
export function regexFallbackPosts(html: string, opts: { keywords?: string[]; sourceUrl?: string; limit?: number } = {}): NextdoorPost[] {
  const out: NextdoorPost[] = []
  const matches = (html ?? "").match(/class="[^"]*post[^"]*"[^>]*>([\s\S]*?)<\/div>/g) ?? []
  for (const match of matches.slice(0, opts.limit ?? 30)) {
    const text = match.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    if (text.length <= 30) continue
    const content = text.slice(0, 500)
    out.push({
      post_id:          null,
      author_name:      null,
      content,
      neighborhood:     null,
      url:              opts.sourceUrl ?? null,
      posted_at:        null,
      // The keyword match over recovered text is still deterministic and still useful for the
      // cron's keyword gate; only the SCORE is withheld, because the text is untrustworthy.
      type:             scoreNextdoorPost(content, opts.keywords ?? []).type,
      matched_keywords: scoreNextdoorPost(content, opts.keywords ?? []).matched_keywords,
      relevance_score:  null,
      extraction:       "regex_fallback",
    })
  }
  return out
}
