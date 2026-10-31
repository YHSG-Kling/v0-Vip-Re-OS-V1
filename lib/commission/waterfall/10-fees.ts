import { dollarsToCents } from '../utils'
import { chargeAgainstCap } from '../cap-resolver'
import type { WaterfallContext, DistributionRecord, CommissionStructureResolved } from '../types'

/**
 * STEP 10: Apply Fees
 * Deduct transaction, desk, tech, E&O fees
 *
 * ══ FEES ARE NOT THE SPLIT — THEY SURVIVE THE CAP ═══════════════════════════
 *
 * OWNER RULING (2026-08-28, verbatim): "usually when a cap is met, the brokerage
 * no longer takes from the agents if the agent has splits with a cap as a
 * commission level offering." The cap ends the brokerage's SPLIT take (stage 07
 * zeroes brokerageFinalCents and hands the forgone portion to the agent). It
 * does NOT end the fee schedule: transaction/desk/technology/E&O fees are
 * priced per deal or per portion, not as a share of company dollar, and the
 * live fee vocabulary (agent_commission_profiles.*_fee_type ∈ flat|percent) has
 * no way to express "this fee stops at cap" — so a fee configured on the
 * structure is charged on every deal, pre- and post-cap alike. If a per-level
 * fee is ever wanted, commission_rules.applies_to_level (gross|post_cap|
 * post_split) is the existing vocabulary to rule it under — do not invent a
 * second spelling here.
 *
 * WAVE 144 (lane 144D, owner ruling 9 — "cap-eligible contribution types … come from the agreement; never apply the cap to
 * unrelated royalties/fees") — THE AGREEMENT CAN NOW SAY IT. m850 gives the agreement
 * agent_commission_profiles.cap_eligible_contributions. A fee (or the royalty) the agreement LISTS counts toward the cap and
 * stops at it: it is charged up to the cap room stage 07 left (a deal can cross the cap on its fees), the rest is waived and
 * said. A fee the agreement does NOT list is charged in full and counts for nothing — the 2026-08-28 ruling above stays the
 * default for every agreement that is silent.
 *
 * ══ ROYALTY — A SEPARATE BROKERAGE FEE (wave 144, lane 144D; owner ruling 7) ══
 *
 * "Royalty fee is paid to the brokerage — separate from concession, referral, revenue share and ordinary split." The
 * agreement's royalty term (royalty_type / royalty_value) was resolved by getDefaultCommissionStructure and applied by
 * NOTHING (the distribution vocabulary always admitted 'royalty'; no stage wrote one). It is its own distribution row
 * (distribution_type 'royalty', funded by the agent, paid to the brokerage) and its own line on the CDA. A percent royalty is
 * a percent of the GROSS OF RECORD (the commission the deal earned after concessions) — the base the kernel recalculation used;
 * an agreement that states another base is a term this engine does not model (lane notes, "Still open"), never assumed.
 * The legacy royalty_percent column (numeric(6,5), units unrecorded) is NOT charged on a guess: a finding says so.
 *
 * ══ WHAT THIS STEP DEDUCTS FROM (the 2026-08-28 fix) ════════════════════════
 *
 * Fees are the LAST deduction, so they come off the agent's RUNNING net —
 * `context.agentFinalNetCents`, the number stages 07-09 produced: the post-cap
 * agentNetCents (portion + any cap bonus) less team deductions (08) less
 * agent-funded revenue share (09). The previous code recomputed the final from
 * the PRE-cap `agentPortionCents`, which silently confiscated the cap bonus
 * (violating the ruling above: a post-cap agent lost the entire brokerage
 * portion stage 07 had handed back) and re-added every stage-08/09 deduction —
 * and because stage 11 validates gross == distributed + finals, any deal with a
 * cap bonus, a team split, or a revenue share then failed the WHOLE
 * calculation. The PERCENT BASE is unchanged: a percent fee is a percent of
 * `agentPortionCents` (the agent's split portion), deliberately stable across
 * cap states — crossing the cap must not inflate a percentage fee.
 */
export async function applyFees(
  context: WaterfallContext,
  structure: CommissionStructureResolved
): Promise<WaterfallContext> {
  const feeDistributions: DistributionRecord[] = []
  let totalFeesCents = 0

  // The cap room stage 07 left for cap-eligible contributions (none when no cycle applies).
  const cycle = context.capCycle ?? null
  const eligible = new Set(cycle?.eligible ?? [])
  let remainingCapCents = cycle?.remainingAfterSplitCents ?? 0
  let amountTowardsCap = context.amountTowardsCap
  let capApplied = context.capApplied
  let capStatus = context.capStatus
  const contributedByType: Record<string, number> = { ...(cycle?.contributedByType ?? {}) }
  const capFindings: string[] = []

  const fees: Array<{ kind: 'transaction_fee' | 'desk_fee' | 'technology_fee' | 'eo_fee'; label: string; type: 'flat' | 'percent'; value: number }> = [
    { kind: 'transaction_fee', label: 'Transaction fee', type: structure.transactionFeeType, value: structure.transactionFeeValue },
    { kind: 'desk_fee', label: 'Desk fee', type: structure.deskFeeType, value: structure.deskFeeValue },
    { kind: 'technology_fee', label: 'Technology fee', type: structure.technologyFeeType, value: structure.technologyFeeValue },
    { kind: 'eo_fee', label: 'E&O insurance fee', type: structure.eoFeeType, value: structure.eoFeeValue },
  ]

  for (const fee of fees) {
    if (!(fee.value > 0)) continue
    const feeCents = fee.type === 'flat'
      ? dollarsToCents(fee.value)
      : Math.round(context.agentPortionCents * (fee.value / 100))

    const capped = chargeAgainstCap(feeCents, remainingCapCents, !!cycle && eligible.has(fee.kind))
    remainingCapCents = capped.remainingCents
    if (capped.countedCents > 0) {
      amountTowardsCap += capped.countedCents
      contributedByType[fee.kind] = (contributedByType[fee.kind] ?? 0) + capped.countedCents
    }
    if (capped.waivedCents > 0) {
      capApplied = true
      if (capStatus === 'pre_cap') capStatus = 'hit_cap'
      capFindings.push(`${fee.label} $${(capped.waivedCents / 100).toFixed(2)} waived — the agreement counts it toward the cap and the cap was reached ($${(capped.chargedCents / 100).toFixed(2)} charged)`)
    }
    if (capped.chargedCents <= 0) continue

    totalFeesCents += capped.chargedCents

    feeDistributions.push({
      distribution_type: 'fee',
      calculation_type: fee.type,
      calculation_value: fee.value,
      calculated_amount: capped.chargedCents / 100,
      source_of_funds: 'agent',
      notes: capped.waivedCents > 0 ? `${fee.label} (cap reached — $${(capped.waivedCents / 100).toFixed(2)} waived)` : fee.label,
    })
  }

  // ROYALTY — the agreement's own term, its own row (see the header).
  const royaltyDistributions: DistributionRecord[] = []
  let royaltyCents = 0
  const royaltyValue = Number(structure.royaltyValue ?? 0)
  const royaltyType = structure.royaltyType === 'percent' ? 'percent' : 'flat'
  if (royaltyValue > 0) {
    const raw = royaltyType === 'flat'
      ? dollarsToCents(royaltyValue)
      : Math.round(context.adjustedGrossCents * (royaltyValue / 100))
    const capped = chargeAgainstCap(raw, remainingCapCents, !!cycle && eligible.has('royalty'))
    remainingCapCents = capped.remainingCents
    if (capped.countedCents > 0) {
      amountTowardsCap += capped.countedCents
      contributedByType.royalty = (contributedByType.royalty ?? 0) + capped.countedCents
    }
    if (capped.waivedCents > 0) {
      capApplied = true
      if (capStatus === 'pre_cap') capStatus = 'hit_cap'
      capFindings.push(`Royalty $${(capped.waivedCents / 100).toFixed(2)} waived — the agreement counts the royalty toward the cap and the cap was reached`)
    }
    royaltyCents = capped.chargedCents
    if (royaltyCents > 0) {
      royaltyDistributions.push({
        distribution_type: 'royalty',
        calculation_type: royaltyType,
        calculation_value: royaltyValue,
        calculated_amount: royaltyCents / 100,
        source_of_funds: 'agent',
        recipient_type: 'brokerage',
        notes: royaltyType === 'percent'
          ? `Royalty ${royaltyValue}% of the gross of record, paid to the brokerage under the agreement`
          : `Royalty $${royaltyValue} flat, paid to the brokerage under the agreement`,
      })
    }
  }
  let royaltyFinding: string | null = null
  if (!(royaltyValue > 0)) {
    const legacy = Number((context.agreement?.terms as Record<string, unknown> | null | undefined)?.royalty_percent ?? 0)
    if (Number.isFinite(legacy) && legacy > 0) {
      royaltyFinding = `the agreement carries the legacy royalty_percent ${legacy} with no royalty_type / royalty_value — its units are not recorded, so no royalty was charged (state the royalty term to charge it)`
      console.warn(`[commission-engine:fees] ${context.transactionId}: ${royaltyFinding}`)
    }
  }

  // Deduct from the RUNNING net (stages 07-09's result) — never recompute from
  // the pre-cap portion. See the header: the old form confiscated the cap bonus.
  const agentFinalNetCents = context.agentFinalNetCents - totalFeesCents - royaltyCents

  // Refuse a fee schedule that overdraws the agent's remaining net — the same
  // refusal stage 08 makes for member splits: a contradictory configuration
  // fails loudly rather than paying money that does not exist.
  if (agentFinalNetCents < 0) {
    throw new Error(
      `[commission-engine:fees] Fees exceed the agent's remaining net. ` +
      `Agent ${context.agentId} would have negative balance. ` +
      `Available: ${context.agentFinalNetCents / 100}, Fees: ${(totalFeesCents + royaltyCents) / 100}`
    )
  }

  for (const f of capFindings) console.warn(`[commission-engine:fees] ${context.transactionId}: ${f}`)

  return {
    ...context,
    totalFeesCents,
    feeDistributions,
    royaltyDistributions,
    royaltyCents,
    agentFinalNetCents,
    amountTowardsCap,
    capApplied,
    capStatus,
    capCycle: cycle
      ? { ...cycle, remainingAfterSplitCents: remainingCapCents, contributedByType, findings: [...cycle.findings, ...capFindings] }
      : cycle,
    // The legacy-royalty finding rides the agreement's own findings, which stage 11 freezes in engine_inputs.
    agreement: royaltyFinding && context.agreement
      ? { ...context.agreement, findings: [...context.agreement.findings, royaltyFinding] }
      : context.agreement,
  }
}
