// lib/podcast/distribution-retry.ts
//
// WAVE 153 (lane 153R — owner B11, census row podcasts, recovery hop): a failed podcast distribution used to be stamped
// `failed` on podcast_distribution_log and skipped forever (the distribute cron re-tries only `queued` rows). This is THE
// decision the cron now asks on every failure — PURE, so it is proven directly:
//   · TRANSIENT (a timeout, a reset, a 408 / 429 / 5xx from the host or a webhook) → back to `queued` with a bounded,
//     growing wait (next_attempt_at in provider_response); the cron re-picks it only once that time has passed;
//   · TERMINAL (no distributor connected, the host refused the episode, a 4xx other than 408 / 429, a missing audio file)
//     → `failed`, never retried — retrying a refusal is a duplicate publish attempt, not recovery;
//   · EXHAUSTED (MAX_PODCAST_DISTRIBUTION_ATTEMPTS transient failures) → `failed`, with the count said.
// PODCAST_EPISODE_FAILED is emitted only for a `failed` verdict (a transient retry is not a failure yet). No migration: the
// retry state rides the existing provider_response jsonb; the status stays inside the live CHECK (queued / failed).

export const MAX_PODCAST_DISTRIBUTION_ATTEMPTS = 4
/** First wait after a transient failure; doubled per attempt, capped. */
export const PODCAST_RETRY_BASE_MINUTES = 15
export const PODCAST_RETRY_CAP_MINUTES = 6 * 60

export type PodcastFailureClass = "transient" | "terminal"

const TERMINAL = [
  /no podcast distributor connected/i,
  /refusing to simulate/i,
  /distributor rejected/i,
  /missing audio|no audio/i,
  /invalid|unauthori[sz]ed|forbidden|not found/i,
  /\b(400|401|403|404|409|410|413|415|422)\b/,
]
const TRANSIENT = [
  /timeout|timed out|etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|network|fetch failed/i,
  /\b(408|429|500|502|503|504)\b/,
  /rate limit|temporarily|unavailable|try again/i,
]

/** PURE — classify one failure message. Unknown messages are TERMINAL: an unexplained refusal is not retried blindly. */
export function classifyPodcastDistributionFailure(message: string | null | undefined): PodcastFailureClass {
  const m = String(message ?? "")
  if (TERMINAL.some((r) => r.test(m))) return "terminal"
  if (TRANSIENT.some((r) => r.test(m))) return "transient"
  return "terminal"
}

export interface PodcastRetryState {
  attempts: number
  failure_class: PodcastFailureClass
  next_attempt_at: string | null
  error: string
  terminal_reason?: string
}

export type PodcastRetryVerdict =
  | { status: "queued"; retry: true; state: PodcastRetryState }
  | { status: "failed"; retry: false; state: PodcastRetryState }

/** PURE — what the log row becomes after a failure, given the attempts already spent (read from provider_response). */
export function decidePodcastDistributionRetry(input: { message: string | null | undefined; priorAttempts: number; now: Date }): PodcastRetryVerdict {
  const error = String(input.message ?? "unknown distribution failure").slice(0, 500)
  const attempts = Math.max(0, Math.floor(input.priorAttempts || 0)) + 1
  const failureClass = classifyPodcastDistributionFailure(error)
  if (failureClass === "terminal") {
    return { status: "failed", retry: false, state: { attempts, failure_class: "terminal", next_attempt_at: null, error, terminal_reason: "a refusal / missing connection is not retried" } }
  }
  if (attempts >= MAX_PODCAST_DISTRIBUTION_ATTEMPTS) {
    return { status: "failed", retry: false, state: { attempts, failure_class: "transient", next_attempt_at: null, error, terminal_reason: `gave up after ${attempts} transient failures` } }
  }
  const waitMin = Math.min(PODCAST_RETRY_CAP_MINUTES, PODCAST_RETRY_BASE_MINUTES * 2 ** (attempts - 1))
  return { status: "queued", retry: true, state: { attempts, failure_class: "transient", next_attempt_at: new Date(input.now.getTime() + waitMin * 60_000).toISOString(), error } }
}

/** PURE — the attempts already spent on a log row (0 when none recorded). */
export function priorPodcastAttempts(providerResponse: unknown): number {
  const n = Number((providerResponse as { attempts?: unknown } | null)?.attempts ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** PURE — may a `queued` log row be attempted now? A row with a future next_attempt_at waits; anything else is due. */
export function podcastRetryDue(providerResponse: unknown, now: Date): boolean {
  const at = (providerResponse as { next_attempt_at?: unknown } | null)?.next_attempt_at
  if (typeof at !== "string") return true
  const t = Date.parse(at)
  return !Number.isFinite(t) || t <= now.getTime()
}
