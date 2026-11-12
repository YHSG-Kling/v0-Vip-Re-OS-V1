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
  // WAVE 89 (lane 89C) — SUPPORT plays for the agent fatigue signals (owner: "give the support that
  // they are lacking before they decide to leave"). Every one is a thing the BROKER does for the agent.
  | "response_support" | "inbox_support" | "scheduling_support" | "task_support"
  | "activity_dropoff" | "fatigued_book_support" | "transfer_conversation"
  // WAVE 104 (lane 104E) — the after-hours-volume signal's play: a boundary conversation + cover.
  | "boundary_support"

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
  // ── WAVE 89 (lane 89C) — support plays, one per agent fatigue signal ──
  response_support: {
    key: "response_support",
    headline: "slow to answer clients — the earliest overload signal",
    brokerAction: "Reply lag is workload, not attitude. Offer the AI ISA / a TC on first responses for two weeks, and ask which conversations feel heaviest. Set a reachable reply bar together rather than a reprimand.",
    callScript: "\"Your clients are waiting a bit longer than they used to — that usually means too much on one plate. What can I take off it this week? I can put the ISA on first replies so you only get the ones that matter.\"",
  },
  inbox_support: {
    key: "inbox_support",
    headline: "client messages going unanswered",
    brokerAction: "Sit with them for ten minutes and clear the unanswered thread list together — draft the first two replies with them. Then route new inbound through the ISA queue until the backlog is gone.",
    callScript: "\"A few clients have written in and not heard back — let's knock those out together right now, and I'll have the ISA catch new ones for a couple of weeks.\"",
  },
  scheduling_support: {
    key: "scheduling_support",
    headline: "missing or rescheduling appointments",
    brokerAction: "Missed and moved appointments mean a calendar that is not holding. Offer showing coverage (a covering agent or the showing service) for the next two weeks and a confirmation routine run by the OS, not by them.",
    callScript: "\"Appointments have been slipping — that's a schedule problem, not a you problem. Want cover on showings for a couple of weeks while we reset the calendar?\"",
  },
  task_support: {
    key: "task_support",
    headline: "follow-up tasks piling up overdue",
    brokerAction: "Overdue follow-ups are the pipeline quietly closing. Triage the overdue list with them, hand the routine ones to a TC or the ISA, and leave them the three that matter.",
    callScript: "\"Your follow-up list has gotten long — let's go through it together and I'll take the routine ones off you so you're only carrying the ones that need you.\"",
  },
  activity_dropoff: {
    key: "activity_dropoff",
    headline: "platform activity falling off — the quiet quit pattern",
    brokerAction: "Two weeks of falling logins is the earliest disengagement signal there is. Reach out personally today, curious not corrective, and find the friction (a tool, a lead source, something at home).",
    callScript: "\"I've noticed you've been in the system a lot less lately — no judgment, I just want to know what's going on and whether something is getting in your way.\"",
  },
  fatigued_book_support: {
    key: "fatigued_book_support",
    headline: "a fatigued book — their contacts are not answering",
    brokerAction: "A book that has gone quiet exhausts the agent who keeps calling into it. Pause the cadence on the fatigued contacts, allocate a few fresh qualified leads, and coach ONE useful personal touch per contact instead of more volume.",
    callScript: "\"A lot of your people have gone quiet, and that wears anyone down. Let's pause the noise on those, get you a few fresh ones, and pick one useful thing to say to each of the quiet ones.\"",
  },
  boundary_support: {
    key: "boundary_support",
    headline: "working late — most client messages go out after hours",
    brokerAction: "An agent answering clients at 11pm every night is burning out, not performing. Have the boundary conversation: agree an evening cut-off, put the after-hours inbox on the ISA / a TC cover, and set the client expectation for them.",
    callScript: "\"I can see a lot of your client replies are going out late at night. You don't have to carry that — let's agree an evening cut-off and I'll put the after-hours messages on cover so you can switch off.\"",
  },
  transfer_conversation: {
    key: "transfer_conversation",
    headline: "their book was recently transferred or covered",
    brokerAction: "A book that moved (cover or reassignment) is a moment an agent decides whether they are staying. Have the conversation directly: what the cover was for, what comes back, and what support they need to pick the pace back up.",
    callScript: "\"With your book covered recently I want to make sure we're on the same page about what's yours and what you need from me to get back up to speed.\"",
  },
}

/** PURE: map a single driving-signal label (from retention-score) to an intervention key. */
export function interventionKeyForDriver(driver: string | null | undefined): InterventionKey {
  const d = (driver ?? "").toLowerCase()
  // Wave 89 fatigue labels first (AGENT_FATIGUE_LABELS) — they are more specific than the generic words.
  if (/working late|after.?hours/.test(d)) return "boundary_support"
  if (/slow to answer|reply lag|response/.test(d)) return "response_support"
  if (/unanswered|going unanswered|inbox/.test(d)) return "inbox_support"
  if (/missing or rescheduling|reschedul|no-show|missed appointment/.test(d)) return "scheduling_support"
  if (/tasks overdue|overdue/.test(d)) return "task_support"
  if (/falling off|drop-?off|activity trend/.test(d)) return "activity_dropoff"
  if (/fatigued book|not answering/.test(d)) return "fatigued_book_support"
  if (/transferred|covered|book transfer/.test(d)) return "transfer_conversation"
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

/**
 * PURE (wave 89, lane 89C): "SUPPORT SUGGESTED" — one concrete broker action per driving signal, in
 * driver order, deduped by intervention. This is what the retention board, the broker-facing coaching
 * digest and the support nudge show the broker / team lead. It is NEVER shown to the agent.
 */
export function supportSuggestionsFor(drivers: ReadonlyArray<string>): Array<{ key: InterventionKey; driver: string; action: string }> {
  const seen = new Set<InterventionKey>()
  const out: Array<{ key: InterventionKey; driver: string; action: string }> = []
  for (const driver of drivers) {
    if (!driver || !driver.trim()) continue
    const key = interventionKeyForDriver(driver)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, driver, action: LIBRARY[key].brokerAction })
  }
  return out
}

/** PURE: the same, as the text[] the radar stores (agent_retention_scores.support_suggested). */
export function supportSuggestedLines(drivers: ReadonlyArray<string>): string[] {
  return supportSuggestionsFor(drivers).map((s) => `${s.driver}: ${s.action}`)
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
