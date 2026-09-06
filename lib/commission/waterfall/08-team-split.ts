import { createServiceClient } from '@/lib/supabase/service'
import { centsToDollars } from '../utils'
import type { WaterfallContext, DistributionRecord, CompanyObligationRecord } from '../types'
import {
  resolveTeamLeadOverride,
  isAgreementEffective,
  pickTeamTerms,
  type AgentNegotiatedTermRow,
  applyTeamCap,
  interpretTeamCapLedgerRead,
  TeamCapLedgerUnreadable,
  type TeamLeadAgreement,
  type TeamCapLedger,
  type TeamCapLedgerRead,
  type TeamCapStatus,
} from '../team-lead-split'

/**
 * Read the team's cap ledger row for THIS agent — the row whose anniversary
 * window contains today, the same way 07-apply-cap.ts finds the agent's.
 *
 * FAIL CLOSED. supabase-js RESOLVES a failed query rather than rejecting, so an
 * unchecked read hands back `data: null` and an untouched `error`. Treating that
 * null as "no cap configured" would SILENTLY UNCAP THE TEAM — the exact failure
 * mode this whole change exists to remove. The whole { data, error } result is
 * therefore handed to interpretTeamCapLedgerRead, which is the pure, proven
 * decision: a non-null error becomes a THROW, never a null ledger. This function
 * keeps ONLY the query, so the decision has no database in front of it.
 *
 * `.maybeSingle()` is safe here in a way it is NOT for agent_cap_tracking: it
 * throws if the filter matches two rows, and agent_cap_tracking has no unique
 * constraint protecting its (agent, window) — a real fragility in 07-apply-cap.ts.
 * team_cap_tracking_agent_window_key (m461) makes one row per
 * (team_id, agent_id, anniversary_start) impossible to violate, so the single-row
 * assumption here is enforced by the database rather than assumed by the code.
 */
async function readTeamCapLedger(
  supabase: ReturnType<typeof createServiceClient>,
  teamId: string,
  context: WaterfallContext,
): Promise<TeamCapLedger | null> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('team_cap_tracking')
    // Explicit columns — never select("*"): a column that vanishes should break
    // loudly here, not read back as a $0 cap.
    .select('id, cap_amount, cap_paid_to_date')
    .eq('team_id', teamId)
    .eq('agent_id', context.agentId)
    .eq('brokerage_id', context.brokerageId)
    .lte('anniversary_start', today)
    .gte('anniversary_end', today)
    .maybeSingle()

  // The ENTIRE result goes to the pure decision — error included. Nothing here
  // may reduce a failed read to a null ledger. (A no-row result comes back null
  // ⇒ uncapped, the same known gap as 07-apply-cap.ts: a cap configured on
  // `teams` with no ledger row is not enforced until the ledger is seeded.)
  return interpretTeamCapLedgerRead({ data, error } as TeamCapLedgerRead, {
    teamId,
    agentId: context.agentId,
  })
}

/**
 * Resolve the closing agent's team-lead override agreement (owner rule: a team
 * lead's commission agreement applies to the team's agents). Returns null when the
 * agent has no team, no effective agreement, no positive split, or the lead cannot
 * be resolved to an AGENTS id — in every such case the override is inert.
 *
 * ID-SPACE: transactions.agent_id (context.agentId) is an agents.id; agents.team_id
 * → teams.id; teams.team_lead_id is a USERS id, so it is resolved to the lead's
 * agents.id (agents.user_id → agents.id) so the pure math + the distribution FK
 * (commission_distributions.agent_id → agents.id) stay in one id-space.
 */
async function resolveTeamLeadAgreement(
  supabase: ReturnType<typeof createServiceClient>,
  context: WaterfallContext,
): Promise<TeamLeadAgreement | null> {
  // Every read below destructures AND checks `error`: supabase-js resolves a
  // failed query, so an unchecked read makes a refusal look like "this agent has
  // no team". A throw here is caught by the caller's best-effort catch and
  // reported — the override is simply not applied, which never charges the agent
  // for a cut we could not prove was owed.
  const { data: agentRow, error: agentRowError } = await supabase
    .from('agents')
    .select('team_id')
    .eq('id', context.agentId)
    .maybeSingle()
  if (agentRowError) throw new Error(`[team-split] agents lookup failed: ${agentRowError.message}`)
  const teamId = (agentRow as any)?.team_id as string | null
  if (!teamId) return null

  const { data: team, error: teamError } = await supabase
    .from('teams')
    // cap_amount (m461) is the team's UNCAPPED/CAPPED switch — see the capAmount
    // note on TeamLeadAgreement.
    .select('id, team_lead_id, team_split_type, team_split_percent, team_split_value, terms_effective_date, cap_amount')
    .eq('id', teamId)
    .maybeSingle()
  if (teamError) throw new Error(`[team-split] teams lookup failed: ${teamError.message}`)
  if (!team || !(team as any).team_lead_id) return null
  if (!isAgreementEffective((team as any).terms_effective_date ?? null, new Date())) return null

  // teams.team_lead_id is a USERS id → resolve to the lead's AGENTS id (same
  // brokerage). If the lead is not an agent, there is no distributable target → inert.
  const { data: leadAgent, error: leadAgentError } = await supabase
    .from('agents')
    .select('id')
    .eq('user_id', (team as any).team_lead_id)
    .eq('brokerage_id', context.brokerageId)
    .maybeSingle()
  if (leadAgentError) throw new Error(`[team-split] team-lead agents lookup failed: ${leadAgentError.message}`)
  const leadAgentId = (leadAgent as any)?.id as string | null
  if (!leadAgentId) return null

  const teamSplitType = (team as any).team_split_type === 'flat' ? 'flat' : 'percent'
  const teamSplitValue = teamSplitType === 'flat'
    ? Number((team as any).team_split_value ?? 0)
    : Number((team as any).team_split_percent ?? 0)

  // ── THE AGENT'S OWN NEGOTIATED TERM OUTRANKS THE TEAM DEFAULT ─────────────
  //
  // OWNER RULING: "all commission agreements can be negotiated per agent before
  // signing." `agent_commission_profiles.team_override_percent` is where that
  // negotiated term lives — and until now NOTHING read it. A broker could agree
  // 15% with an agent whose team charges 25%, store it, show it back, and the
  // engine would still take 25% off every cheque.
  //
  // Tenant-scoped: an agent id from another brokerage resolves to no rows rather
  // than to somebody else's terms. `error` is checked because supabase-js
  // RESOLVES a failed query — an unchecked refusal here would silently fall back
  // to the team default and quietly charge the agent the rate they negotiated
  // away from.
  const { data: negotiated, error: negotiatedError } = await supabase
    .from('agent_commission_profiles')
    .select('team_override_percent, is_active, effective_date')
    .eq('agent_id', context.agentId)
    .eq('brokerage_id', context.brokerageId)
  if (negotiatedError) {
    throw new Error(`[team-split] agent_commission_profiles lookup failed: ${negotiatedError.message}`)
  }

  const terms = pickTeamTerms({
    profiles: (negotiated ?? []) as unknown as AgentNegotiatedTermRow[],
    teamSplitType,
    teamSplitValue,
    today: new Date().toISOString().slice(0, 10),
  })

  const rawCap = (team as any).cap_amount
  const capAmount = rawCap === null || rawCap === undefined ? null : Number(rawCap)

  return {
    teamId: (team as any).id,
    teamLeadId: leadAgentId,
    splitType: terms.splitType,
    splitValue: terms.splitValue,
    capAmount,
    source: terms.source,
  }
}

/**
 * STEP 8: Team Split
 * If agent belongs to team, split commission among team members
 * Team members can be paid from agent's portion or brokerage's portion.
 * ALSO applies the team-LEAD override (owner rule): a team lead's agreement takes
 * its cut of a team agent's net, sourced from the agent, paid to the lead.
 */
export async function applyTeamSplit(
  context: WaterfallContext
): Promise<WaterfallContext> {
  const supabase = createServiceClient()

  // Query team members for this agent
  const { data: teamMembers, error } = await supabase
    .from('team_members')
    .select('*')
    .eq('agent_id', context.agentId)
    .eq('brokerage_id', context.brokerageId)
    .eq('is_active', true)

  if (error) {
    throw new Error(`[team-split] Failed to fetch team members: ${error.message}`)
  }

  const teamDistributions: DistributionRecord[] = []
  const companyObligations: CompanyObligationRecord[] = [...(context.companyObligations ?? [])]
  let totalTeamDeductionCents = 0

  // ══ BROKERAGE-FUNDED MEMBERS CONSERVE, THE SAME WAY THE REVENUE SHARE DOES ══
  //
  // WAS: a source_of_funds='brokerage' row pushed a distribution "tracked … but
  // not deducted" — deducted from NOTHING. Step 11 sums every distribution plus
  // both finals against the adjusted gross with 1-cent tolerance, so any deal
  // with a brokerage-funded member failed the ENTIRE commission calculation,
  // pre-cap and post-cap alike. This was the last surviving sibling of the m575
  // revenue-share defect, and it closes under the same owner rulings: money the
  // BROKERAGE pays comes out of the deal's company dollar, and when the deal
  // cannot fund it (post-cap that dollar is $0 — the cap ends the brokerage
  // TAKING from the agent, never the brokerage PAYING its own people) the share
  // goes WHOLE to company books (m577), never silently dropped and never an
  // in-deal identity violation. (Semantics (a) of the queued ruling, chosen by
  // direct precedent from the 2026-08-28 cap ruling + the 9283ed1e/m577 rail;
  // (b) — always-company-books — remains one owner word away.)
  //
  // Order-dependence is real and deliberate: members draw the company dollar
  // down in roster order, exactly as the revenue share draws what remains after
  // this step. A share the remaining dollar cannot cover in FULL routes whole to
  // company books (no cent-splitting one person's payment across two ledgers —
  // the m577 design).
  // Defensive: a caller that never ran step 07 (tests, partial pipelines) has
  // no brokerageFinalCents — treat as $0 company dollar, which routes any
  // brokerage-funded member to company books rather than NaN-ing the math.
  let remainingBrokerageDollarCents = Number(context.brokerageFinalCents) || 0

  for (const member of teamMembers ?? []) {
    // Calculate member's share
    const memberCents = Math.round(context.agentNetCents * (member.split_percent / 100))
    if (memberCents <= 0) continue

    if (member.source_of_funds === 'agent') {
      totalTeamDeductionCents += memberCents
    } else if (member.source_of_funds === 'brokerage') {
      if (remainingBrokerageDollarCents >= memberCents) {
        remainingBrokerageDollarCents -= memberCents
      } else {
        companyObligations.push({
          obligation_type: 'team_member',
          agent_id: member.agent_id,
          calculation_type: 'percent',
          calculation_value: member.split_percent,
          calculated_amount: memberCents / 100,
          reason: 'post_cap_company_books',
          notes: `Team ${member.role} split — brokerage-funded, deal company dollar could not fund it (cap_status=${context.capStatus})`,
        })
        // NOT a distribution: company-books money is outside the deal's
        // gross == distributed + finals identity by design (m577).
        continue
      }
    }

    teamDistributions.push({
      distribution_type: 'team_member',
      agent_id: member.agent_id,
      team_id: member.team_id,
      calculation_type: 'percent',
      calculation_value: member.split_percent,
      calculated_amount: memberCents / 100, // convert to dollars
      source_of_funds: member.source_of_funds,
      notes: `Team ${member.role} split`
    })
  }

  // TEAM-LEAD OVERRIDE (owner rule): if the closing agent belongs to a team, the
  // team lead's agreement takes its cut of the agent's net, sourced from the agent,
  // paid to the lead. Best-effort: an agreement-resolution failure must never break
  // the whole commission calc — the agent simply keeps their full net (no override,
  // never a wrong charge). Inert when the agent has no team / no effective agreement.
  //
  // ══ ORDERING: WHAT THE TEAM'S CUT IS A PERCENTAGE OF ══════════════════════
  //
  // Stage 07 (brokerage cap) runs BEFORE this stage, and that is load-bearing.
  // Stage 07 does not just clamp the brokerage; when the brokerage has capped it
  // moves the brokerage's forgone share ACROSS to the agent:
  //
  //     agentNetCents = agentPortionCents + agentBonusCents
  //                                         └─ the brokerage's forgone share
  //
  // So by the time we get here, a CAPPED agent's `agentNetCents` is INFLATED by
  // the brokerage's forgone share, and a percentage cut of it is arithmetically
  // LARGER than the same percentage before the agent capped. Unbounded, that
  // means crossing the brokerage cap makes an agent pay their team MORE — the
  // cap-crush windfall partly siphoned away, the opposite of what a cap is for.
  //
  // TWO THINGS COULD BE DONE ABOUT THAT, AND THEY ARE NOT THE SAME QUESTION:
  //
  //  (a) change the BASE — take the lead's percentage of the pre-cap
  //      agentPortionCents instead of the post-cap agentNetCents; or
  //  (b) bound the TOTAL — cap what the team may collect across the year.
  //
  // BOTH ARE NOW RULED, and the ruling is (b) plus a per-agent escape hatch:
  //
  //   OWNER: "the decision about team percentage rebasing should be per deal net
  //           but all commission agreements can be negotiated per agent before
  //           signing."
  //
  // So (a) is DECLINED, deliberately and permanently: the base is THE PER-DEAL
  // NET — `agentNetCents` less member deductions, exactly what it has always
  // been. The lead's percentage is taken of what the agent actually nets on THIS
  // deal, whatever produced that number. It is NOT re-based onto the pre-cap
  // `agentPortionCents`.
  //
  // DO NOT "FIX" THIS LATER. A future reader will notice that a brokerage-capped
  // agent pays a percentage of an inflated base and will be tempted to re-base
  // it. That is the ruled-against option. Re-basing would silently rewrite every
  // signed team agreement in the system, and the ruling's second half is what
  // makes that unnecessary: an agent who does not want to pay a percentage of the
  // post-cap base NEGOTIATES THEIR OWN TERM before signing, and
  // `agent_commission_profiles.team_override_percent` is where that term lives —
  // now read by resolveTeamLeadAgreement above, and outranking the team default.
  // The answer to "this percentage is wrong for me" is a negotiated percentage,
  // not a silent change to what everyone else's percentage means.
  //
  // What the team cap adds on top: the team's annual take is bounded, so a capped
  // agent reaches the team ceiling SOONER and then pays the team nothing for the
  // rest of the year. Within a year, before that ceiling, a brokerage-capped
  // agent does pay a percentage of the larger base — and per the ruling, that is
  // correct behaviour, not a defect.
  //
  // scripts/team-cap-simulator.ts locks the base, so a re-base cannot land
  // silently: it would turn that assertion red and force this comment to be read.
  let leadDeductionCents = 0
  let teamCapStatus: TeamCapStatus = 'n/a'
  let teamAmountTowardsCap = 0
  let teamCapTeamId: string | null = null
  try {
    const agreement = await resolveTeamLeadAgreement(supabase, context)
    // Net available to the lead's cut is what remains after member deductions.
    const netForLead = context.agentNetCents - totalTeamDeductionCents
    const { leadCents, distribution } = resolveTeamLeadOverride(netForLead, context.agentId, agreement)
    if (distribution && agreement) {
      teamCapTeamId = agreement.teamId

      // THE TEAM CAP (m461). teams.cap_amount NULL ⇒ uncapped, which is what
      // every team was before m461 — short-circuit without touching the ledger.
      // Otherwise the ledger row whose anniversary window contains today decides,
      // exactly as 07-apply-cap.ts does for the brokerage.
      const ledger: TeamCapLedger | null =
        agreement.capAmount === null || agreement.capAmount === undefined
          ? null
          : await readTeamCapLedger(supabase, agreement.teamId, context)

      const capped = applyTeamCap(leadCents, ledger)
      teamCapStatus = capped.capStatus
      teamAmountTowardsCap = capped.amountTowardsCapCents

      // capped.agentKeepsCents is not added back explicitly: the agent's final
      // net below is `agentNetCents − deductions`, so deducting only what the
      // team actually collects IS handing the remainder to the agent. Cents are
      // conserved either way, which is what stage 11's validation checks.
      if (capped.teamCents > 0) {
        leadDeductionCents = capped.teamCents
        teamDistributions.push({
          ...distribution,
          calculated_amount: centsToDollars(capped.teamCents),
          cap_applied: capped.capApplied,
          cap_status: capped.capStatus,
          notes: capped.capStatus === 'hit_cap'
            ? 'Team lead override split (team cap reached on this deal)'
            : distribution.notes,
        })
      }
      // capped.teamCents === 0 ⇒ post_cap: the team is done collecting for this
      // anniversary year. NO distribution row is written at all — a $0 payable is
      // noise on a CDA, and teamCapStatus carries the explanation instead.
    }
  } catch (err) {
    if (err instanceof TeamCapLedgerUnreadable) {
      // FAIL CLOSED. An unreadable ledger is NOT an uncapped team. We cannot
      // prove the team is still owed anything, so it collects nothing on this
      // deal and the status says exactly that — rather than charging the agent a
      // cut against a ceiling we could not check.
      leadDeductionCents = 0
      teamCapStatus = 'unavailable'
      teamAmountTowardsCap = 0
      console.error('[team-split] team cap ledger unreadable — failing CLOSED, team collects $0 on this deal:', err)
    } else {
      console.error('[team-split] team-lead override skipped (non-fatal):', err)
    }
  }

  // Calculate agent's final amount after member deductions + the team-lead override.
  const agentFinalCents = context.agentNetCents - totalTeamDeductionCents - leadDeductionCents

  // Safety check: prevent negative balance from bad configuration.
  if (agentFinalCents < 0) {
    throw new Error(
      `[team-split] Team split deductions exceed available commission. ` +
      `Agent ${context.agentId} would have negative balance. ` +
      `Available: ${context.agentNetCents / 100}, Deductions: ${(totalTeamDeductionCents + leadDeductionCents) / 100}`
    )
  }

  return {
    ...context,
    agentFinalNetCents: agentFinalCents,
    // The company dollar AFTER brokerage-funded member draws — step 09's
    // revenue share reads this, so the two brokerage-funded rails share one
    // remaining balance instead of both spending the same dollar.
    brokerageFinalCents: remainingBrokerageDollarCents,
    companyObligations,
    teamDistributions,
    // Carried to stage 11, which writes the counter back to team_cap_tracking,
    // and out to the caller so a CDA / P&L can explain the team's number.
    teamCapStatus,
    teamAmountTowardsCap,
    teamCapTeamId
  }
}
