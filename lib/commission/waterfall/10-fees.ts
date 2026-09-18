import { dollarsToCents } from '../utils'
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

  // Transaction Fee
  if (structure.transactionFeeValue > 0) {
    const feeCents = structure.transactionFeeType === 'flat'
      ? dollarsToCents(structure.transactionFeeValue)
      : Math.round(context.agentPortionCents * (structure.transactionFeeValue / 100))

    totalFeesCents += feeCents

    feeDistributions.push({
      distribution_type: 'fee',
      calculation_type: structure.transactionFeeType,
      calculation_value: structure.transactionFeeValue,
      calculated_amount: feeCents / 100,
      source_of_funds: 'agent'
    })
  }

  // Desk Fee
  if (structure.deskFeeValue > 0) {
    const feeCents = structure.deskFeeType === 'flat'
      ? dollarsToCents(structure.deskFeeValue)
      : Math.round(context.agentPortionCents * (structure.deskFeeValue / 100))

    totalFeesCents += feeCents

    feeDistributions.push({
      distribution_type: 'fee',
      calculation_type: structure.deskFeeType,
      calculation_value: structure.deskFeeValue,
      calculated_amount: feeCents / 100,
      source_of_funds: 'agent'
    })
  }

  // Technology Fee
  if (structure.technologyFeeValue > 0) {
    const feeCents = structure.technologyFeeType === 'flat'
      ? dollarsToCents(structure.technologyFeeValue)
      : Math.round(context.agentPortionCents * (structure.technologyFeeValue / 100))

    totalFeesCents += feeCents

    feeDistributions.push({
      distribution_type: 'fee',
      calculation_type: structure.technologyFeeType,
      calculation_value: structure.technologyFeeValue,
      calculated_amount: feeCents / 100,
      source_of_funds: 'agent'
    })
  }

  // E&O Insurance Fee
  if (structure.eoFeeValue > 0) {
    const feeCents = structure.eoFeeType === 'flat'
      ? dollarsToCents(structure.eoFeeValue)
      : Math.round(context.agentPortionCents * (structure.eoFeeValue / 100))

    totalFeesCents += feeCents

    feeDistributions.push({
      distribution_type: 'fee',
      calculation_type: structure.eoFeeType,
      calculation_value: structure.eoFeeValue,
      calculated_amount: feeCents / 100,
      source_of_funds: 'agent'
    })
  }

  // Deduct from the RUNNING net (stages 07-09's result) — never recompute from
  // the pre-cap portion. See the header: the old form confiscated the cap bonus.
  const agentFinalNetCents = context.agentFinalNetCents - totalFeesCents

  // Refuse a fee schedule that overdraws the agent's remaining net — the same
  // refusal stage 08 makes for member splits: a contradictory configuration
  // fails loudly rather than paying money that does not exist.
  if (agentFinalNetCents < 0) {
    throw new Error(
      `[commission-engine:fees] Fees exceed the agent's remaining net. ` +
      `Agent ${context.agentId} would have negative balance. ` +
      `Available: ${context.agentFinalNetCents / 100}, Fees: ${totalFeesCents / 100}`
    )
  }

  return {
    ...context,
    totalFeesCents,
    feeDistributions,
    agentFinalNetCents
  }
}
