/**
 * Canonical DOM (Days on Market) computation — AND the one reader of a listing's MLS LIVE DATE.
 *
 * ── THE FOUR DATES A LISTING CARRIES (wave 143, lane 143A — they were one column) ──────────────────
 *
 *   PLANNED MLS live date      `listings.go_live_date`. The date the agent and seller PLAN to go live on the
 *                              MLS. Typed by a person (intake, the lifecycle timeline, or the launch door);
 *                              NEVER verified; it may be a future date. Until wave 143 markAgreementSigned
 *                              also wrote today's date here at signature — a placeholder that made every
 *                              listing in prep read as already on the market. It no longer does.
 *   ACTUAL MLS live date       `listings.mls_live_date_actual`, stamped ONLY by a syndication feed the
 *                              brokerage already pays for (RentCast for-sale index, the tenant's IDX Broker)
 *                              together with `go_live_confirmed_at` (when we checked), `go_live_confirmed_source`
 *                              (which feed) and `mls_live_date_basis` (the feed's own list date, or the first
 *                              day we saw it live). Nothing a human types lands here (lib/listings/mls-live-date.ts).
 *   LISTING-AGREEMENT          `listing_agreements.fully_executed_at` — stamped at the ladder's `fully_executed`
 *   EXECUTION date             hop, after compliance approval. NOT `listings.listing_date`: that column is the
 *                              day the agent pressed Launch (an agent assertion), kept for its legacy readers.
 *   COMING-SOON / MARKETING    the stage machine: `lifecycle_stage` COMING_SOON_PREP … and the gated
 *   status                     `status = 'coming_soon'` (lib/listings/listing-status-sync.ts). Not a date.
 *
 * `resolveMlsLiveDates` is the one place that says which of the first two a surface may call "the MLS live
 * date" — `basis: "verified"` only when the feed evidence is complete; otherwise `"planned"`; otherwise
 * `"none"`. A surface that shows `date` must show `basis` beside it ("planned" is never rendered as "live").
 *
 * Callers that read DOM from a hypothetical `days_on_market` or `dom` column are reading a nonexistent column
 * (the live schema has neither). They should fetch the date columns and call the helpers here.
 *
 * PURE and client-safe on purpose (no server-only import): lifecycle and offers client components import it.
 * The timezone TABLE lives with the server-side recorder (lib/listings/mls-live-date.ts), which stores the
 * resolved IANA name on the row; this module only consumes the name.
 */

export function computeDaysOnMarket(goLiveDate: string | Date | null | undefined): number | null {
  if (!goLiveDate) return null
  const t = goLiveDate instanceof Date ? goLiveDate.getTime() : new Date(goLiveDate).getTime()
  if (!Number.isFinite(t)) return null
  const diff = Date.now() - t
  if (diff < 0) return 0
  return Math.floor(diff / 86_400_000)
}

/** Same as computeDaysOnMarket but returns 0 instead of null for missing dates.
 *  Use only when downstream UI cannot represent null. */
export function computeDaysOnMarketOrZero(goLiveDate: string | Date | null | undefined): number {
  return computeDaysOnMarket(goLiveDate) ?? 0
}


// ─── The MLS live date: planned vs verified (wave 143, lane 143A) ──────────────────────────────────

/** Which date a surface may call "the MLS live date". */
export type MlsLiveBasis = "verified" | "planned" | "none"

/** The feeds that may verify a live date — the only two the brokerage already pays for. */
export const MLS_LIVE_SOURCES = ["rentcast", "idx"] as const
export type MlsLiveSource = (typeof MLS_LIVE_SOURCES)[number]

/** How the verified date was read: the feed's own list date, or the first day we saw the listing live. */
export const MLS_LIVE_DATE_BASES = ["feed_list_date", "first_observed"] as const
export type MlsLiveDateBasis = (typeof MLS_LIVE_DATE_BASES)[number]

/** The `listings` columns the resolver reads (all optional: a partial select resolves to "none"/"planned"). */
export interface MlsLiveDateColumns {
  go_live_date?: string | null
  mls_live_date_actual?: string | null
  go_live_confirmed_at?: string | null
  go_live_confirmed_source?: string | null
  mls_live_date_basis?: string | null
  mls_live_timezone?: string | null
}

export interface MlsLiveDates {
  /** yyyy-mm-dd as a person entered it. NEVER verified. */
  planned: string | null
  /** yyyy-mm-dd read from a feed. Non-null ONLY when the evidence is complete (date + confirmed_at + a known source). */
  actual: string | null
  verifiedAt: string | null
  verifiedSource: MlsLiveSource | null
  actualBasis: MlsLiveDateBasis | null
  /** Which date `date` is. */
  basis: MlsLiveBasis
  /** The date a surface may show: the verified one, else the planned one, else null. Always read with `basis`. */
  date: string | null
  /** IANA zone the dates are calendar days in (the property's market), or null when none is recorded. */
  timezone: string | null
  /** The planned date is after today in `timezone` (UTC when none) — the listing is not yet due on the MLS. */
  plannedInFuture: boolean
  /** actual − planned in whole days (positive = it went live later than planned); null unless both exist. */
  varianceDays: number | null
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

/** PURE: the yyyy-mm-dd part of a date or timestamp string, or null when it is not a calendar date. */
export function ymdOf(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const text = value instanceof Date ? value.toISOString() : String(value).trim()
  const head = text.slice(0, 10)
  if (!YMD.test(head)) return null
  const t = Date.parse(`${head}T00:00:00Z`)
  if (!Number.isFinite(t)) return null
  // Date.parse normalises 2026-02-31 to March 3 — reject a date that does not round-trip.
  return new Date(t).toISOString().slice(0, 10) === head ? head : null
}

/** PURE: today's calendar day (yyyy-mm-dd) in an IANA zone; UTC when the zone is absent or unknown. */
export function todayInTimeZone(timezone: string | null | undefined, now: Date = new Date()): string {
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
      const ymd = ymdOf(parts)
      if (ymd) return ymd
    } catch {
      /* unknown zone → UTC below */
    }
  }
  return now.toISOString().slice(0, 10)
}

/** PURE: whole calendar days from `from` to `to` (both yyyy-mm-dd); negative when `to` is earlier. */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * PURE — which MLS live date is on this listing, and is it VERIFIED?
 *
 * VERIFIED needs all of: `mls_live_date_actual` is a calendar date, `go_live_confirmed_at` is set, and
 * `go_live_confirmed_source` is a known feed. A date without its evidence is treated as NOT verified and
 * is NOT returned as `actual` — an unaccompanied date column must never read as a feed's word.
 */
export function resolveMlsLiveDates(listing: MlsLiveDateColumns | null | undefined, now: Date = new Date()): MlsLiveDates {
  const l = listing ?? {}
  const planned = ymdOf(l.go_live_date)
  const rawActual = ymdOf(l.mls_live_date_actual)
  const source = (MLS_LIVE_SOURCES as readonly string[]).includes(String(l.go_live_confirmed_source)) ? (l.go_live_confirmed_source as MlsLiveSource) : null
  const verified = !!(rawActual && l.go_live_confirmed_at && source)
  const actual = verified ? rawActual : null
  const basisCol = (MLS_LIVE_DATE_BASES as readonly string[]).includes(String(l.mls_live_date_basis)) ? (l.mls_live_date_basis as MlsLiveDateBasis) : null
  const timezone = l.mls_live_timezone?.trim() ? l.mls_live_timezone.trim() : null
  const basis: MlsLiveBasis = actual ? "verified" : planned ? "planned" : "none"
  const today = todayInTimeZone(timezone, now)
  return {
    planned,
    actual,
    verifiedAt: verified ? (l.go_live_confirmed_at ?? null) : null,
    verifiedSource: verified ? source : null,
    actualBasis: verified ? basisCol : null,
    basis,
    date: actual ?? planned,
    timezone,
    plannedInFuture: !!planned && calendarDaysBetween(today, planned) > 0,
    varianceDays: actual && planned ? calendarDaysBetween(planned, actual) : null,
  }
}

/**
 * PURE — DOM for a listing, with the basis it was computed on. Calendar days in the listing's zone:
 * verified → days since the actual live date; planned → days since the planned date once it has arrived
 * (0 before); none → null. A surface that shows `days` for `basis: "planned"` must say so.
 */
export function computeDaysOnMarketForListing(
  listing: MlsLiveDateColumns | null | undefined,
  now: Date = new Date(),
): { days: number | null; basis: MlsLiveBasis } {
  const r = resolveMlsLiveDates(listing, now)
  if (!r.date) return { days: null, basis: "none" }
  const days = calendarDaysBetween(r.date, todayInTimeZone(r.timezone, now))
  return { days: Math.max(0, days), basis: r.basis }
}

// ─── THE COMING SOON WINDOW (wave 147, lane 147F — owner ruling 10, contract C12) ────────────────────────────────────

/**
 * Owner, verbatim (2026-10-31): "coming soon start date is the day the listing agreement was executed and once the listing
 * is live on mls, the listing becomes active not coming soon."
 *
 *   start   = the calendar day the listing agreement was EXECUTED (the last party's signature — the ONE reader,
 *             lib/listings/listing-agreement-terms.ts governingListingAgreementTerms → agreementExecutedAt), in the
 *             listing's market zone. NOT the day a status changed and NOT the COMING_SOON_ACTIVE stage entry.
 *   planned = the seller-agreed / planned MLS live day (listings.go_live_date) — PRESERVED, shown as planned, never as live.
 *   end     = the FEED-VERIFIED MLS live day (resolveMlsLiveDates().actual) — an EVENT, never the planned date arriving.
 *
 * The window is OPEN until the verified end exists; `days` counts calendar days from start to (end ?? today). Without an
 * executed agreement there is no start (`startBasis: "unknown"`) — a Coming Soon listing in that state is a FINDING
 * (lib/listings/listing-status-sync.ts listingLifecycleFindings), never a guessed date.
 */
export interface ComingSoonWindow {
  start: string | null
  startBasis: "agreement_executed" | "unknown"
  plannedLive: string | null
  verifiedLive: string | null
  open: boolean
  days: number | null
  timezone: string | null
}

/** PURE — the Coming Soon window of one listing (see ComingSoonWindow). */
export function resolveComingSoonWindow(
  input: { agreementExecutedAt: string | Date | null | undefined; listing: MlsLiveDateColumns | null | undefined },
  now: Date = new Date(),
): ComingSoonWindow {
  const live = resolveMlsLiveDates(input.listing, now)
  const tz = live.timezone
  let start: string | null = null
  const raw = input.agreementExecutedAt
  if (raw) {
    const t = raw instanceof Date ? raw : new Date(raw)
    // A bare yyyy-mm-dd is already a calendar day; a timestamp is read as a day in the listing's market zone.
    start = typeof raw === "string" && YMD.test(raw.trim()) ? raw.trim() : Number.isNaN(t.getTime()) ? null : todayInTimeZone(tz, t)
  }
  const end = live.actual
  const through = end ?? todayInTimeZone(tz, now)
  return {
    start,
    startBasis: start ? "agreement_executed" : "unknown",
    plannedLive: live.planned,
    verifiedLive: end,
    open: !end,
    days: start ? Math.max(0, calendarDaysBetween(start, through)) : null,
    timezone: tz,
  }
}
