// lib/commission/team-lead-split.ts
// ─────────────────────────────────────────────────────────────────────────────
// TEAM-LEAD OVERRIDE SPLIT (business rule: "team leaders also have a commission
// agreement, so that agreement is part of the commission splits for the team's
// agents if the agent is part of a team"). When the CLOSING agent belongs to a
// team, the team LEAD takes their agreement's cut of that agent's net commission,
// paid as its own distribution sourced from the agent.
//
// This is the PURE math half (no DB, deterministic) so it is fully unit-testable
// on its own; the waterfall step (08-team-split) resolves the agreement from the
// live `teams` row and feeds it here. Amounts are integer cents end to end.
//
// Design decisions (owner-directed):
//  • The lead's cut is a PERCENT of the agent's NET (after the agent/brokerage
//    split), or a FLAT dollar amount — whichever the team agreement specifies.
//  • It is sourced FROM the agent (a deduction from the agent's take), paid TO
//    the lead — the standard real-team model.
//  • A lead never takes a cut of their OWN deal, and the deduction is clamped so
//    the agent can never go negative from a misconfigured agreement.

import type { DistributionRecord } from "./types"

/** The team-lead commission agreement, resolved from the `teams` row. */
export interface TeamLeadAgreement {
  teamId: string
  teamLeadId: string
  /** teams.team_split_type */
  splitType: "percent" | "flat"
  /** teams.team_split_percent (when percent) or teams.team_split_value in DOLLARS (when flat). */
  splitValue: number
}

export interface TeamLeadSplitResult {
  /** The team lead's cut, in cents, deducted from the agent's net. */
  leadCents: number
  /** The distribution row to persist for the lead (null when no cut applies). */
  distribution: DistributionRecord | null
}

/**
 * PURE: compute the team lead's override cut of a team agent's net commission.
 *
 * Returns leadCents=0 / distribution=null (a no-op) when: there is no agreement,
 * the agent's net is non-positive, the closing agent IS the lead, or the agreement
 * yields a non-positive amount. The cut is CLAMPED to the agent's net so a bad
 * agreement can never drive the agent negative.
 */
export function resolveTeamLeadOverride(
  agentNetCents: number,
  closingAgentId: string,
  agreement: TeamLeadAgreement | null,
): TeamLeadSplitResult {
  const none: TeamLeadSplitResult = { leadCents: 0, distribution: null }
  if (!agreement) return none
  if (!Number.isFinite(agentNetCents) || agentNetCents <= 0) return none
  if (agreement.teamLeadId === closingAgentId) return none // a lead takes no cut of their own deal
  if (!(agreement.splitValue > 0)) return none

  const rawCents = agreement.splitType === "percent"
    ? Math.round(agentNetCents * (agreement.splitValue / 100))
    : Math.round(agreement.splitValue * 100) // flat dollars → cents

  const leadCents = Math.max(0, Math.min(rawCents, agentNetCents)) // clamp so the agent never goes negative
  if (leadCents === 0) return none

  return {
    leadCents,
    // Reuses the existing 'team_member' distribution_type (allowed by the live
    // CHECK) — the note distinguishes it as the lead override.
    distribution: {
      distribution_type: "team_member",
      agent_id: agreement.teamLeadId,
      team_id: agreement.teamId,
      calculation_type: agreement.splitType,
      calculation_value: agreement.splitValue,
      calculated_amount: leadCents / 100,
      source_of_funds: "agent",
      notes: "Team lead override split",
    },
  }
}

/** PURE: is a team agreement in effect as of `asOf`? (null effective date = always). */
export function isAgreementEffective(effectiveDate: string | null, asOf: Date): boolean {
  if (!effectiveDate) return true
  const t = Date.parse(effectiveDate)
  return Number.isNaN(t) ? true : t <= asOf.getTime()
}
