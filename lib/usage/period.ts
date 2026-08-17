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
