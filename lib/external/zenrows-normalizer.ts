/**
 * lib/external/zenrows-normalizer.ts
 *
 * Pure normalizer for raw HTML returned by ZenRows. The base zenrows-client only persists the raw
 * HTML body; this lifts the structured signals downstream consumers (raw_scraped_leads normalization,
 * AI ISA scripts, intent scoring) actually need:
 *   - emails / phones (multiple, deduped)
 *   - mailing addresses (US street + city/state/zip patterns)
 *   - property addresses (same regex; downstream context decides which is which)
 *   - listing prices ($ + optional K/M suffix)
 *   - candidate person names from common HTML patterns (rel="author" / opengraph / itemprop)
 *   - simple "for sale by owner" / "fsbo" intent markers
 *
 * Pure (no I/O, no globals), so the scraper-simulator + unit tests can run it deterministically.
 */
export interface ZenRowsNormalized {
  emails:           string[]
  phones:           string[]
  addresses:        string[]
  prices:           number[]
  names:            string[]
  /** Coarse listing-page intent — true when FSBO / "For Sale By Owner" / "Sold By Owner"
   *  appears, suggesting the page advertises an owner-listed property. */
  fsboMarker:       boolean
  /** Open Graph + meta description text Exa-style consumers can use for context. */
  pageTitle:        string | null
  metaDescription:  string | null
  ogImage:          string | null
  // ── Structured intent (buyer + seller + investor + agent + generic) ──────
  // ZenRows pages are NOT seller-only — buyer-side pages (saved-search alerts, "looking to buy",
  // mortgage pre-approval, "wanted" posts, IDX search snapshots) carry just as much signal. The
  // intent block scores each canonical bucket so the canonical lead-creation gate downstream
  // gets a structured persona instead of raw HTML.
  intent: {
    buyer:    number
    seller:   number
    investor: number
    agent:    number
    generic:  number
    /** Highest-scoring bucket. */
    winner:   "buyer" | "seller" | "investor" | "agent" | "generic"
    /** Specific persona suggestion when a high-specificity phrase fires. */
    persona:
      | "first_time_buyer" | "move_up_buyer" | "downsizer"
      | "fsbo_seller" | "motivated_seller" | "expired_listing"
      | "investor_flipper" | "investor_buy_hold" | "investor_1031"
      | "agent_recruit"
      | null
    /** Phrases that fired — useful for downstream debugging + the LLM prompt. */
    matched:  string[]
    /** True when buyer-search / saved-alert markers (saved search, IDX search, set up alerts,
     *  "I want a home with…") are present — the trigger for creating a buyer property-alert
     *  profile on the contact. */
    buyerAlertProfile: boolean
  }
}

const EMAIL_RE   = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi
const PHONE_RE   = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g
// "123 Main St, Austin, TX 78701" — basic US street + state + ZIP pattern.
const ADDRESS_RE = /\b\d{1,6}\s+[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Ter|Terrace|Cir|Circle|Hwy|Highway)\.?(?:\s*,?\s+[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,3})?(?:\s*,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)?/g
const PRICE_RE   = /\$\s?([\d,]+(?:\.\d{2})?)(?:\s?([KkMm]))?/g
const FSBO_RE    = /\b(for\s+sale\s+by\s+owner|fsbo|sold\s+by\s+owner|sale\s+by\s+owner)\b/i

// ── Intent patterns (buyer + seller + investor + agent) ─────────────────────
type IntentBucket = ZenRowsNormalized["intent"]["winner"]
type IntentPersona = ZenRowsNormalized["intent"]["persona"]
interface IntentPattern { bucket: IntentBucket; weight: number; re: RegExp; persona?: IntentPersona }
const INTENT_PATTERNS: IntentPattern[] = [
  // Buyer signals — including property-alert / saved-search markers (the user-cited use case)
  { bucket: "buyer", weight: 0.8, re: /\b(looking\s+to\s+buy|want\s+to\s+buy|searching\s+for\s+a\s+(?:home|house|condo)|in\s+the\s+market\s+for\s+a\s+home)\b/i },
  { bucket: "buyer", weight: 0.7, re: /\b(pre[-\s]?approval|mortgage\s+pre[-\s]?qualif|got\s+pre[-\s]?approved)\b/i },
  { bucket: "buyer", weight: 0.9, persona: "first_time_buyer", re: /\b(first[-\s]?time\s+(?:home)?\s*buyer|fthb)\b/i },
  { bucket: "buyer", weight: 0.7, persona: "move_up_buyer",    re: /\b(move[-\s]?up\s+buyer|upgrading\s+(?:my|our)\s+home|need\s+a\s+bigger\s+home)\b/i },
  { bucket: "buyer", weight: 0.8, persona: "downsizer",        re: /\b(downsiz(?:e|ing)|empty[-\s]?nester|too\s+much\s+house)\b/i },
  // Buyer-alert / saved-search profile markers (sets buyerAlertProfile)
  { bucket: "buyer", weight: 0.7, re: /\b(saved\s+search|search\s+alert|property\s+alert|listing\s+alert|new[-\s]?listing\s+alerts?|alert\s+me\s+when|email\s+me\s+(?:about|when)|notify\s+me\s+when|create\s+(?:a\s+)?(?:saved|property)\s+search)\b/i },
  { bucket: "buyer", weight: 0.7, re: /\b(I(?:'m| am)?\s+looking\s+for\s+(?:a\s+|an\s+)?(?:home|house|condo|townhouse)|wanted:\s+(?:home|house)|I\s+want\s+a\s+home\s+with)\b/i },
  // Seller signals
  { bucket: "seller", weight: 0.8, re: /\b(thinking\s+of\s+selling|considering\s+selling|want\s+to\s+sell\s+(?:my|our)\s+(?:home|house))\b/i },
  { bucket: "seller", weight: 0.7, re: /\b(home\s+value|what(?:'s|\s+is)\s+my\s+home\s+worth|comparative\s+market\s+analysis|cma)\b/i },
  { bucket: "seller", weight: 0.9, persona: "fsbo_seller",      re: /\b(for\s+sale\s+by\s+owner|fsbo|sale\s+by\s+owner)\b/i },
  { bucket: "seller", weight: 0.8, persona: "motivated_seller", re: /\b(must\s+sell|need\s+to\s+sell\s+fast|cash\s+for\s+(?:my|your)\s+house|sell\s+(?:fast|quickly)|distressed)\b/i },
  { bucket: "seller", weight: 0.7, persona: "expired_listing",  re: /\b(expired\s+listing|listing\s+expired|relisting\s+with)\b/i },
  // Investor signals
  { bucket: "investor", weight: 0.8, persona: "investor_flipper",  re: /\b(fix\s+and\s+flip|flipping\s+(?:houses|homes)|wholesale\s+real\s+estate|wholesaler)\b/i },
  { bucket: "investor", weight: 0.8, persona: "investor_buy_hold", re: /\b(buy\s+and\s+hold|rental\s+property|cash\s+flow\s+investor|cap\s+rate|brrrr)\b/i },
  { bucket: "investor", weight: 0.9, persona: "investor_1031",     re: /\b(1031\s+exchange|like[-\s]?kind\s+exchange)\b/i },
  // Agent recruiting
  { bucket: "agent", weight: 0.7, persona: "agent_recruit", re: /\b(real\s+estate\s+agent|realtor|loan\s+officer|brokerage\s+is\s+hiring)\b/i },
]
const BUYER_ALERT_RE = /\b(saved\s+search|search\s+alert|property\s+alert|listing\s+alert|new[-\s]?listing\s+alerts?|alert\s+me\s+when|email\s+me\s+(?:about|when)|notify\s+me\s+when|create\s+(?:a\s+)?(?:saved|property)\s+search|set\s+up\s+(?:an?\s+)?alert)\b/i

function uniq<T>(xs: T[]): T[] { return Array.from(new Set(xs)) }

function extractAll(re: RegExp, html: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while ((m = re.exec(html)) !== null) out.push(m[0])
  return out
}

function normalizePhones(raw: string[]): string[] {
  return uniq(raw.map(r => {
    const digits = r.replace(/\D/g, '')
    if (digits.length === 11 && digits.startsWith('1')) return `+1${digits.slice(1)}`
    if (digits.length === 10) return `+1${digits}`
    return r
  }))
}

function extractPrices(html: string): number[] {
  const out: number[] = []
  let m: RegExpExecArray | null
  PRICE_RE.lastIndex = 0
  while ((m = PRICE_RE.exec(html)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ''))
    if (!isFinite(n)) continue
    const suffix = (m[2] ?? '').toLowerCase()
    const mult = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1
    const value = n * mult
    if (value >= 1_000 && value < 1_000_000_000) out.push(value)  // ignore $-prices that are tiny ($5 etc.) or astronomical
  }
  return uniq(out)
}

function extractMeta(html: string, ...keys: string[]): string | null {
  for (const key of keys) {
    const re = new RegExp(
      `<meta[^>]+(?:name|property|itemprop)=["']${key}["'][^>]+content=["']([^"']+)["']` +
      `|<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property|itemprop)=["']${key}["']`,
      'i',
    )
    const m = re.exec(html)
    if (m) return (m[1] ?? m[2]) ?? null
  }
  return null
}

function extractNames(html: string): string[] {
  const names: string[] = []
  // rel="author" + itemprop="name"  → common author/agent containers.
  const re = /<[^>]+(?:rel|itemprop)=["'](?:author|name)["'][^>]*>([^<]{2,80})</gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const s = m[1].trim()
    if (/^[A-Z][A-Za-z'-]+\s+[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)?$/.test(s)) names.push(s)
  }
  return uniq(names)
}

export function normalizeZenRowsHtml(html: string): ZenRowsNormalized {
  const safe = typeof html === 'string' ? html : ''
  const emails    = uniq(extractAll(EMAIL_RE, safe).map(e => e.toLowerCase()))
  const phones    = normalizePhones(extractAll(PHONE_RE, safe))
  const addresses = uniq(extractAll(ADDRESS_RE, safe).map(a => a.replace(/\s+/g, ' ').trim()))
  const prices    = extractPrices(safe)
  const names     = extractNames(safe)
  const fsboMarker = FSBO_RE.test(safe)
  const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(safe)
  const pageTitle = titleMatch ? titleMatch[1].trim() : null
  const metaDescription = extractMeta(safe, 'description', 'og:description', 'twitter:description')
  const ogImage = extractMeta(safe, 'og:image', 'twitter:image')

  // Intent: score every bucket against the page text + title + meta description (more reliable
  // than HTML body alone for buyer-search alerts whose phrasing lives in the header).
  const intentText = [pageTitle, metaDescription, safe].filter(Boolean).join(' \n ')
  const scores: Record<IntentBucket, number> = { buyer: 0, seller: 0, investor: 0, agent: 0, generic: 0 }
  const matched: string[] = []
  let persona: IntentPersona = null
  let bestPersonaScore = 0
  for (const p of INTENT_PATTERNS) {
    if (!p.re.test(intentText)) continue
    scores[p.bucket] += p.weight
    matched.push(p.re.source)
    if (p.persona && p.weight > bestPersonaScore) { persona = p.persona; bestPersonaScore = p.weight }
  }
  for (const k of Object.keys(scores) as IntentBucket[]) scores[k] = Math.max(0, Math.min(1, scores[k]))
  let winner: IntentBucket = "generic"; let best = 0
  for (const k of Object.keys(scores) as IntentBucket[]) if (scores[k] > best) { best = scores[k]; winner = k }
  const buyerAlertProfile = BUYER_ALERT_RE.test(intentText)

  return {
    emails, phones, addresses, prices, names, fsboMarker,
    pageTitle, metaDescription, ogImage,
    intent: { ...scores, winner, persona, matched, buyerAlertProfile },
  }
}
