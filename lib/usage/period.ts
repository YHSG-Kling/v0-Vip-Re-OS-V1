/**
 * THE BILLING PERIOD — one definition, for every usage counter.
 *
 * ── THE DEFECT THIS ENDS (#190) ──────────────────────────────────────────────
 * usage_counters was written and read under TWO period vocabularies:
 *
 *   · lib/usage.ts wrote LOCAL month boundaries with an INCLUSIVE end
 *     (last-day 23:59:59) — and read them back the same way.
 *   · lib/usage/check-cap.ts, log-media-usage.ts, usage-overview,
 *     usage-report-data and the DB view v_brokerage_ai_quota all use UTC
 *     boundaries with an EXCLUSIVE end (next month's 1st, 00:00).
 *
 * The UNIQUE key is (brokerage_id, period_start, period_end, metric), so the
 * period is part of the row's IDENTITY. The AI-quota view joins on the
 * exclusive end; incrementUsage — the ONLY writer of ai_tokens_monthly —
 * stamped the inclusive end. THE JOIN COULD NEVER MATCH, on any timezone:
 * the AI quota read zero tokens forever and the cap never tripped. Measured
 * live: the one existing row carries the inclusive spelling
 * (2026-07-01 00:00 → 2026-07-31 23:59:59); m474 normalises it.
 *
 * ── THE CONVENTION ───────────────────────────────────────────────────────────
 * UTC calendar month, half-open: [1st 00:00:00Z, next 1st 00:00:00Z). This is
 * what the view computes (date_trunc('month', now() AT TIME ZONE 'UTC') and
 * + '1 mon') — the database's spelling is the canon and this module mirrors it.
 * WRITERS stamp both bounds from here. READERS filter on period_start alone:
 * the start identifies the month, and keying reads on the end is how the old
 * rows became unreachable.
 */
export function currentUsagePeriod(now: Date = new Date()): {
  periodStartIso: string
  periodEndIso: string
} {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { periodStartIso: start.toISOString(), periodEndIso: end.toISOString() }
}

/**
 * THE SAME PERIOD, IN THE OTHER TABLE'S SPELLING — `billing_usage.period_label`,
 * a NOT NULL `YYYY-MM` text column rather than a timestamp pair.
 *
 * ── THE DEFECT THIS ENDS ─────────────────────────────────────────────────────
 * This is NOT the local-vs-UTC mismatch #190 above — stating the difference
 * plainly, because the two are easy to conflate and the remedy differs.
 * `billing_usage` had a WORSE problem: NEITHER SIDE USED THE PERIOD AT ALL.
 *
 *   · the writer (lib/kernel/billing.ts recordUsageEvent) fetched with
 *     `.eq('brokerage_id', …).maybeSingle()` and no period predicate, then
 *     UPDATED whatever row came back. `period_label` was stamped on INSERT only.
 *   · the readers — calculateOverageExposure, resolveFeatureEntitlement and
 *     app/actions/billing.ts getBillingUsage — also filtered on brokerage alone.
 *
 * With exactly one row per tenant that is invisible. The moment a second month
 * exists it is two separate failures at once: the writer accumulates every new
 * month's usage into the FIRST month's row (so a meter that should reset never
 * does, and overage exposure only ever climbs), and `.maybeSingle()` over two
 * rows is a PostgREST error, so the readers stop returning anything.
 *
 * It never bit because nothing had ever written the table (see the tombstone at
 * app/actions/admin/billing.ts). Giving it a writer is exactly what would have
 * made it bite, so the period key is closed in the same change.
 *
 * ── THE CONVENTION ───────────────────────────────────────────────────────────
 * The SAME UTC calendar month as `currentUsagePeriod`, and derived FROM it
 * rather than recomputed, so the two spellings cannot drift apart. Every writer
 * and every reader of `billing_usage` filters on this value.
 */
export function currentBillingPeriodLabel(now: Date = new Date()): string {
  return currentUsagePeriod(now).periodStartIso.slice(0, 7)
}
