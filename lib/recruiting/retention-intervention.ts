// lib/recruiting/retention-intervention.ts
//
// RETENTION INTERVENTION LIBRARY (recruiting_manager) — the save-play was ONE generic template. The spec
// (and good retention practice) calls for a SIGNAL-SPECIFIC intervention: what you do for an agent who's
// gone quiet is different from what you do for an agent stuck in a closing drought. This selects the right
// intervention from the DOMINANT driving signal and produces a tailored broker recommendation + a call
// script — still gated (nothing auto-sends), grounded in the agent's real driving signals.
//
// Pure + deterministic (testable). The retention-radar's proposeRetentionSavePlay consumes it.

export type InterventionKey =
  | "re_engagement" | "drought_support" | "pipeline_unstick" | "onboarding_ramp"
  | "crm_reactivation" | "learning_re_engagement" | "holistic_check_in"

export interface Intervention {
  key: InterventionKey
  /** One-line framing of what's driving the risk. */
  headline: string
  /** The concrete, empathetic action the broker should take. */
  brokerAction: string
  /** A short opening script — acknowledgment first, never pressure. */
  callScript: string
}

/** The library, keyed by driving signal. Each is empathy-first (the drought/quiet agent is not "failing"). */
const LIBRARY: Record<InterventionKey, Intervention> = {
  re_engagement: {
    key: "re_engagement",
    headline: "gone quiet on the platform — the earliest churn signal",
    brokerAction: "Reach out personally today (call, not text). Something outside work is often the real cause — lead with genuine curiosity, not a productivity ask. Offer to jump back in together on one concrete thing.",
    callScript: "\"Hey — I noticed you've been heads-down/away and just wanted to check in on you as a person, not your pipeline. How are things? … Anything I can take off your plate this week?\"",
  },
  drought_support: {
    key: "drought_support",
    headline: "in a closing drought — the 'I've hit a wall and feel drained' moment",
    brokerAction: "Acknowledge the slow stretch honestly (markets are slow for everyone right now) BEFORE any tactics. Then offer a genuine reset: review their 2-3 warmest leads together and pick one concrete next action for each. Do NOT lead with numbers.",
    callScript: "\"Slow stretches happen to every good agent — this isn't about you. Want to sit down for 20 minutes and just look at your warmest 2-3 together? We'll find the one that's closest and get it moving.\"",
  },
  pipeline_unstick: {
    key: "pipeline_unstick",
    headline: "an empty or stalled pipeline",
    brokerAction: "Schedule a short deal/pipeline review. Look at where deals are stalling and unblock ONE specifically — a lead to re-engage, a showing to schedule, a conversation to have. Consider a temporary lead-allocation bump.",
    callScript: "\"Let's spend 15 minutes on your pipeline together — I want to help you get one thing unstuck this week. Which lead or deal feels closest to moving?\"",
  },
  onboarding_ramp: {
    key: "onboarding_ramp",
    headline: "stalled in onboarding — the strongest first-year-failure predictor",
    brokerAction: "A stalled ramp usually means a blocker, not laziness. Find the specific milestone they're stuck on and clear it WITH them (or pair them with their mentor). Getting the first showing/first offer done resets momentum.",
    callScript: "\"You're close on your setup — let's knock out the next step together right now so nothing's in your way. Which part felt confusing or stuck?\"",
  },
  crm_reactivation: {
    key: "crm_reactivation",
    headline: "dormant CRM — leads going cold from lack of touch",
    brokerAction: "Their leads are aging out. Offer a quick CRM working session — pick 3 dormant leads by name and draft the next touch together. Small, specific wins rebuild the habit.",
    callScript: "\"You've got some good leads sitting quiet — want to spend 10 minutes picking 3 to reach back out to? I'll help you word the first message.\"",
  },
  learning_re_engagement: {
    key: "learning_re_engagement",
    headline: "disengaged from skill-building",
    brokerAction: "Recommend ONE module directly relevant to a deal they have right now — not a generic assignment. Tie the learning to an immediate, concrete situation so it feels useful, not like homework.",
    callScript: "\"There's one short lesson that lines up exactly with the deal you're working — want me to send it over? Ten minutes and it'll pay off this week.\"",
  },
  holistic_check_in: {
    key: "holistic_check_in",
    headline: "engagement slipping across the board",
    brokerAction: "No single cause stands out, so lead with a genuine human check-in. Ask what's in their way and unblock one thing (a lead, a deal review, a mentor session). Retention is far cheaper than backfilling the seat.",
    callScript: "\"I wanted to check in — not about numbers, just to see how you're doing and whether there's anything I can help clear out of your way this week.\"",
  },
}

/** PURE: map a single driving-signal label (from retention-score) to an intervention key. */
export function interventionKeyForDriver(driver: string | null | undefined): InterventionKey {
  const d = (driver ?? "").toLowerCase()
  if (/activit|login|quiet|inactiv/.test(d)) return "re_engagement"
  if (/drought|closing|no deal|hasn.?t closed|production/.test(d)) return "drought_support"
  if (/onboard|ramp|setup/.test(d)) return "onboarding_ramp"   // before pipeline: "stalled onboarding" ≠ pipeline
  if (/pipeline|empty|stalled deal/.test(d)) return "pipeline_unstick"
  if (/crm|contact|dormant lead|lead touch/.test(d)) return "crm_reactivation"
  if (/module|learning|training|skill/.test(d)) return "learning_re_engagement"
  return "holistic_check_in"
}

/**
 * PURE: select the intervention for an at-risk agent from their driving signals (dominant = first). Returns
 * the tailored intervention; empty/unknown drivers → a genuine holistic check-in (never a fabricated cause).
 */
export function selectRetentionIntervention(drivers: string[]): Intervention {
  const dominant = drivers.find((d) => d && d.trim().length > 0)
  if (!dominant) return LIBRARY.holistic_check_in
  return LIBRARY[interventionKeyForDriver(dominant)]
}

/** PURE: the full save-play copy (subject + body + broker call script) for an at-risk agent. */
export function buildSavePlayCopy(input: { agentName: string; score: number; drivers: string[] }): { subject: string; body: string; brokerScript: string; interventionKey: InterventionKey } {
  const iv = selectRetentionIntervention(input.drivers)
  const driverText = input.drivers.filter(Boolean).join("; ") || "engagement is slipping across the board"
  return {
    subject: `Retention watch: ${input.agentName} needs a check-in`,
    body: [
      `${input.agentName}'s engagement is in the at-risk range (${input.score}/100) — primarily ${iv.headline}. What's driving it: ${driverText}.`,
      iv.brokerAction,
      `Suggested opener: ${iv.callScript}`,
    ].join("\n\n"),
    brokerScript: iv.callScript,
    interventionKey: iv.key,
  }
}
