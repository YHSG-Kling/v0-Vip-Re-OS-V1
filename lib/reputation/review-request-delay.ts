/**
 * lib/reputation/review-request-delay.ts — THE ONE vocabulary for
 * brokerage_settings.review_request_delay_days (lane 86H).
 * ─────────────────────────────────────────────────────────────────────────────
 * The column (migration 061, INTEGER NULL, no DEFAULT — read live 2026-09-27) was
 * READ by app/api/cron/review-request-on-close and WRITTEN by nobody, so every
 * brokerage got the cron's hard-coded 5 days forever (opposite-missing 1b). The
 * owner ruled BUILD: a tenant-admin writer (app/actions/settings/brokerage-column-
 * settings.ts). The reader and the writer share THIS module, so the bounds the
 * settings card offers are exactly the ones the cron can act on:
 *
 *   - the cron only looks at closings between MIN_AGE and LOOKBACK days old, so a
 *     delay below MIN_AGE behaves as MIN_AGE (a "same day" setting would lie), and
 *     a delay at or past LOOKBACK would never fire at all — the closing ages out
 *     of the window before its send date arrives;
 *   - MAX leaves a week of daily runs (cron-dispatch: "0 16 * * *") inside the
 *     window, so one missed run does not silently lose the request.
 *
 * NULL means "never set" and reads as the DEFAULT — readers keep their default.
 * Pure (no server-only): the settings card imports the bounds for its input.
 */

/** What an unset brokerage gets — the cron's historical value, unchanged. */
export const REVIEW_REQUEST_DEFAULT_DELAY_DAYS = 5
/** The cron considers closings at most this many days old. */
export const REVIEW_REQUEST_LOOKBACK_DAYS = 30
/** …and at least this many days old (a closing from today is not yet eligible). */
export const REVIEW_REQUEST_MIN_AGE_DAYS = 1
/** Days of daily cron runs left inside the window after the send date. */
const MISSED_RUN_GRACE_DAYS = 7

export const REVIEW_REQUEST_DELAY_MIN_DAYS = REVIEW_REQUEST_MIN_AGE_DAYS
export const REVIEW_REQUEST_DELAY_MAX_DAYS = REVIEW_REQUEST_LOOKBACK_DAYS - MISSED_RUN_GRACE_DAYS

/**
 * READ side: the stored value → the delay the cron uses. NULL / non-integer →
 * DEFAULT (never set); an out-of-bounds integer (written outside this app) is
 * clamped into the window the cron can actually honour.
 */
export function normalizeReviewRequestDelay(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return REVIEW_REQUEST_DEFAULT_DELAY_DAYS
  return Math.min(REVIEW_REQUEST_DELAY_MAX_DAYS, Math.max(REVIEW_REQUEST_DELAY_MIN_DAYS, raw))
}

type ReviewRequestDelayValidation =
  | { ok: true; days: number | null }
  | { ok: false; error: string }

/**
 * WRITE side: refuse — never clamp — a value the cron could not honour, so the
 * admin is told instead of silently getting a different number. `null` clears the
 * setting (the reader's DEFAULT applies again).
 */
export function validateReviewRequestDelay(raw: unknown): ReviewRequestDelayValidation {
  if (raw === null) return { ok: true, days: null }
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return { ok: false, error: "Review request delay must be a whole number of days." }
  }
  if (raw < REVIEW_REQUEST_DELAY_MIN_DAYS || raw > REVIEW_REQUEST_DELAY_MAX_DAYS) {
    return {
      ok: false,
      error: `Review request delay must be between ${REVIEW_REQUEST_DELAY_MIN_DAYS} and ${REVIEW_REQUEST_DELAY_MAX_DAYS} days after closing.`,
    }
  }
  return { ok: true, days: raw }
}
