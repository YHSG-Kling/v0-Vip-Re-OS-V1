// lib/kernel/signal-reaper-policy.ts
// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL REAPER POLICY (PURE) — the guarantee that NO manager signal falls through the cracks. The
// dispatcher only marks a signal "consumed" when its handler returns a non-null action; a handler that
// returns null (guard fail) or throws leaves the signal "open" FOREVER, reprocessed every tick. This
// policy caps that: a HANDLED handoff that hasn't resolved within its window is a real task that
// didn't complete → expire + ESCALATE to a human (never silently lost). A FEED_ONLY signal is
// informational (no task owed) → expire quietly after its display TTL. Pure, deterministic, testable.

/** A handled handoff must complete within a day; past that, a human is alerted (the task is stuck). */
export const MAX_HANDLED_OPEN_HOURS = 24
/** Feed-only (no-handler, human-facing) signals clear from "open" after a week on the feed. */
export const FEED_ONLY_TTL_HOURS = 24 * 7

export type SignalDisposition = "handled" | "feed_only"
export type ReapAction = "expire_escalate" | "expire_quiet" | "keep"

/**
 * PURE. Decide a stuck OPEN signal's fate by its age + disposition.
 *   - handled, past MAX_HANDLED_OPEN_HOURS → expire_escalate (a real handoff didn't complete; alert a human)
 *   - feed_only, past FEED_ONLY_TTL_HOURS  → expire_quiet (informational; just clear it)
 *   - otherwise → keep (still inside the window; the dispatcher keeps retrying)
 * Unknown disposition defaults to "handled" (conservative — escalate rather than drop).
 */
export function shouldReapSignal(input: { ageHours: number; disposition: SignalDisposition }): ReapAction {
  if (input.disposition === "feed_only") {
    return input.ageHours >= FEED_ONLY_TTL_HOURS ? "expire_quiet" : "keep"
  }
  // handled (or unknown → treated as handled)
  return input.ageHours >= MAX_HANDLED_OPEN_HOURS ? "expire_escalate" : "keep"
}

// ── AUTOMATIC DEAD-LETTER RETRY (bus self-heal) ───────────────────────────────
// A stalled HANDLED handoff used to only ever escalate to a human. But most stalls are a
// transient handler failure (a gateway blip, a race), not a genuinely stuck task — so the
// bus should first RE-HAND the signal to the addressed manager a bounded number of times,
// and escalate to a human ONLY after the retries are exhausted. Feed-only signals carry no
// task and are never replayed.
export const SIGNAL_AUTO_REPLAY_CAP = 2

/**
 * PURE. Should a stuck signal be auto-replayed (re-handed to its manager) rather than
 * escalated? Only handled handoffs that are due to escalate AND still under the replay cap.
 */
export function shouldAutoReplaySignal(input: { action: ReapAction; replays: number }, cap: number = SIGNAL_AUTO_REPLAY_CAP): boolean {
  return input.action === "expire_escalate" && input.replays < cap
}
