/**
 * AVM PROVIDER CHAIN
 *
 * Single entry point for "what is this property worth right now?" Returns a
 * fresh AVM with provider attribution + confidence. Cascades through providers
 * in order — first one that returns a confident value wins. Falls back to the
 * cached `contacts.home_value_estimate` adjusted by `market_data` appreciation
 * if everything else fails.
 *
 * Configured providers (super-admin tier):
 *   - HouseCanary (HOUSECANARY_API_KEY) — best AVM accuracy
 *   - BatchData (BATCHDATA_API_KEY) — strong property records + value
 *   - ZenRows + Zillow (ZENROWS_API_KEY) — Zillow Zestimate scrape
 *   - Perplexity Sonar (via lib/ai/models.ts) — live AVM context
 *   - OSINT public records — value derived from sale records + comps
 *
 * Each provider's API integration is wrapped in a thin adapter. Adapters can
 * fail silently — the chain just tries the next one. No provider's failure
 * propagates as an error to the caller.
 *
 * NOTE: This module deliberately does NOT call any external providers itself.
 * Adapters are stubbed to no-op and return null. Wiring the actual API calls
 * is a separate session — when those are wired, the cascade runs unchanged.
 */

import "server-only"

export type AvmSource = "housecanary" | "batchdata" | "zenrows_zillow" | "perplexity" | "osint" | "cached" | "market_appreciation_fallback"

export interface AvmResult {
  value: number
  confidence: number          // 0..1
  source: AvmSource
  fetchedAt: string           // ISO
  notes?: string
}

interface AvmRequest {
  address: string
  zipCode?: string | null
  city?: string | null
  state?: string | null
  /** Cached AVM if we've fetched recently — used by the cache-hit short circuit */
  cachedValue?: number | null
  cachedAt?: string | null
  /** Stale threshold in days — within this window we use cached */
  cacheStaleAfterDays?: number
  /** Allow caller to skip certain providers (e.g., for testing) */
  skipProviders?: AvmSource[]
}

const DEFAULT_CACHE_STALE_DAYS = 30

/**
 * Get the current AVM. Cascades through providers until one returns a
 * confident value. Falls back to cached value if all live providers fail.
 */
export async function getCurrentAvm(req: AvmRequest): Promise<AvmResult | null> {
  const skip = new Set(req.skipProviders ?? [])
  const cacheDays = req.cacheStaleAfterDays ?? DEFAULT_CACHE_STALE_DAYS

  // ── 0. Cache hit short-circuit ─────────────────────────────────────────
  if (req.cachedValue && req.cachedAt && !skip.has("cached")) {
    const ageDays = (Date.now() - new Date(req.cachedAt).getTime()) / (24 * 60 * 60 * 1000)
    if (ageDays < cacheDays) {
      return {
        value: req.cachedValue,
        confidence: 0.7,
        source: "cached",
        fetchedAt: req.cachedAt,
      }
    }
  }

  // ── 1. HouseCanary (best accuracy) ─────────────────────────────────────
  if (!skip.has("housecanary") && process.env.HOUSECANARY_API_KEY) {
    const hc = await tryHouseCanary(req)
    if (hc && hc.confidence >= 0.6) return hc
  }

  // ── 2. BatchData ────────────────────────────────────────────────────────
  if (!skip.has("batchdata") && process.env.BATCHDATA_API_KEY) {
    const bd = await tryBatchData(req)
    if (bd && bd.confidence >= 0.6) return bd
  }

  // ── 3. ZenRows + Zillow ────────────────────────────────────────────────
  if (!skip.has("zenrows_zillow") && process.env.ZENROWS_API_KEY) {
    const zen = await tryZillowViaZenRows(req)
    if (zen && zen.confidence >= 0.55) return zen
  }

  // ── 4. Perplexity Sonar (live context AVM) ──────────────────────────────
  if (!skip.has("perplexity")) {
    const px = await tryPerplexitySonar(req)
    if (px && px.confidence >= 0.5) return px
  }

  // ── 5. OSINT public records (sale records + nearby comps) ──────────────
  if (!skip.has("osint")) {
    const os = await tryOsintPublicRecords(req)
    if (os && os.confidence >= 0.45) return os
  }

  // ── 6. Market appreciation fallback ────────────────────────────────────
  // Take the cached value (even if stale) and apply zip-level appreciation.
  if (req.cachedValue && req.zipCode) {
    const adjusted = await marketAppreciationFallback(req.cachedValue, req.zipCode, req.cachedAt)
    if (adjusted) return adjusted
  }

  return null
}

// ─── Provider adapters ──────────────────────────────────────────────────────
//
// Each adapter is a no-op stub returning null. Wiring the real API calls is
// done in a follow-up session. The cascade runs identically once they're real.

async function tryHouseCanary(_req: AvmRequest): Promise<AvmResult | null> {
  // POST https://api.housecanary.com/v2/property/value
  // Auth: Basic <key>:<secret>
  // Body: { address, zipcode } | { address, city, state }
  // Response: { property_value: { value, confidence_score } }
  return null
}

async function tryBatchData(_req: AvmRequest): Promise<AvmResult | null> {
  // POST https://api.batchdata.com/api/v1/property/lookup/all-attributes
  // Auth: Bearer <BATCHDATA_API_KEY>
  // Response: { results.properties[0].valuation.estimatedValue }
  return null
}

async function tryZillowViaZenRows(_req: AvmRequest): Promise<AvmResult | null> {
  // GET https://api.zenrows.com/v1/?apikey=<>&url=https://www.zillow.com/homes/<address>_rb/
  // Parse Zestimate from HTML or schema.org/Place data block
  return null
}

async function tryPerplexitySonar(_req: AvmRequest): Promise<AvmResult | null> {
  // Uses lib/ai/models.ts → home_value_estimate model (perplexity-sonar)
  // Prompt asks Perplexity to research the address and return a current value
  // estimate with citation links. Confidence reflects agreement across cited
  // sources.
  return null
}

async function tryOsintPublicRecords(_req: AvmRequest): Promise<AvmResult | null> {
  // Reads from lib/osint-client.ts — assemble value from last-known sale price
  // + zip-level appreciation since sale date.
  return null
}

async function marketAppreciationFallback(
  cachedValue: number,
  zipCode: string,
  cachedAt: string | null | undefined
): Promise<AvmResult | null> {
  // Read market_data.price_trend_pct_1yr for the zip; apply pro-rata
  // appreciation to the cached value based on time since cachedAt.
  // No-op in this stub — returns the cached value with reduced confidence.
  if (!cachedValue) return null
  return {
    value: cachedValue,
    confidence: 0.4,
    source: "market_appreciation_fallback",
    fetchedAt: new Date().toISOString(),
    notes: `Stale cached value, no live provider returned a confident result for zip ${zipCode}`,
  }
}

// ─── Helpers used by signal generators ──────────────────────────────────────

/**
 * Compute equity ratio (0..1). Prefers true equity from `transactions.purchase_price`
 * + `transactions.close_date` (clients we represented). Falls back to a
 * heuristic using zip-level appreciation when only the cached AVM is available.
 *
 * @returns ratio in 0..1, or null if neither data set is sufficient.
 */
export function computeEquityRatio(input: {
  currentAvm: number | null
  purchasePrice?: number | null
  purchaseDate?: string | null
  /** Years owned, used as fallback when purchaseDate isn't available */
  yearsOwned?: number | null
  /** Zip-level appreciation per year as decimal, e.g., 0.05 = 5% */
  zipAnnualAppreciation?: number | null
  /** Assumed initial loan-to-value at purchase time when we don't know mortgage balance */
  assumedInitialLtv?: number
  /** Assumed years of mortgage paydown over hold period — light approximation */
  assumedAnnualPaydownPct?: number
}): number | null {
  const ltv = input.assumedInitialLtv ?? 0.8
  const paydown = input.assumedAnnualPaydownPct ?? 0.015 // ~1.5%/yr early-amort

  if (!input.currentAvm || input.currentAvm <= 0) return null

  // ── Path 1: True equity — we have purchase_price + close_date ────────
  if (input.purchasePrice && input.purchasePrice > 0) {
    const yrs = input.purchaseDate
      ? (Date.now() - new Date(input.purchaseDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000)
      : input.yearsOwned ?? 0
    // Estimated remaining balance = initial loan minus accumulated paydown
    const initialLoan = input.purchasePrice * ltv
    const remainingPct = Math.max(0, 1 - paydown * yrs)
    const remainingBalance = initialLoan * remainingPct
    const equity = input.currentAvm - remainingBalance
    return Math.max(0, Math.min(1, equity / input.currentAvm))
  }

  // ── Path 2: Heuristic — only have AVM + tenure + zip appreciation ────
  if (input.yearsOwned != null && input.yearsOwned > 0 && input.zipAnnualAppreciation != null) {
    // Imply purchase_price from current AVM and appreciation
    const impliedPurchase = input.currentAvm / Math.pow(1 + input.zipAnnualAppreciation, input.yearsOwned)
    const initialLoan = impliedPurchase * ltv
    const remainingPct = Math.max(0, 1 - paydown * input.yearsOwned)
    const remainingBalance = initialLoan * remainingPct
    const equity = input.currentAvm - remainingBalance
    return Math.max(0, Math.min(1, equity / input.currentAvm))
  }

  return null
}

/**
 * Parse free-text length_of_residence into approximate years.
 *   "5+ years"  → 5
 *   "10 years"  → 10
 *   "Less than 1 year" → 0.5
 *   numeric strings → number
 */
export function parseLengthOfResidence(text: string | null | undefined): number | null {
  if (!text) return null
  const t = text.toLowerCase().trim()
  if (/less than\s*1/.test(t)) return 0.5
  const m = t.match(/(\d+(?:\.\d+)?)/)
  if (!m) return null
  const n = parseFloat(m[1])
  if (isNaN(n)) return null
  return n
}
