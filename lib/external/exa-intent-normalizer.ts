/**
 * lib/external/exa-intent-normalizer.ts
 *
 * Exa searches for real-estate intent content using natural-language queries
 * (e.g. "homeowner thinking of selling Austin", "first-time buyer pre-approval Texas",
 * "investor 1031 exchange Phoenix"). This pure normalizer scores each Exa result for the
 * canonical intent buckets (buyer / seller / investor / agent / generic) — the SIDE of the
 * market the public content speaks to — so the research sourcer has structured signal
 * rather than raw text.
 *
 * Pure (no I/O) — runs in the scraper-simulator and is unit-testable.
 *
 * CONVERGENCE ROW 62 (wave 152, lane 152K) — THE SIDE CLASSIFIER IS SPLIT FROM THE PERSON FIELDS.
 * The side classifier (`classifyExaIntentSide`, below) is the only part lib/lead-pipeline/exa-sourcer.ts reads
 * (`.intent`). TOMBSTONE (orphan doctrine §1.3, owner R9 — "exa is to find people when it is a scraper or hunting";
 * the research sourcer never names a person): this module also attached a PERSON reading to each public result — a
 * `persona` ("first_time_buyer", "motivated_seller", "investor_1031" …, a classification of the content's AUTHOR) and
 * the street addresses it could pick out of the page (`propertyAddresses`). No product code read either; they were the
 * raw material of a person lead from research content, which R9 rules out. The person-finding Exa door, with grounded
 * evidence (URL, date, quoted basis, page-class rights, freshness), is lib/providers/exa/hunting.ts — the survivor for
 * any person reading of Exa content. Retired here: the `Persona` type, the per-pattern persona tags, `ADDRESS_RE` /
 * `extractAddresses` and the two output fields. Prices stay: an asking price on public market content is a market fact,
 * not a person field.
 */
import type { ExaResult } from "./exa-client"

export type IntentBucket = "buyer" | "seller" | "investor" | "agent" | "generic"

export interface NormalizedExaIntent {
  url:       string | null
  title:     string | null
  /** Numeric scores 0..1 per bucket — bucket with the highest score wins. */
  scores:    Record<IntentBucket, number>
  intent:    IntentBucket
  /** Phrases that fired — useful for the LLM downstream + for debugging. */
  matched:   string[]
  /** Asking prices the regex picked out of text/highlights/summary (market facts — never a person field). */
  prices:    number[]
  /** Composite text the consumer can hand to an LLM. */
  context:   string
}

interface IntentPattern {
  bucket:   IntentBucket
  weight:   number
  re:       RegExp
}

const PATTERNS: IntentPattern[] = [
  // ── Buyer signals ────────────────────────────────────────────────────────
  { bucket: "buyer", weight: 0.8, re: /\b(looking\s+to\s+buy|want\s+to\s+buy|searching\s+for\s+a\s+(?:home|house|condo)|in\s+the\s+market\s+for\s+a\s+home)\b/i },
  { bucket: "buyer", weight: 0.7, re: /\b(pre[-\s]?approval|mortgage\s+pre[-\s]?qualif|got\s+pre[-\s]?approved)\b/i },
  { bucket: "buyer", weight: 0.9, re: /\b(first[-\s]?time\s+(?:home)?\s*buyer|fthb)\b/i },
  { bucket: "buyer", weight: 0.7, re: /\b(move[-\s]?up\s+buyer|upgrading\s+(?:my|our)\s+home|need\s+a\s+bigger\s+home)\b/i },
  { bucket: "buyer", weight: 0.8, re: /\b(downsiz(?:e|ing)|empty[-\s]?nester|too\s+much\s+house)\b/i },
  // ── Seller signals ──────────────────────────────────────────────────────
  { bucket: "seller", weight: 0.8, re: /\b(thinking\s+of\s+selling|considering\s+selling|want\s+to\s+sell\s+(?:my|our)\s+(?:home|house))\b/i },
  { bucket: "seller", weight: 0.7, re: /\b(home\s+value|what(?:'s|\s+is)\s+my\s+home\s+worth|comparative\s+market\s+analysis|cma)\b/i },
  { bucket: "seller", weight: 0.9, re: /\b(for\s+sale\s+by\s+owner|fsbo|sale\s+by\s+owner)\b/i },
  { bucket: "seller", weight: 0.8, re: /\b(must\s+sell|need\s+to\s+sell\s+fast|cash\s+for\s+(?:my|your)\s+house|sell\s+(?:fast|quickly)|distressed)\b/i },
  { bucket: "seller", weight: 0.7, re: /\b(expired\s+listing|listing\s+expired|relisting\s+with)\b/i },
  // ── Investor signals ────────────────────────────────────────────────────
  { bucket: "investor", weight: 0.8, re: /\b(fix\s+and\s+flip|flipping\s+(?:houses|homes)|wholesale\s+real\s+estate|wholesaler)\b/i },
  { bucket: "investor", weight: 0.8, re: /\b(buy\s+and\s+hold|rental\s+property|cash\s+flow\s+investor|cap\s+rate|brrrr)\b/i },
  { bucket: "investor", weight: 0.9, re: /\b(1031\s+exchange|like[-\s]?kind\s+exchange)\b/i },
  // ── Agent / recruiting (out of lead scope but still tag for filtering) ─
  { bucket: "agent", weight: 0.7, re: /\b(real\s+estate\s+agent|realtor|loan\s+officer|brokerage\s+is\s+hiring)\b/i },
]

const PRICE_RE   = /\$\s?([\d,]+(?:\.\d{2})?)(?:\s?([KkMm]))?/g

function extractPrices(text: string): number[] {
  const out: number[] = []
  let m: RegExpExecArray | null
  PRICE_RE.lastIndex = 0
  while ((m = PRICE_RE.exec(text)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ''))
    if (!isFinite(n)) continue
    const suffix = (m[2] ?? '').toLowerCase()
    const mult = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1
    const v = n * mult
    if (v >= 10_000 && v < 1_000_000_000) out.push(v)
  }
  return Array.from(new Set(out))
}

/** PURE — THE SIDE CLASSIFIER (row 62): which side of the market the content speaks to. Reads no person, names no one. */
function classifyExaIntentSide(context: string): { scores: Record<IntentBucket, number>; intent: IntentBucket; matched: string[] } {
  const scores: Record<IntentBucket, number> = { buyer: 0, seller: 0, investor: 0, agent: 0, generic: 0 }
  const matched: string[] = []
  for (const p of PATTERNS) {
    if (!p.re.test(context)) continue
    scores[p.bucket] += p.weight
    matched.push(p.re.source)
  }
  // Clamp 0..1.
  for (const k of Object.keys(scores) as IntentBucket[]) {
    scores[k] = Math.max(0, Math.min(1, scores[k]))
  }
  // Pick the winning bucket — generic when nothing fired.
  let intent: IntentBucket = "generic"
  let best = 0
  for (const k of Object.keys(scores) as IntentBucket[]) {
    if (scores[k] > best) { best = scores[k]; intent = k }
  }
  return { scores, intent, matched }
}

export function normalizeExaIntentRow(row: ExaResult): NormalizedExaIntent {
  const context = [row.title, row.summary, row.text, ...(row.highlights ?? [])]
    .filter(Boolean).join(" \n ").trim()
  const side = classifyExaIntentSide(context)
  return {
    url:               row.url,
    title:             row.title,
    scores:            side.scores,
    intent:            side.intent,
    matched:           side.matched,
    prices:            extractPrices(context),
    context:           context.slice(0, 4000),  // cap for downstream LLM prompts
  }
}
