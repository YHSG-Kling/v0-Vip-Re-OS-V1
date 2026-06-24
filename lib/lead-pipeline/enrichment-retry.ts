// lib/lead-pipeline/enrichment-retry.ts
// PURE retry/terminal decision for the enrichment queue — no imports, so it's testable
// without dragging in the server-only enrichment orchestrator.

/** Max enrichment attempts before a queue entry is terminalized. */
export const MAX_RETRIES = 3

/**
 * enrichmentRetryOutcome — the retry/terminal decision shared by BOTH enrichment
 * failure paths (exception AND no-match). On the FINAL attempt the entry must
 * terminalize to 'failed' — NOT 'pending' — because the fetch excludes
 * retry_count >= MAX_RETRIES, so a 'pending' entry at the cap is a zombie: never
 * retried, never resolved, never surfaced. (The no-match path used to always reset to
 * 'pending', creating exactly that zombie.)
 */
export function enrichmentRetryOutcome(
  retryCount: number,
  maxRetries: number = MAX_RETRIES,
): { nextRetry: number; isFinal: boolean; status: "pending" | "failed" } {
  const nextRetry = retryCount + 1
  const isFinal = nextRetry >= maxRetries
  return { nextRetry, isFinal, status: isFinal ? "failed" : "pending" }
}
