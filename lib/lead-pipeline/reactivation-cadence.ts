// lib/lead-pipeline/reactivation-cadence.ts
//
// REACTIVATION CADENCE — the pure engine for the escalating, self-limiting re-engagement
// ladder (the verified white space).
//
// THE GAP: every reactivation in the system today is ONE-OFF — the stale-contact net fires a
// single AI-ISA touch at a fixed threshold; offer/relist/pre-approval recoveries each fire one
// gated message. If the contact stays quiet, nothing escalates. There is no "if they don't
// answer, try a different channel, then hand it to a human, then STOP nagging" cadence — which
// is exactly how a disciplined human team works a cooling lead.
//
// This is that ladder, as a pure decision (no I/O), so it's exhaustively unit-tested and the
// runner just executes the step it returns:
//   • Day  7 dormant  → STEP 1: a warm, low-pressure EMAIL re-engage
//   • Day 14 dormant  → STEP 2: a more direct SMS (downstream consent + channel-preference
//                       gates decide if it's actually allowed/wanted)
//   • Day 21 dormant  → STEP 3: ESCALATE to the responsible human, then HOLD — the machine
//                       stops auto-touching; over-nagging burns the relationship.
// Each step fires AT MOST once (idempotent via completedSteps). The moment the contact is
// touched again (last_contacted_at moves), dormancy resets and the ladder starts clean.
//
// HONEST: too-soon (< first threshold) → hold; all due steps done → hold; post-escalation →
// hold forever. We never fabricate a touch that isn't earned by elapsed silence.

export type ReactivationAction = "email" | "sms" | "escalate" | "hold"

export interface ReactivationThresholds {
  /** dormancy days that trigger STEP 1 (warm email) */
  step1Days: number
  /** dormancy days that trigger STEP 2 (direct SMS) */
  step2Days: number
  /** dormancy days that trigger STEP 3 (escalate to human, then hold) */
  step3Days: number
}

export const DEFAULT_REACTIVATION_THRESHOLDS: ReactivationThresholds = { step1Days: 7, step2Days: 14, step3Days: 21 }

export interface ReactivationStepInput {
  /** whole days since the contact was last contacted (from contacts.last_contacted_at) */
  daysDormant: number
  /** step numbers already completed for THIS dormancy run (1, 2, 3) */
  completedSteps: number[]
  thresholds?: Partial<ReactivationThresholds>
}

export interface ReactivationStepPlan {
  /** an action is due now */
  due: boolean
  /** which rung (0 = none) */
  step: 0 | 1 | 2 | 3
  action: ReactivationAction
  reason: string
}

const HOLD = (reason: string): ReactivationStepPlan => ({ due: false, step: 0, action: "hold", reason })

/**
 * Decide the NEXT reactivation step for one dormant contact. Pure. Returns at most one due
 * step per call — the highest threshold crossed that hasn't been completed yet. Step 3
 * (escalate) is terminal: once it's done, the contact always holds.
 */
export function planReactivationStep(input: ReactivationStepInput): ReactivationStepPlan {
  const t = { ...DEFAULT_REACTIVATION_THRESHOLDS, ...(input.thresholds ?? {}) }
  const done = new Set(input.completedSteps)
  const d = input.daysDormant

  if (!Number.isFinite(d) || d < t.step1Days) return HOLD(`only ${d}d dormant — first touch at ${t.step1Days}d`)
  if (done.has(3)) return HOLD("escalated to a human already — holding to avoid over-nagging")

  // Highest crossed-and-uncompleted rung wins.
  if (d >= t.step3Days && !done.has(3)) return { due: true, step: 3, action: "escalate", reason: `${d}d dormant through ${t.step1Days}/${t.step2Days}/${t.step3Days} cadence with no response — hand to the responsible agent and stop auto-touching` }
  if (d >= t.step2Days && !done.has(2)) return { due: true, step: 2, action: "sms", reason: `${d}d dormant, email step done with no response — try a direct SMS (consent + preference gated downstream)` }
  if (d >= t.step1Days && !done.has(1)) return { due: true, step: 1, action: "email", reason: `${d}d dormant — open with a warm, low-pressure email re-engage` }

  return HOLD(`cadence up to date for ${d}d dormant — waiting for the next threshold`)
}

/** Copy keys for the deterministic fallback body of each touch step. */
export function reactivationFallbackCopy(step: 1 | 2, firstName?: string | null): { subject: string; body: string } {
  const name = (firstName ?? "").trim()
  const hi = name ? `Hi ${name}, ` : "Hi, "
  if (step === 1) {
    return {
      subject: "Still here whenever you're ready",
      body: `${hi}it's been a little while, so I wanted to check in — no pressure at all. The market keeps moving and your goals may have shifted, so if now's a better time (or if anything's changed), just reply and I'll pick right back up where we left off.`,
    }
  }
  return {
    subject: "Quick check-in",
    body: `${hi}just a quick note — I'm still here to help whenever the timing's right for you. Want me to send over what's new in your area, or is later better? Either answer is totally fine.`,
  }
}
