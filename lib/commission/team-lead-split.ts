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
import { dollarsToCents } from "./utils"

/** The team-lead commission agreement, resolved from the `teams` row.
 *
 * ID-SPACE CONTRACT (verified against the live schema): `teamLeadId` MUST be the
 * lead's AGENTS id — the same space as the closing agent id passed to
 * resolveTeamLeadOverride and as commission_distributions.agent_id. Note that
 * teams.team_lead_id is a USERS id, so the caller resolves it to the lead's
 * agents.id (agents.user_id → agents.id) before building this agreement. Mixing
 * the spaces would break both the self-cut exclusion and the distribution FK. */
export interface TeamLeadAgreement {
  teamId: string
  /** The team lead's AGENTS id (resolved from teams.team_lead_id, a users id). */
  teamLeadId: string
  /** teams.team_split_type */
  splitType: "percent" | "flat"
  /** teams.team_split_percent (when percent) or teams.team_split_value in DOLLARS (when flat). */
  splitValue: number
  /**
   * teams.cap_amount (m461) in DOLLARS — the ceiling on what this TEAM collects
   * from this agent per anniversary year. NULL/undefined = UNCAPPED, which is
   * what every team was before m461 and what stage 08 did for every team.
   *
   * OPTIONAL on purpose: this is the config SWITCH, not the running total. The
   * arithmetic uses the LEDGER row's cap_amount (team_cap_tracking), exactly as
   * 07-apply-cap.ts uses agent_cap_tracking.cap_amount rather than any config
   * copy — the ledger is what the engine reads and therefore what it must honour.
   */
  capAmount?: number | null
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

// ─────────────────────────────────────────────────────────────────────────────
// THE TEAM CAP (m461)
// ─────────────────────────────────────────────────────────────────────────────
//
// OWNER RULING: "brokerage and teams may also have commission caps."
//
// A cap is a CEILING ON WHAT AN ENTITY COLLECTS from an agent per anniversary
// year. 07-apply-cap.ts says it in its own header — "Cap tracks brokerage's
// cumulative earnings, NOT agent's" — and once the brokerage has taken
// cap_amount its share drops to $0 and the agent keeps the rest.
//
// Before this, the TEAM's take had NO ceiling: the override above was applied
// with no limit at all, so a team collected for ever while the brokerage
// stopped. This closes that asymmetry, and it is deliberately the SAME SHAPE as
// stage 07 (same branch order, same three statuses, same cents arithmetic) so a
// reader who knows one knows the other.
//
// This half is PURE so the money math is testable without a database; the I/O
// half (finding the ledger row, and failing CLOSED when it cannot be read) lives
// in 08-team-split.ts, and the counter is written back in 11-validate-persist.ts.

/**
 * The team cap outcome, surfaced so a CDA or a P&L can EXPLAIN the number
 * instead of just printing it.
 *
 *  · `n/a`         no ceiling applied — teams.cap_amount is NULL (an uncapped
 *                  team, the pre-m461 behaviour for every team) or the agent has
 *                  no ledger row covering today. Stated, never silent.
 *  · `pre_cap`     the team's whole cut fits under the remaining ceiling.
 *  · `hit_cap`     THIS deal crosses the ceiling — the team takes only the
 *                  remainder and the agent keeps the difference.
 *  · `post_cap`    the ceiling was already reached — the team takes $0 and the
 *                  agent keeps the entire cut.
 *  · `unavailable` the ledger could not be READ. NOT a member of stage 07's
 *                  union, and that is the point: an unreadable ledger is not
 *                  "uncapped". The team collects NOTHING on this deal and the
 *                  status says why. See the fail-closed note in 08-team-split.ts.
 */
export type TeamCapStatus = "pre_cap" | "hit_cap" | "post_cap" | "n/a" | "unavailable"

/** One row of `team_cap_tracking` — the per-(team, agent, anniversary) ledger.
 *  Amounts are DOLLARS here because the columns are numeric(12,2) dollars; they
 *  are converted to cents at the boundary below and never mixed. */
export interface TeamCapLedger {
  /** team_cap_tracking.id — carried so stage 11 writes back the same row. */
  id: string
  /** team_cap_tracking.cap_amount (dollars). */
  capAmountDollars: number
  /** team_cap_tracking.cap_paid_to_date (dollars). */
  capPaidToDateDollars: number
}

export interface TeamCapResult {
  /** What the TEAM actually collects on this deal, in cents (never > the cut). */
  teamCents: number
  /** What the cap HANDED BACK to the agent, in cents (cut − teamCents). */
  agentKeepsCents: number
  /** True when the ceiling changed the outcome (mirrors stage 07's capApplied). */
  capApplied: boolean
  capStatus: TeamCapStatus
  /** Cents to ADD to cap_paid_to_date in stage 11 — equals teamCents, named
   *  separately to mirror stage 07's amountTowardsCap and to keep the persisted
   *  counter distinct from the money paid out. */
  amountTowardsCapCents: number
}

/**
 * PURE: bound the team's cut by what the team has left to collect this
 * anniversary year.
 *
 * `ledger === null` means UNCAPPED — either teams.cap_amount is NULL or no
 * ledger row covers today. That is exactly the pre-m461 behaviour and it is
 * reported as `n/a` rather than left implicit.
 *
 * NOTE (the same fragility m461 documents for agents): a cap configured on the
 * `teams` row with no team_cap_tracking row covering today is NOT enforced —
 * the engine reads the ledger, so an unseeded cap is an unenforced cap. That is
 * the m461 defect one level down; the ledger must be seeded when a team lead
 * sets a cap.
 *
 * Branch order is copied from 07-apply-cap.ts on purpose:
 *   remaining <= 0        → post_cap: team $0, agent keeps the whole cut
 *   cut <= remaining      → pre_cap:  team keeps its whole cut
 *   otherwise             → hit_cap:  team takes the remainder, agent the rest
 */
/**
 * Thrown when `team_cap_tracking` cannot be READ. Its own class so the waterfall
 * step can tell "the cap ledger is unreadable" (fail CLOSED — the team collects
 * nothing and the status says so) apart from "the agreement could not be
 * resolved" (inert — there was never a cut to take).
 */
export class TeamCapLedgerUnreadable extends Error {}

/** The raw shape a supabase-js `.maybeSingle()` on team_cap_tracking resolves to. */
export interface TeamCapLedgerRead {
  data: { id: string; cap_amount: number | string; cap_paid_to_date: number | string } | null
  error: { message: string } | null
}

/**
 * PURE: turn a supabase-js result into a ledger — or a THROW.
 *
 * THIS IS THE FAIL-CLOSED DECISION, kept pure so it is provable without a
 * database. supabase-js RESOLVES a failed query rather than rejecting, so a read
 * that ignores `error` hands back `data: null` — and `data: null` means UNCAPPED
 * (see applyTeamCap). An unchecked read would therefore SILENTLY UNCAP THE TEAM,
 * the exact failure this whole change exists to remove. So a non-null `error` is
 * never allowed to become a null ledger; it becomes a throw, and the caller turns
 * that throw into a ZERO team cut on this deal.
 *
 * The genuine no-row case (data null, error null) still returns null ⇒ uncapped.
 * The two must stay distinguishable, which is why both branches exist here rather
 * than one `if (!data) return null`.
 *
 * numeric(12,2) can arrive from PostgREST as a STRING, so both amounts are
 * coerced to numbers before any arithmetic touches them.
 */
export function interpretTeamCapLedgerRead(
  result: TeamCapLedgerRead,
  ctx: { teamId: string; agentId: string },
): TeamCapLedger | null {
  if (result.error) {
    throw new TeamCapLedgerUnreadable(
      `[team-split] team_cap_tracking unreadable for team ${ctx.teamId} / agent ${ctx.agentId}: ${result.error.message}`,
    )
  }
  // No row covering today ⇒ uncapped (reported as 'n/a', never silent).
  if (!result.data) return null
  return {
    id: result.data.id,
    capAmountDollars: Number(result.data.cap_amount),
    capPaidToDateDollars: Number(result.data.cap_paid_to_date),
  }
}

export function applyTeamCap(leadCents: number, ledger: TeamCapLedger | null): TeamCapResult {
  // A non-positive cut has nothing to cap — no ceiling is applied because there
  // is nothing to apply it to, which is what 'n/a' means. Defensive only:
  // resolveTeamLeadOverride already returns a null distribution in that case, so
  // stage 08 never reaches here with one. Guarding keeps agentKeepsCents
  // non-negative in every branch.
  if (!Number.isFinite(leadCents) || leadCents <= 0) {
    return { teamCents: 0, agentKeepsCents: 0, capApplied: false, capStatus: "n/a", amountTowardsCapCents: 0 }
  }

  // UNCAPPED — say so in the status rather than silently behaving as before.
  if (!ledger) {
    return { teamCents: leadCents, agentKeepsCents: 0, capApplied: false, capStatus: "n/a", amountTowardsCapCents: 0 }
  }

  // MONEY IN CENTS. The ledger columns are numeric(12,2) DOLLARS and the
  // waterfall runs in integer cents, so convert at the boundary with
  // dollarsToCents (Math.round) exactly as stage 07 does. A bare `* 100` here
  // leaves 810009.99999999 for $8,100.10 and the drift is real money.
  const capAmountCents = dollarsToCents(ledger.capAmountDollars)
  const paidToDateCents = dollarsToCents(ledger.capPaidToDateDollars)
  const remainingCapCents = capAmountCents - paidToDateCents

  if (remainingCapCents <= 0) {
    // Already capped (including a zero cap, and a ledger already OVER its cap) —
    // the team collects $0 and the agent keeps the whole cut. This is the mirror
    // of "brokerage gets $0 and agent gets the full brokerage portion".
    return { teamCents: 0, agentKeepsCents: leadCents, capApplied: true, capStatus: "post_cap", amountTowardsCapCents: 0 }
  }

  if (leadCents <= remainingCapCents) {
    // Still under the ceiling — the team keeps its whole cut. `<=` (not `<`) so
    // a cut that lands EXACTLY on the ceiling is pre_cap, not hit_cap: nothing
    // was handed back, so nothing was capped. Same boundary as stage 07.
    return { teamCents: leadCents, agentKeepsCents: 0, capApplied: false, capStatus: "pre_cap", amountTowardsCapCents: leadCents }
  }

  // THIS deal crosses the ceiling: the team takes only what is left and the
  // agent keeps the difference. Cents are conserved — teamCents + agentKeeps
  // always equals the uncapped cut, in every branch, so the stage 11 waterfall
  // validation (gross === sum of distributions) cannot drift.
  return {
    teamCents: remainingCapCents,
    agentKeepsCents: leadCents - remainingCapCents,
    capApplied: true,
    capStatus: "hit_cap",
    amountTowardsCapCents: remainingCapCents,
  }
}
