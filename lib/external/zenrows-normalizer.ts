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
}

const EMAIL_RE   = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi
const PHONE_RE   = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g
// "123 Main St, Austin, TX 78701" — basic US street + state + ZIP pattern.
const ADDRESS_RE = /\b\d{1,6}\s+[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Ter|Terrace|Cir|Circle|Hwy|Highway)\.?(?:\s*,?\s+[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,3})?(?:\s*,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)?/g
const PRICE_RE   = /\$\s?([\d,]+(?:\.\d{2})?)(?:\s?([KkMm]))?/g
const FSBO_RE    = /\b(for\s+sale\s+by\s+owner|fsbo|sold\s+by\s+owner|sale\s+by\s+owner)\b/i

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
  return {
    emails, phones, addresses, prices, names, fsboMarker,
    pageTitle, metaDescription, ogImage,
  }
}
