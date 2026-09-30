/**
 * Canonical shape for every scraped record before it enters the pipeline.
 * Sources: Zillow, Realtor, Craigslist, BatchData, Nextdoor, Facebook, Reddit.
 *
 * isViableRecord  → allowed to exist as a raw_scraped_leads row (WIRED — the
 *                   sourcers and the ingest cron filter on it)
 * hasPromotionEligibleIdentity → MERGED ONTO isViableRecord (orphan doctrine
 *                   §1.1, wave 65A) — see the tombstone where it used to be
 *                   defined, below. It was the SAME PREDICATE, byte for byte;
 *                   the real promotion gate lives in
 *                   lib/lead-pipeline/canonical-lead-eligibility.ts.
 */
export interface NormalizedScrapedRecord {
  /** Stable dedup key unique within the source (not a DB uuid). */
  sourceRecordId: string
  /** e.g. 'zillow', 'realtor', 'craigslist_fsbo', 'batchdata_motivated' */
  source: string
  /** e.g. 'property_view', 'fsbo_listing', 'motivated_seller', 'social_intent' */
  behaviorType: string
  intentType: 'buyer' | 'seller' | 'unknown'
  /** Free-form signals driving the intent classification. */
  intentSignals: string[]

  // Identity fields — at least one combination must be present for viability.
  firstName?: string | null
  lastName?: string | null
  fullName?: string | null
  username?: string | null
  email?: string | null
  phone?: string | null

  // Geography
  city?: string | null
  state?: string | null
  zip?: string | null

  // Property context
  propertyAddress?: string | null
  mailingAddress?: string | null

  // Scoring
  motivationScore?: number | null
  sourceUrl?: string | null

  /**
   * Lane 89B (owner, 2026-09-29, verbatim: "…enriched by people data lab along with the rest
   * scraped leads unless we already paid for that lead data with the lead"). TRUE only when the
   * VENDOR that sold this record also sold the person's contact points with it (BatchData's
   * `contact` dataset — owner.phoneNumbers / owner.emails — on a Property Search / Smart Search /
   * cash-buyer pull). The raw writer stamps it as normalized_preview.paid_person_data (ONE spelling,
   * lib/kernel/scraping.ts) and pipeline-processor.ts::enrichWithPeopleData skips the PeopleData
   * call for such a row when it carries a phone or an email — the identity is already bought.
   * A scraped reply email on a Craigslist post is NOT paid person data (nobody sold the person);
   * source-intent-map.ts::SOURCE_PAID_PERSON_DATA is the per-source contract this flag must obey.
   */
  paidPersonData?: boolean

  /** Rich intent classification (when the source produced enough text to score). Optional so
   *  every scraper need not populate it; downstream code reads `intent?.winner` defensively. */
  intent?: {
    winner: "buyer" | "seller" | "investor" | "agent" | "generic"
    persona:
      | "first_time_buyer" | "move_up_buyer" | "downsizer"
      | "fsbo_seller" | "motivated_seller" | "expired_listing"
      | "investor_flipper" | "investor_buy_hold" | "investor_1031"
      | "agent_recruit"
      | null
    scores: { buyer: number; seller: number; investor: number; agent: number; generic: number }
    matched: string[]
    /** True when the source page advertises a saved-search / property-alert profile (buyer side). */
    buyerAlertProfile?: boolean
    /** Property addresses + prices the normalizer pulled from text/highlights/summary. */
    propertyAddresses?: string[]
    prices?: number[]
  }

  /** Original payload from the provider — preserved verbatim for audit. */
  rawPayload: Record<string, unknown>
}

/**
 * Gate 1 — record is allowed to exist as a raw_scraped_leads row.
 * Requires at minimum one identity signal or a property address.
 */
export function isViableRecord(r: NormalizedScrapedRecord): boolean {
  return !!(
    r.email ||
    r.phone ||
    r.username ||
    (r.fullName && (r.city || r.state)) ||
    (r.firstName && r.lastName && (r.city || r.state)) ||
    r.propertyAddress
  )
}

// ── Gate 1b — RECENCY (wave 91, lane 91B) ────────────────────────────────────
//
// Owner, verbatim (2026-09-30): "we should only pull more recent data". A request-side window
// exists only where the provider publishes one (Exa `startPublishedDate`, BatchData recorder-date
// windows via lookback_days); Apify actors, ZenRows/Zyte page scrapes, Tavily and OSINT hand back
// whatever the page or actor returns, however old. This is the CLIENT-SIDE half: the date the
// signal was made (a post's publish time, a listing's date) is read off the provider's own payload
// and a record older than its source's window is dropped at the raw writer — BEFORE the row
// exists, so it can never reach PeopleData (the cost-bearing enrichment, processRawRecord).
//
// An UNDATED record is KEPT (nothing proves it stale — a payload with no date key, a relative
// "3 days ago", an unparseable string or a future date all read as undated). That is the
// published blind spot: the gate can only drop what a payload dates.

/** Payload keys that carry the signal's own date, across the providers the raw writer receives
 *  (Apify post/listing actors, Exa, review/nextdoor extraction, Craigslist, Marketplace). The
 *  first parseable one wins; a `post` / `item` / `extraction` child is read one level deep. */
const RECENCY_DATE_KEYS = [
  "posted_at", "postedAt", "posted", "datePosted", "date_posted",
  "published", "publishedDate", "published_date", "publishedAt",
  "created_at", "createdAt", "created_utc", "created", "creation_time",
  "listingDate", "listedDate", "listed_at", "timestamp", "datetime", "date", "time",
] as const

function parseSignalDate(v: unknown, nowMs: number): number | null {
  let ms: number | null = null
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    ms = v < 1e12 ? v * 1000 : v // epoch seconds (reddit created_utc, marketplace creation_time) or ms
  } else if (typeof v === "string" && v.trim()) {
    const t = v.trim()
    if (/^\d{9,13}$/.test(t)) ms = Number(t) < 1e12 ? Number(t) * 1000 : Number(t)
    else if (/\d{4}/.test(t)) { const p = Date.parse(t); ms = Number.isFinite(p) ? p : null } // needs a year — "3 days ago" / "Monday" stay undated
  }
  if (ms === null) return null
  if (ms > nowMs + 86_400_000) return null // a future date is a parse artefact, not a signal date
  if (ms < Date.UTC(2000, 0, 1)) return null
  return ms
}

/** PURE — the ISO date the record's signal was made, read from its own payload; null when the
 *  payload dates nothing. */
function recordSignalDate(r: Pick<NormalizedScrapedRecord, "rawPayload">, nowMs: number = Date.now()): string | null {
  const layers: Array<Record<string, unknown>> = []
  const root = (r.rawPayload ?? {}) as Record<string, unknown>
  layers.push(root)
  for (const child of ["post", "item", "extraction", "listing"]) {
    const c = root[child]
    if (c && typeof c === "object" && !Array.isArray(c)) layers.push(c as Record<string, unknown>)
  }
  for (const layer of layers) {
    for (const k of RECENCY_DATE_KEYS) {
      const ms = parseSignalDate(layer[k], nowMs)
      if (ms !== null) return new Date(ms).toISOString()
    }
  }
  return null
}

/** PURE — keep the record? false only when it is DATED and older than `days`. No window (null /
 *  0 / undefined) or no date ⇒ kept. */
export function isWithinRecencyWindow(
  r: Pick<NormalizedScrapedRecord, "rawPayload">,
  days: number | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!days || days <= 0) return true
  const iso = recordSignalDate(r, nowMs)
  if (!iso) return true
  return Date.parse(iso) >= nowMs - days * 86_400_000
}

// ── MERGED ONTO SURVIVOR (orphan doctrine §1.1, wave 65A) ────────────────────
// `hasPromotionEligibleIdentity` used to live here, BYTE-IDENTICAL to
// `isViableRecord` (lib/lead-pipeline/raw-record-types.ts:72) — same six
// clauses, same order. The real, stricter promotion gate it claimed to be was
// (and remains) lib/lead-pipeline/canonical-lead-eligibility.ts — the "SINGLE
// source of truth for the raw record → lead CONVERSION GATE" (first name AND
// last name, plus one of email / phone / VERIFIED mailing address) — which
// both live promotion paths (lib/lead-pipeline/pipeline-processor.ts and
// lib/lead-promotion/eligibility-evaluator.ts) already delegate to. This
// duplicate function added nothing a caller could not get from isViableRecord
// directly, and its own header said so (wave "2026-09-03, lane L2"). Its only
// two callers — scripts/scraper-simulator.ts:32,262,270 and
// scripts/lead-flow-e2e.ts:28,262, both outside the scraping fence for THIS
// lane's edit list — are repointed to isViableRecord (lib/lead-pipeline/raw-
// record-types.ts:72) in this same pass. No capability is lost: isViableRecord
// IS the predicate this function computed, unchanged.

/**
 * Returns a stable string key for deduplication.
 * Priority: email > phone > username+source > name+location.
 * Returns null when no usable identity exists.
 */
export function buildLeadIdentityKey(r: NormalizedScrapedRecord): string | null {
  if (r.email) return `email:${r.email.trim().toLowerCase()}`

  const p = r.phone?.replace(/\D/g, '').slice(-10)
  if (p?.length === 10) return `phone:${p}`

  if (r.username && r.sourceUrl) {
    return `user:${r.username.toLowerCase()}|src:${r.sourceUrl}`
  }

  const name = [r.firstName, r.lastName].filter(Boolean).join(' ').toLowerCase()
  if (name && (r.city || r.state)) {
    return `name:${name}|${r.city?.toLowerCase() ?? ''}|${r.state?.toLowerCase() ?? ''}`
  }

  return null
}
