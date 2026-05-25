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
 *   - RentCast (per-brokerage key or RENTCAST_API_KEY) — chosen AVM provider
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

export type AvmSource = "rentcast" | "batchdata" | "zenrows_zillow" | "perplexity" | "osint" | "cached" | "market_appreciation_fallback"

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
  /** Brokerage whose RentCast credential (or platform key) is used for the AVM pull. */
  brokerageId?: string | null
  /** Cached AVM if we've fetched recently — used by the cache-hit short circuit */
  cachedValue?: number | null
  cachedAt?: string | null
  /** Stale threshold in days — within this window we use cached. Default 14. */
  cacheStaleAfterDays?: number
  /** Allow caller to skip certain providers (e.g., for testing) */
  skipProviders?: AvmSource[]
  /**
   * When true, fall through to PAID providers (RentCast, BatchData,
   * ZenRows/Zillow) as Tier 2/3 if Perplexity returns nothing confident.
   * Default false — agents pay only when they explicitly request a Premium
   * CMA before a listing appointment via runAiCma({ mode: 'premium' }).
   */
  usePaidProviders?: boolean
}

const DEFAULT_CACHE_STALE_DAYS = 14

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

  // ── 1. Perplexity Sonar (FREE Tier 1, primary) ─────────────────────────
  // ~$0.01/call via web-search-grounded AI. No rate limits, always-current.
  // This is the default value source — daily background work, dashboard
  // reads, wealth/PLS scans all flow through here when cache is stale.
  if (!skip.has("perplexity")) {
    const px = await tryPerplexitySonar(req)
    if (px && px.confidence >= 0.5) return px
  }

  // ── 2. OSINT public records (free fallback) ────────────────────────────
  if (!skip.has("osint")) {
    const os = await tryOsintPublicRecords(req)
    if (os && os.confidence >= 0.45) return os
  }

  // ── 3. Paid providers — agent-triggered Premium CMA only ───────────────
  // Caller must pass usePaidProviders=true to opt into these. The standard
  // entry point for that is runAiCma({ mode: 'premium' }) which sets the
  // flag explicitly. Daily background work never sets it.
  if (req.usePaidProviders) {
    if (!skip.has("rentcast") && req.brokerageId) {
      const rc = await tryRentcast(req)
      if (rc && rc.confidence >= 0.6) return rc
    }
    if (!skip.has("batchdata") && process.env.BATCHDATA_API_KEY) {
      const bd = await tryBatchData(req)
      if (bd && bd.confidence >= 0.6) return bd
    }
    if (!skip.has("zenrows_zillow") && process.env.ZENROWS_API_KEY) {
      const zen = await tryZillowViaZenRows(req)
      if (zen && zen.confidence >= 0.55) return zen
    }
  }

  // ── 4. Market appreciation fallback ────────────────────────────────────
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

async function tryRentcast(req: AvmRequest): Promise<AvmResult | null> {
  if (!req.brokerageId) return null
  try {
    const { getRentcastAVM } = await import("@/lib/property/rentcast")
    const avm = await getRentcastAVM({ brokerageId: req.brokerageId, address: req.address })
    if (!avm.value || avm.value <= 0) return null
    // Tighter range around the point estimate → higher confidence.
    const spread = avm.rangeLow && avm.rangeHigh && avm.value > 0 ? (avm.rangeHigh - avm.rangeLow) / avm.value : 0.3
    const confidence = Math.max(0.6, Math.min(0.92, 0.9 - spread))
    return {
      value: avm.value,
      confidence,
      source: "rentcast",
      fetchedAt: new Date().toISOString(),
      notes: avm.rangeLow && avm.rangeHigh ? `RentCast AVM (range $${avm.rangeLow.toLocaleString()}–$${avm.rangeHigh.toLocaleString()})` : "RentCast AVM",
    }
  } catch {
    return null
  }
}

async function tryBatchData(req: AvmRequest): Promise<AvmResult | null> {
  try {
    const { enrichPropertyWithBatchData } = await import("@/lib/external/batchdata-client")
    const result = await enrichPropertyWithBatchData(req.address)
    if (!result || !result.estimatedValue || result.estimatedValue <= 0) return null
    return {
      value: result.estimatedValue,
      confidence: 0.8,
      source: "batchdata",
      fetchedAt: new Date().toISOString(),
      notes: `BatchData property enrichment (condition: ${result.condition})`,
    }
  } catch {
    return null
  }
}

async function tryZillowViaZenRows(req: AvmRequest): Promise<AvmResult | null> {
  try {
    const { scrapeWithZenRows } = await import("@/lib/external/zenrows-client")
    // Zillow URL pattern: /homes/<address>_rb/
    const slug = req.address.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()
    const url = `https://www.zillow.com/homes/${slug}_rb/`
    const response = await scrapeWithZenRows(url, { jsRender: true, premiumProxy: true })
    if (!response || !response.body) return null
    // Parse Zestimate from HTML body — looks for `"zestimate":NUMBER` JSON pattern
    const m = response.body.match(/"zestimate"\s*:\s*(\d+)/i)
    if (!m) return null
    const value = parseInt(m[1], 10)
    if (!value || value < 10000) return null
    return {
      value,
      confidence: 0.65,
      source: "zenrows_zillow",
      fetchedAt: new Date().toISOString(),
      notes: "Zillow Zestimate scraped via ZenRows",
    }
  } catch {
    return null
  }
}

async function tryPerplexitySonar(req: AvmRequest): Promise<AvmResult | null> {
  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const { text } = await generateTextRouted({
      feature: "home_value_estimate",
      prompt:
        `Research the current estimated home value for ${req.address}` +
        (req.city ? `, ${req.city}` : "") +
        (req.state ? `, ${req.state}` : "") +
        (req.zipCode ? ` ${req.zipCode}` : "") +
        `.\n\nUse Redfin, Zillow Zestimate, Realtor.com, public records, and recent comparable sales within 1 mile in the last 6 months. Return JSON ONLY:\n{ "value": <integer dollars>, "confidence": <0-1 float>, "source_count": <int>, "notes": "<brief>" }\n\nReturn JSON only.`,
      temperature: 0.2,
      maxTokens: 400,
    })
    const cleaned = text.replace(/```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0]) as { value?: number; confidence?: number; notes?: string }
    if (!parsed.value || parsed.value < 10000) return null
    return {
      value: Math.round(parsed.value),
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.6)),
      source: "perplexity",
      fetchedAt: new Date().toISOString(),
      notes: parsed.notes,
    }
  } catch {
    return null
  }
}

async function tryOsintPublicRecords(_req: AvmRequest): Promise<AvmResult | null> {
  // OSINT client provides life events + property records but not direct AVM.
  // Defer to existing osint-client.ts integration; for AVM we rely on the
  // higher-confidence providers above. Returns null to fall through to
  // appreciation fallback.
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
