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
 *   - RentCast (RENTCAST_API_KEY — the ONE platform key; RentCast is platform-
 *     gated, there is no per-tenant key) — chosen AVM provider
 *   - (BatchData — RETIRED from this chain, wave 92 lane 92B: owner "use rentcast as much as
 *     possible regarding … home values" / "batchdata is to be used more for scrapping leads".
 *     Survivor: the RentCast leg, which now runs for EVERY tenant — its gate no longer asks the
 *     tenant-IDX substitute question for a property-data read, rentcast-eligibility.ts readKind.)
 *   - ZenRows + Zillow (ZENROWS_API_KEY) — Zillow Zestimate scrape
 *   - Perplexity Sonar (via lib/ai/models.ts) — live AVM context
 *   - OSINT public records — value derived from sale records + comps
 *
 * Each provider's API integration is wrapped in a thin adapter. Adapters can
 * fail silently — the chain just tries the next one. No provider's failure
 * propagates as an error to the caller.
 *
 * STATUS (verified): the adapters are LIVE — RentCast via lib/property/rentcast
 * (connector-gateway, X-Api-Key, per-call metering), (BatchData leg retired wave 92),
 * Zillow-via-ZenRows via lib/external/
 * zenrows-client, Perplexity via the AI gateway. Each is creds-gated (no key →
 * null → next provider). Wave 92 (lane 92B2): RentCast is the FIRST tier for every call
 * that names a tenant (key + vendor budget gated); the premium Zillow scrape still sits
 * behind usePaidProviders + the vendor budget gate. The only remaining stub is the OSINT direct-AVM path
 * (public records give life events, not values — deliberate).
 */

import "server-only"

// "batchdata" stays in the union ONLY so a historical cached row's provenance still types; no
// adapter produces it since wave 92 (lane 92B).
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
  /**
   * The tenant this AVM pull is ATTRIBUTED to — not a credential selector.
   * RentCast is platform-gated (one platform key, no per-tenant key), so this
   * decides nothing about WHICH credential is used. It is what makes the paid
   * tier governable: `checkVendorBudget({ brokerageId })` below can only run
   * with a tenant in hand, and lib/property/rentcast.ts meters every call
   * against it. Absent brokerageId → the RentCast adapter is skipped entirely,
   * because an unattributable paid call is spend nobody can see.
   */
  brokerageId?: string | null
  /** Cached AVM if we've fetched recently — used by the cache-hit short circuit */
  cachedValue?: number | null
  cachedAt?: string | null
  /** Stale threshold in days — within this window we use cached. Default 14. */
  cacheStaleAfterDays?: number
  /** Allow caller to skip certain providers (e.g., for testing) */
  skipProviders?: AvmSource[]
  /**
   * When true, also try the PREMIUM paid tier (ZenRows/Zillow) after the free fallbacks. Wave 92
   * (lane 92B2): RentCast no longer waits for this flag — it is the FIRST tier for every call that
   * names a tenant (budget- and key-gated); this flag now governs only the premium scrape.
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

  // ── 1. RENTCAST FIRST (wave 92, lane 92B2) ─────────────────────────────
  // Owner, verbatim (2026-10-01): "use rentcast as much as possible regarding property listings,
  // market, comparable, home values". A home value is RentCast's FIRST — for the daily background
  // scans too (lib/wealth-advisor/scan-opportunities.ts), not only an agent's premium CMA. What
  // bounds the cost is the 14-day freshness window twice over: the caller's own cachedValue
  // short-circuit above AND RentCast's own fact cache (lib/property/rentcast.ts
  // RENTCAST_CACHE_TTL_DAYS.avm = 14), so one home costs at most one request per 14 days.
  // Perplexity Sonar stays as the FALLBACK when RentCast is not eligible or has no confident value.
  //
  // THE ONE ELIGIBILITY GATE decides it (lib/property/rentcast-eligibility.ts, readKind
  // "property_data" — a home value has no IDX substitute, so a tenant's IDX feed never blocks it;
  // the platform key and the vendor budget still do). Over budget → RentCast AND the premium paid
  // tier are skipped; the free fallbacks below still answer. A tenant-less call never reaches
  // RentCast (an unattributable paid call is spend nobody can see).
  let rentcastEligible = false
  let overBudget = false
  if (req.brokerageId && !skip.has("rentcast")) {
    const { resolveRentcastEligibility, rentcastBudgetBlocked } = await import("@/lib/property/rentcast-eligibility")
    const eligibility = await resolveRentcastEligibility({ brokerageId: req.brokerageId, readKind: "property_data" })
    rentcastEligible = eligibility.eligible
    overBudget = eligibility.budget.checked
      ? eligibility.reason === "budget_exhausted"
      : (await rentcastBudgetBlocked(req.brokerageId)).blocked
  }
  const rentcastFirst = rentcastEligible && !overBudget
  if (rentcastFirst) {
    if (!skip.has("rentcast") && req.brokerageId && rentcastEligible) {
      const rc = await tryRentcast(req)
      if (rc && rc.confidence >= 0.6) return rc
    }
  }

  // ── 2. Perplexity Sonar (FALLBACK) ──────────────────────────────────────
  // ~$0.01/call via web-search-grounded AI. Reached when RentCast is not eligible for this tenant
  // (no platform key, budget paused, no tenant on the call) or answered without a confident value.
  if (!skip.has("perplexity")) {
    const px = await tryPerplexitySonar(req)
    if (px && px.confidence >= 0.5) return px
  }

  // ── 3. OSINT public records (free fallback) ────────────────────────────
  if (!skip.has("osint")) {
    const os = await tryOsintPublicRecords(req)
    if (os && os.confidence >= 0.45) return os
  }

  // ── 4. PREMIUM paid tier — agent-triggered only (usePaidProviders) ──────
  // TOMBSTONE (wave 92, lane 92B, §1.3): the BatchData AVM leg (tryBatchData →
  // enrichPropertyWithBatchData, gated as purpose "valuation") stood in this tier. A home value is
  // a RentCast read — survivor: the RentCast-first tier above. "valuation" left
  // BATCHDATA_ELIGIBLE_PURPOSES (lib/ai-isa/property-lookup-rail.ts), so no valuation lane can reach
  // BatchData again. What remains here is the Zillow scrape, still premium-only and still skipped
  // over budget (the budget governs the whole paid tier, as before).
  if (req.usePaidProviders && !overBudget) {
    if (!skip.has("zenrows_zillow") && process.env.ZENROWS_API_KEY) {
      const zen = await tryZillowViaZenRows(req)
      if (zen && zen.confidence >= 0.55) return zen
    }
  }

  // ── 5. Market appreciation fallback ────────────────────────────────────
  // Take the cached value (even if stale) and apply zip-level appreciation.
  if (req.cachedValue && req.zipCode) {
    const adjusted = await marketAppreciationFallback(req.cachedValue, req.zipCode, req.cachedAt)
    if (adjusted) return adjusted
  }

  return null
}

// ─── Provider adapters ──────────────────────────────────────────────────────
//
// Every adapter below makes a REAL call (RentCast connector-gateway, BatchData
// client, ZenRows Zillow scrape, Perplexity via the AI gateway) — creds-gated,
// silent-fail to the next provider. The one deliberate null is OSINT (public
// records yield life events, not values).

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
  if (!cachedValue) return null

  // Read the newest zip-level trend and apply pro-rata appreciation to the
  // stale cached value for the time elapsed since it was fetched.
  let adjusted = cachedValue
  let trendNote = "no zip trend on file"
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const supabase = createServiceClient()
    const { data: md } = await supabase
      .from("market_data")
      .select("price_trend_pct_1yr, data_date")
      .eq("zip_code", zipCode)
      .not("price_trend_pct_1yr", "is", null)
      .order("data_date", { ascending: false })
      .limit(1)
      .maybeSingle()
    const annualPct = md?.price_trend_pct_1yr != null ? Number(md.price_trend_pct_1yr) : null
    if (annualPct != null && Number.isFinite(annualPct) && cachedAt) {
      const yearsStale = Math.max(0, (Date.now() - new Date(cachedAt).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
      // Clamp: never extrapolate beyond 3 years or ±25%/yr of drift.
      const clampedYears = Math.min(yearsStale, 3)
      const clampedPct = Math.max(-25, Math.min(25, annualPct))
      adjusted = Math.round(cachedValue * Math.pow(1 + clampedPct / 100, clampedYears))
      trendNote = `${clampedPct}%/yr zip trend applied over ${clampedYears.toFixed(1)}y`
    }
  } catch {
    /* trend read is best-effort — fall through with the raw cached value */
  }

  return {
    value: adjusted,
    confidence: 0.4,
    source: "market_appreciation_fallback",
    fetchedAt: new Date().toISOString(),
    notes: `Stale cached value adjusted for zip ${zipCode} (${trendNote})`,
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
