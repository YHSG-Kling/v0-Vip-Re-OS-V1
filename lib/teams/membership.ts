// lib/teams/membership.ts
//
// Team-membership rules — the WRITE path that was missing. Teams could be created and the team
// dashboard + the Finance commission waterfall (lib/commission/waterfall/08-team-split.ts) both
// READ team_members, but nothing populated it, so a team's commission split was always a no-op.
// This is the pure rule layer the server actions enforce. Multi-manager: the Recruiting Manager /
// team lead builds the roster here; the Finance Manager's waterfall splits commission by it.

/** Where a team member's split is paid from (mirrors team_members.source_of_funds). */
export const SOURCE_OF_FUNDS = ["agent", "brokerage"] as const
export type SourceOfFunds = (typeof SOURCE_OF_FUNDS)[number]

/** Recognized team roles (free-text in the DB, but these are the canonical set the UI offers). */
export const TEAM_ROLES = ["lead", "buyers_agent", "listing_partner", "isa", "tc", "showing_assistant", "member"] as const
export type TeamRole = (typeof TEAM_ROLES)[number]

export function isSourceOfFunds(v: unknown): v is SourceOfFunds {
  return typeof v === "string" && (SOURCE_OF_FUNDS as readonly string[]).includes(v)
}

export interface TeamMemberInput {
  splitPercent: number
  sourceOfFunds: SourceOfFunds
  /** Sum of the AGENT-funded split percents already on the team for the SAME closing agent's
   *  portion (used to guard against >100% agent-funded deductions — the waterfall throws on a
   *  negative agent balance). Brokerage-funded splits don't count against the agent's 100%. */
  existingAgentFundedPct?: number
}

/** PURE: validate a team-member add/update. */
export function validateTeamMember(input: TeamMemberInput): { ok: boolean; error?: string } {
  if (!Number.isFinite(input.splitPercent)) return { ok: false, error: "Split percent must be a number" }
  if (input.splitPercent <= 0 || input.splitPercent > 100) return { ok: false, error: "Split percent must be between 0 and 100" }
  if (!isSourceOfFunds(input.sourceOfFunds)) return { ok: false, error: "Source of funds must be 'agent' or 'brokerage'" }
  if (input.sourceOfFunds === "agent") {
    const total = (input.existingAgentFundedPct ?? 0) + input.splitPercent
    if (total > 100) return { ok: false, error: `Agent-funded splits would total ${total}% (>100%). Reduce a split or pay from the brokerage.` }
  }
  return { ok: true }
}

/** PURE: the agent-funded portion total for a set of members (the cap the waterfall enforces). */
export function agentFundedTotal(members: Array<{ split_percent: number; source_of_funds: string; is_active?: boolean }>): number {
  return members
    .filter((m) => (m.is_active ?? true) && m.source_of_funds === "agent")
    .reduce((s, m) => s + (m.split_percent ?? 0), 0)
}
