/**
 * lib/external/exa-intent-normalizer.ts
 *
 * Exa searches for real-estate intent content using natural-language queries
 * (e.g. "homeowner thinking of selling Austin", "first-time buyer pre-approval Texas",
 * "investor 1031 exchange Phoenix"). This pure normalizer scores each Exa result for the
 * canonical intent buckets (buyer / seller / investor / agent / generic) and surfaces a candidate
 * persona, so downstream lead-creation has structured signal rather than raw text.
 *
 * Pure (no I/O) — runs in the scraper-simulator and is unit-testable.
 */
import type { ExaResult } from "./exa-client"

export type IntentBucket = "buyer" | "seller" | "investor" | "agent" | "generic"
export type Persona =
  | "first_time_buyer" | "move_up_buyer" | "downsizer"
  | "fsbo_seller" | "motivated_seller" | "expired_listing"
  | "investor_flipper" | "investor_buy_hold" | "investor_1031"
  | "agent_recruit"
  | null

export interface NormalizedExaIntent {
  url:       string | null
  title:     string | null
  /** Numeric scores 0..1 per bucket — bucket with the highest score wins. */
  scores:    Record<IntentBucket, number>
  intent:    IntentBucket
  persona:   Persona
  /** Phrases that fired — useful for the LLM downstream + for debugging. */
  matched:   string[]
  /** Property addresses + prices the regex picked out of text/highlights/summary. */
  propertyAddresses: string[]
  prices:    number[]
  /** Composite text the consumer can hand to an LLM. */
  context:   string
}

interface IntentPattern {
  bucket:   IntentBucket
  weight:   number
  re:       RegExp
  /** When this pattern fires, attach this persona suggestion. */
  persona?: Persona
}

const PATTERNS: IntentPattern[] = [
  // ── Buyer signals ────────────────────────────────────────────────────────
  { bucket: "buyer", weight: 0.8, re: /\b(looking\s+to\s+buy|want\s+to\s+buy|searching\s+for\s+a\s+(?:home|house|condo)|in\s+the\s+market\s+for\s+a\s+home)\b/i },
  { bucket: "buyer", weight: 0.7, re: /\b(pre[-\s]?approval|mortgage\s+pre[-\s]?qualif|got\s+pre[-\s]?approved)\b/i },
  { bucket: "buyer", weight: 0.9, persona: "first_time_buyer", re: /\b(first[-\s]?time\s+(?:home)?\s*buyer|fthb)\b/i },
  { bucket: "buyer", weight: 0.7, persona: "move_up_buyer",    re: /\b(move[-\s]?up\s+buyer|upgrading\s+(?:my|our)\s+home|need\s+a\s+bigger\s+home)\b/i },
  { bucket: "buyer", weight: 0.8, persona: "downsizer",        re: /\b(downsiz(?:e|ing)|empty[-\s]?nester|too\s+much\s+house)\b/i },
  // ── Seller signals ──────────────────────────────────────────────────────
  { bucket: "seller", weight: 0.8, re: /\b(thinking\s+of\s+selling|considering\s+selling|want\s+to\s+sell\s+(?:my|our)\s+(?:home|house))\b/i },
  { bucket: "seller", weight: 0.7, re: /\b(home\s+value|what(?:'s|\s+is)\s+my\s+home\s+worth|comparative\s+market\s+analysis|cma)\b/i },
  { bucket: "seller", weight: 0.9, persona: "fsbo_seller",        re: /\b(for\s+sale\s+by\s+owner|fsbo|sale\s+by\s+owner)\b/i },
  { bucket: "seller", weight: 0.8, persona: "motivated_seller",   re: /\b(must\s+sell|need\s+to\s+sell\s+fast|cash\s+for\s+(?:my|your)\s+house|sell\s+(?:fast|quickly)|distressed)\b/i },
  { bucket: "seller", weight: 0.7, persona: "expired_listing",    re: /\b(expired\s+listing|listing\s+expired|relisting\s+with)\b/i },
  // ── Investor signals ────────────────────────────────────────────────────
  { bucket: "investor", weight: 0.8, persona: "investor_flipper",  re: /\b(fix\s+and\s+flip|flipping\s+(?:houses|homes)|wholesale\s+real\s+estate|wholesaler)\b/i },
  { bucket: "investor", weight: 0.8, persona: "investor_buy_hold", re: /\b(buy\s+and\s+hold|rental\s+property|cash\s+flow\s+investor|cap\s+rate|brrrr)\b/i },
  { bucket: "investor", weight: 0.9, persona: "investor_1031",     re: /\b(1031\s+exchange|like[-\s]?kind\s+exchange)\b/i },
  // ── Agent / recruiting (out of lead scope but still tag for filtering) ─
  { bucket: "agent", weight: 0.7, persona: "agent_recruit", re: /\b(real\s+estate\s+agent|realtor|loan\s+officer|brokerage\s+is\s+hiring)\b/i },
]

const ADDRESS_RE = /\b\d{1,6}\s+[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Ter|Terrace|Cir|Circle|Hwy|Highway)\.?(?:\s*,?\s+[A-Z][A-Za-z'-]+)?(?:\s*,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)?/g
const PRICE_RE   = /\$\s?([\d,]+(?:\.\d{2})?)(?:\s?([KkMm]))?/g

function extractAddresses(text: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  ADDRESS_RE.lastIndex = 0
  while ((m = ADDRESS_RE.exec(text)) !== null) out.push(m[0].replace(/\s+/g, ' ').trim())
  return Array.from(new Set(out))
}
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

export function normalizeExaIntentRow(row: ExaResult): NormalizedExaIntent {
  const context = [row.title, row.summary, row.text, ...(row.highlights ?? [])]
    .filter(Boolean).join(" \n ").trim()

  const scores: Record<IntentBucket, number> = { buyer: 0, seller: 0, investor: 0, agent: 0, generic: 0 }
  const matched: string[] = []
  let persona: Persona = null
  let bestPersonaScore = 0

  for (const p of PATTERNS) {
    const hit = p.re.test(context)
    if (!hit) continue
    scores[p.bucket] += p.weight
    matched.push(p.re.source)
    if (p.persona && p.weight > bestPersonaScore) {
      persona = p.persona
      bestPersonaScore = p.weight
    }
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

  return {
    url:               row.url,
    title:             row.title,
    scores,
    intent,
    persona,
    matched,
    propertyAddresses: extractAddresses(context),
    prices:            extractPrices(context),
    context:           context.slice(0, 4000),  // cap for downstream LLM prompts
  }
}
