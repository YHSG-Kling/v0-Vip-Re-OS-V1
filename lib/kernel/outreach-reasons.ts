/**
 * lib/kernel/outreach-reasons.ts
 *
 * "REASON FOR TODAY'S OUTREACH" (concierge micro-detail A.9) — every
 * OS-suggested client touch carries a one-word WHY (check-in, expectation
 * reset, decision required, celebration…), so no contact ever feels like
 * spray: the approving human sees the justification before releasing, and
 * the tag is queryable for the trust meter. Governed like the signal bus:
 * a CODE registry (no DB CHECK — vocabulary evolves with the rails, the
 * sim guards it), stored on agent_client_messages.outreach_reason
 * (l53-s01). Callers pass the reason explicitly; a PURE keyword inferrer
 * back-fills the rest from the rationale/subject — and stays HONESTLY
 * null when nothing matches (an untagged touch is visible, never
 * mislabeled). NOT server-only (simulator-driven).
 */

export const OUTREACH_REASONS = [
  "welcome",
  "recognition",
  "celebration",
  "recovery",
  "decision_required",
  "expectation_reset",
  "milestone_update",
  "check_in",
] as const

export type OutreachReason = (typeof OUTREACH_REASONS)[number]

const LABELS: Record<OutreachReason, string> = {
  welcome: "Welcome",
  recognition: "Recognition",
  celebration: "Celebration",
  recovery: "Service recovery",
  decision_required: "Decision required",
  expectation_reset: "Expectation reset",
  milestone_update: "Milestone update",
  check_in: "Check-in",
}

export function describeOutreachReason(key: string | null | undefined): string | null {
  if (!key) return null
  return LABELS[key as OutreachReason] ?? null
}

/** SPECIFIC families first; the generic ones last — an update that congratulates
 *  is a celebration, not a milestone_update. */
const FAMILIES: Array<{ key: OutreachReason; pattern: RegExp }> = [
  { key: "welcome", pattern: /\b(welcome|journey map|how we'?ll work together)\b/ },
  { key: "recovery", pattern: /\b(recover|apolog|regroup|rejected|fell through|slipped|didn'?t go through|failed send)\b/ },
  { key: "celebration", pattern: /\b(congrat|celebrat|accepted|cleared|went live|milestone reached)\b/ },
  { key: "recognition", pattern: /\b(saw (you|how much)|i see you|noticed (you|how)|worked on this)\b/ },
  { key: "decision_required", pattern: /\b(decision|approve|choose between|options? (to|before)|respond by|deadline)\b/ },
  { key: "expectation_reset", pattern: /\b(expectation|timeline (shift|slip|chang)|delay|market chang|reset|taking longer)\b/ },
  { key: "milestone_update", pattern: /\b(update|status|what (just )?happened|next step|progress|stage)\b/ },
  { key: "check_in", pattern: /\b(check.?in|checking in|thinking (of|about) you|touch base|been a while|quiet)\b/ },
]

/** PURE: infer the reason from what the proposer wrote — honest null when
 *  no family matches (visible as untagged, never mislabeled). */
export function inferOutreachReason(input: { rationale?: string | null; subject?: string | null }): OutreachReason | null {
  const hay = [input.rationale ?? "", input.subject ?? ""].join(" ").toLowerCase()
  if (!hay.trim()) return null
  for (const fam of FAMILIES) if (fam.pattern.test(hay)) return fam.key
  return null
}
