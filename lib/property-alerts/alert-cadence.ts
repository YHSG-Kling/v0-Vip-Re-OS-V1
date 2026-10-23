// lib/property-alerts/alert-cadence.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE rules for the buyer property-alert engine: the snooze predicate, the
// recency window a sweep asks the provider for, and the send-ledger rule (only
// NEW or PRICE-REDUCED since the last send) — wave 91 added the last two. No
// I/O, no server-only — unit-testable and importable from anywhere.
//
// Moved here from lib/alerts/, the second alert engine this one absorbed. Only
// the snooze survived the merge: that module also carried a `shouldRunNow(frequency)`
// clock, a SECOND copy of the schedule already declared in CRON_REGISTRY
// (instant */15, daily 0 8, weekly 0 8 * * 1, twice_daily 0 8,17). Two places
// deciding when an alert is due is exactly the drift this consolidation removes —
// the registry is the one clock, and /api/property-alerts/run is called with the
// frequency it is due for.

/**
 * PURE. A buyer SNOOZE is a temporary mute that auto-resumes — while snoozed_until
 * is in the future the engine skips the search; once it passes, the search resumes
 * on its own (never deactivated, so the buyer doesn't have to remember to turn it
 * back on). NULL/empty/garbage = not snoozed: a bad value must never mute a search
 * forever.
 */
export function isSnoozed(snoozedUntil: string | null | undefined, now: Date = new Date()): boolean {
  if (!snoozedUntil) return false
  const t = new Date(snoozedUntil).getTime()
  return Number.isFinite(t) && t > now.getTime()
}

// ─────────────────────────────────────────────────────────────────────────────
// RECENCY (wave 91, owner: "we should only pull more recent data")
// ─────────────────────────────────────────────────────────────────────────────
//
// How far back a BUYER listing pull reaches, stated once. RentCast bills PER
// REQUEST, not per row (lib/property/rentcast.ts RENTCAST_USD_PER_REQUEST), so
// a window never changes what a pull costs — it changes what comes BACK: a
// 30-day window returns what is fresh on the market instead of the stale tail
// every other portal already showed this buyer. Carried to RentCast as `daysOld`
// (lib/property/rentcast-query.ts rentcastDaysOldRange).

/** A buyer asking for homes NOW (chat/email/portal NL search, send_matching_
 *  listings): listings put on the market within this many days. */
export const BUYER_LISTING_RECENCY_DAYS = 30

/** A standing alert that also watches PRICE REDUCTIONS reaches this far back:
 *  a reduction lands on a listing that has already sat, so a 30-day window
 *  would never see one. The send ledger (selectNewOrRepricedMatches below)
 *  stops anything inside the window from being re-sent unchanged. */
export const ALERT_PRICE_WATCH_DAYS = 90

/**
 * PURE. The recency window one alert sweep asks the provider for.
 *   · the buyer's OWN `max_days_on_market`, when set, wins (their stated rule);
 *   · a price-watching alert (include_price_reductions not false) → the
 *     price-watch window, so a reduction on an older listing can be seen;
 *   · a new-listings-only alert → the time since its last run plus one day of
 *     overlap (a listing stamped late by the feed is not lost between sweeps),
 *     never more than BUYER_LISTING_RECENCY_DAYS; a never-run alert gets the
 *     full buyer window.
 */
export function alertListingRecencyDays(
  alert: {
    max_days_on_market?: number | null
    include_price_reductions?: boolean | null
    last_run_at?: string | null
  },
  now: Date = new Date(),
): number {
  const own = alert.max_days_on_market
  if (own != null && Number.isFinite(own) && own > 0) return Math.ceil(own)
  if (alert.include_price_reductions !== false) return ALERT_PRICE_WATCH_DAYS
  const last = alert.last_run_at ? new Date(alert.last_run_at).getTime() : NaN
  if (!Number.isFinite(last)) return BUYER_LISTING_RECENCY_DAYS
  const sinceDays = Math.ceil(Math.max(0, now.getTime() - last) / 86_400_000) + 1
  return Math.min(BUYER_LISTING_RECENCY_DAYS, Math.max(1, sinceDays))
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SEND LEDGER RULE — only NEW or PRICE-REDUCED since the last send
// ─────────────────────────────────────────────────────────────────────────────
//
// property_alert_results is the ledger of what this alert already sent, and it
// is UNIQUE (alert_id, mls_number) in the live database — ONE row per home per
// alert. Before wave 91 the engine re-sent a home only when the PROVIDER flagged
// a price reduction the stored row had not, and then INSERTED a second row for
// it: a 23505 that refused the WHOLE batch insert (a multi-row insert is
// atomic), so every other new home in that batch was never recorded and was
// mailed again on every following sweep. RentCast rows carry no reduction flag
// at all (lib/property-alerts/idx-alert-search.ts rentcastToAlertProperty), so a
// RentCast price drop was never seen either.
//
// The rule now reads the LEDGER, not the provider: a home is re-sent only when
// its current price is below the price we last sent it at by at least the
// alert's own threshold. The engine then UPDATES that one ledger row to the new
// price — so the next sweep compares against what the buyer last saw, and the
// same reduction can never be sent twice. Price RISES are not sent: a portal
// alert that a home got more expensive is noise to a buyer (the matcher drops
// anything that rose past their budget anyway).

/** One row of what this alert already sent (property_alert_results). */
export interface SentAlertRow {
  mls_number: string
  list_price: number | string | null
  property_address?: string | null
  /** The buyer said "not for me" on the portal — a price cut on a home they
   *  dismissed is not re-sent (their answer stands; the agent can still see it). */
  buyer_dismissed?: boolean | null
}

export interface LedgerCandidate {
  mls_number: string
  property_address?: string | null
  list_price?: number | null
}

export interface LedgerCriteria {
  include_price_reductions?: boolean | null
  price_reduction_min_percent?: number | null
}

export type LedgerDecision<T> =
  | { kind: "new"; item: T }
  | { kind: "repriced"; item: T; previousPrice: number; dropPercent: number; ledgerKey: string }

/** Suppression key only — case, punctuation and whitespace are the differences
 *  between two spellings of one address (the same normaliser idx-alert-search
 *  uses to merge a home seen on two boards in one run). */
function ledgerAddressKey(address: string | null | undefined): string {
  return String(address ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()
}

/**
 * PURE. Which of this run's qualifying matches may be sent.
 *   · never sent (by key AND by normalised address — the same home under an
 *     `internal-` key yesterday and a `rentcast-` key today is not new) → NEW;
 *   · sent before, now cheaper than the price last sent by ≥ the alert's
 *     `price_reduction_min_percent` (default 2, the matcher's own default), and
 *     the alert watches reductions → REPRICED, carrying the price last sent and
 *     the LEDGER KEY of the row to update (which may differ from today's key
 *     when the address matched);
 *   · anything else — same price, a rise, a sub-threshold drop, or a second copy
 *     of a home already chosen in this run — is NOT sent.
 */
export function selectNewOrRepricedMatches<T extends LedgerCandidate>(
  candidates: T[],
  sent: SentAlertRow[],
  criteria: LedgerCriteria,
): Array<LedgerDecision<T>> {
  const byKey = new Map<string, SentAlertRow>()
  const byAddress = new Map<string, SentAlertRow>()
  for (const row of sent) {
    if (row.mls_number) byKey.set(row.mls_number, row)
    const addr = ledgerAddressKey(row.property_address)
    if (addr) byAddress.set(addr, row)
  }
  const minPct = criteria.price_reduction_min_percent ?? 2
  const watchReductions = criteria.include_price_reductions !== false
  const chosen = new Set<string>()
  const out: Array<LedgerDecision<T>> = []

  for (const item of candidates) {
    const addr = ledgerAddressKey(item.property_address)
    if (chosen.has(item.mls_number) || (addr && chosen.has(`addr:${addr}`))) continue
    const prev = byKey.get(item.mls_number) ?? (addr ? byAddress.get(addr) : undefined)
    let decision: LedgerDecision<T> | null = null
    if (!prev) {
      decision = { kind: "new", item }
    } else if (watchReductions && prev.buyer_dismissed !== true) {
      const last = prev.list_price == null ? NaN : Number(prev.list_price)
      const current = item.list_price == null ? NaN : Number(item.list_price)
      if (Number.isFinite(last) && Number.isFinite(current) && last > 0 && current < last) {
        const dropPercent = ((last - current) / last) * 100
        if (dropPercent >= minPct) decision = { kind: "repriced", item, previousPrice: last, dropPercent, ledgerKey: prev.mls_number }
      }
    }
    if (!decision) continue
    chosen.add(item.mls_number)
    if (addr) chosen.add(`addr:${addr}`)
    out.push(decision)
  }
  return out
}
