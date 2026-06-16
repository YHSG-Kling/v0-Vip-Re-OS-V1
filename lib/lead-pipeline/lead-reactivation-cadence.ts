// lib/lead-pipeline/lead-reactivation-cadence.ts
//
// STALE-LEAD REACTIVATION LADDER (pure) — the lead-side mirror of the contact reactivation
// cadence. A pre-conversion lead (AI-ISA owned, no relationship yet) gets a SEPARATE, gentler
// ladder on the APPROVED pre-consent channels ONLY — email + direct mail (no SMS/voice: leads
// haven't given phone consent). Reuses the contact ladder's tested step logic and just remaps
// the middle rung's channel and uses lead-appropriate (slower) thresholds:
//   • Day 10 dormant → STEP 1 warm EMAIL
//   • Day 24 dormant → STEP 2 DIRECT MAIL (the runner downgrades to a second email when no
//                      preset / no deliverable address — both are approved lead channels)
//   • Day 45 dormant → STEP 3 ESCALATE to the responsible human, then HOLD
// Each rung fires once; touching the lead resets dormancy; escalation is terminal.
//
// HONEST: too-soon / all-done / post-escalation hold — no fabricated touch.

import { planReactivationStep, type ReactivationThresholds } from "./reactivation-cadence"

export type LeadReactivationAction = "email" | "direct_mail" | "escalate" | "hold"

export const LEAD_REACTIVATION_THRESHOLDS: ReactivationThresholds = { step1Days: 10, step2Days: 24, step3Days: 45 }

export interface LeadReactivationStepPlan {
  due: boolean
  step: 0 | 1 | 2 | 3
  action: LeadReactivationAction
  reason: string
}

/**
 * Decide the next stale-lead reactivation step. Pure. Delegates the ladder integrity to the
 * (tested) contact planner, then remaps the middle rung from sms → direct_mail (leads' approved
 * second channel) and applies the slower lead thresholds.
 */
export function planLeadReactivationStep(input: {
  daysDormant: number
  completedSteps: number[]
  thresholds?: Partial<ReactivationThresholds>
}): LeadReactivationStepPlan {
  const base = planReactivationStep({
    daysDormant: input.daysDormant,
    completedSteps: input.completedSteps,
    thresholds: { ...LEAD_REACTIVATION_THRESHOLDS, ...(input.thresholds ?? {}) },
  })
  const action: LeadReactivationAction = base.action === "sms" ? "direct_mail" : (base.action as LeadReactivationAction)
  return { due: base.due, step: base.step, action, reason: base.reason }
}

/** Deterministic fallback copy for the lead reactivation touches. */
export function leadReactivationCopy(step: 1 | 2, firstName?: string | null): { subject: string; body: string } {
  const name = (firstName ?? "").trim()
  const hi = name ? `Hi ${name}, ` : "Hi, "
  if (step === 1) {
    return {
      subject: "Still happy to help when you're ready",
      body: `${hi}I know timing is everything in real estate, so no pressure at all — I just wanted to leave the door open. If you're still thinking about a move (or just curious what's happening in your area), reply anytime and I'll take it from there.`,
    }
  }
  return {
    subject: "A little something in the mail",
    body: `${hi}I wanted to reach out one more time — whenever the timing feels right for you, I'm here and glad to help. No rush, and no obligation.`,
  }
}
