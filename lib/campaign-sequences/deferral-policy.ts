// lib/campaign-sequences/deferral-policy.ts
//
// DEFER, DON'T DROP — when the De-Conflict Engine (lib/kernel/deconflict) blocks a sequence send
// because one more touch would over-message the contact, dispatch.ts returns a deferral
// (providerKey = 'deconflict_gate', success=false). The step-executor used to treat that as a
// FAILED send and advance the enrollment — silently DROPPING the touch. The right behavior for a
// frequency-cap block is to RESCHEDULE the SAME step and try again once the over-touch window
// clears, so the contact still gets the message, just later. Bounded by MAX_DEFERS so a
// perpetually-capped contact never stalls the cadence forever.

/** Mirrors the providerKey dispatch.ts returns from its de-confliction chokepoint. */
export const DECONFLICT_GATE_KEY = "deconflict_gate"

/** Max times one step is rescheduled before giving up and advancing (avoid an infinite hold). */
export const MAX_DEFERS = 3

/** Backoff before retrying a deferred step. The over-touch windows are days-long, but a 24h retry
 *  re-checks cheaply and rides the window down without a long visible gap in the cadence. */
export const DEFER_BACKOFF_MS = 24 * 60 * 60 * 1000

/** True when a dispatch result is a de-confliction deferral (not a hard send failure). */
export function isDeconflictDeferral(providerKey: string | undefined, status: string): boolean {
  return status !== "sent" && providerKey === DECONFLICT_GATE_KEY
}

export interface DeferralDecision {
  /** reschedule = retry the same step later; give_up = advance past it (cap exhausted). */
  action: "reschedule" | "give_up"
  /** 1-based attempt number this deferral represents. */
  attempt: number
  /** When to retry (only for reschedule). */
  nextStepAt?: string
}

/** Pure: decide whether a deferred step should be rescheduled or given up on. */
export function decideDeferral(priorDefers: number, now: number = Date.now()): DeferralDecision {
  const attempt = priorDefers + 1
  if (attempt <= MAX_DEFERS) {
    return { action: "reschedule", attempt, nextStepAt: new Date(now + DEFER_BACKOFF_MS).toISOString() }
  }
  return { action: "give_up", attempt }
}
