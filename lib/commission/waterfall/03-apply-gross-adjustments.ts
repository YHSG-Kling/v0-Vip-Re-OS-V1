import { createServiceClient } from '@/lib/supabase/service'
import { dollarsToCents } from '../utils'
import { concessionWaterfallVerdict, type ConcessionSettlementTreatment } from '../agent-concession'
import type { WaterfallContext, DistributionRecord, ConcessionEvidence } from '../types'

/**
 * STEP 3: Apply Gross Adjustments
 * Query commission_adjustments for gross-level changes
 *
 * WAVE 144 (lane 144D, owner ruling 4) — A GROSS-LEVEL CREDIT IS AN AGENT CONCESSION. The listing agreement's agreed
 * commission reduction and an agent's credit to the buyer / seller are both "a credit the AGENT gives … subtracted from THAT
 * agent's gross commission"; they come off the gross here, before the split. A SELLER concession (seller → buyer out of the
 * seller's net) is never read here — its record is the contract term and the seller net sheet, never commission_adjustments.
 * Each row passes lib/commission/agent-concession.ts concessionWaterfallVerdict: a credit owed by ANOTHER agent, or one still
 * awaiting the broker's approval, HOLDS a final calculation (refused by name); a denied / withdrawn one never applies.
 * Every row the stage saw rides context.concessions — agent, beneficiary, amount, reason, approval, settlement treatment and
 * ledger effect — and stage 11 freezes it in commission_calculations.breakdown_json.
 *
 * FAIL CLOSED (CLAUDE.md §3): supabase-js RESOLVES a refused read; reading it as "no adjustments" would post the FULL gross
 * over a concession the seller was promised. A refusal throws.
 */
export async function applyGrossAdjustments(
  context: WaterfallContext,
  mode: 'preview' | 'final' = 'final',
): Promise<WaterfallContext> {
  const supabase = createServiceClient()

  const { data: adjustments, error } = await supabase
    .from('commission_adjustments')
    .select('*')
    .eq('transaction_id', context.transactionId)
    .eq('applies_to', 'gross')
    .eq('is_active', true)

  if (error) {
    throw new Error(`[commission-engine:gross-adjustments] commission adjustments read refused: ${error.message}`)
  }

  if (!adjustments || adjustments.length === 0) {
    return {
      ...context,
      grossAdjustments: [],
      concessions: [],
    }
  }

  let adjustedGrossCents = context.grossCommissionCents
  const grossAdjustments: DistributionRecord[] = []
  const concessions: ConcessionEvidence[] = []
  const holds: string[] = []

  for (const adj of adjustments) {
    const magnitudeCents = adj.value_type === 'flat'
      ? dollarsToCents(adj.value)
      : Math.round(context.grossCommissionCents * (adj.value / 100))

    // DIRECTION IS LOAD-BEARING, and it was being ignored.
    //
    // commission_adjustments.value carries a CHECK of `value >= 0`, so every
    // adjustment is stored as a POSITIVE magnitude and the `direction` column
    // (credit | surcharge) is what says which way it moves. This loop did
    // `adjustedGrossCents += adjustmentCents` unconditionally — so a seller's
    // negotiated 0.5% CREDIT raised the gross commission by 0.5% instead of
    // lowering it, turning a discount into a surcharge.
    //
    // It went unseen because the only writer of this table could never insert
    // (three NOT NULL / CHECK violations on an unchecked write, fixed in
    // app/actions/seller-listing/execution-engine.ts). With no rows, the loop
    // never ran. The two defects hid each other.
    const signedCents = adj.direction === 'credit' ? -magnitudeCents : magnitudeCents
    const isCredit = adj.direction === 'credit'
    const verdict = concessionWaterfallVerdict(adj, { producingAgentId: context.agentId })
    const base: Omit<ConcessionEvidence, 'verdict' | 'signedCents' | 'ledgerEffect' | 'finding'> = {
      adjustmentId: String(adj.id),
      kind: isCredit ? 'agent_concession' : 'surcharge',
      concessionAgentId: (adj.concession_agent_id as string | null | undefined) ?? (isCredit ? context.agentId : null),
      beneficiary: (adj.recipient_type as string | null | undefined) ?? null,
      beneficiaryName: (adj.recipient_name as string | null | undefined) ?? null,
      reason: (adj.notes as string | null | undefined) ?? null,
      approvalStatus: String(adj.approval_status ?? 'not_required'),
      // A row written before m850 has no treatment: the listing agreement's agreed reduction is what that writer records.
      settlementTreatment: (adj.settlement_treatment as ConcessionSettlementTreatment | null | undefined) ?? (isCredit ? 'reduced_commission_rate' : null),
    }

    if (verdict.verdict !== 'apply') {
      concessions.push({ ...base, verdict: verdict.verdict === 'hold' ? 'held' : 'skipped', signedCents: 0, ledgerEffect: 'none', finding: verdict.finding })
      if (verdict.verdict === 'hold') holds.push(verdict.finding)
      console.warn(`[commission-engine:gross-adjustments] ${context.transactionId}: ${verdict.finding}`)
      continue
    }

    adjustedGrossCents += signedCents
    concessions.push({ ...base, verdict: 'applied', signedCents, ledgerEffect: isCredit ? 'reduces_gross_before_split' : 'increases_gross_before_split', finding: null })

    grossAdjustments.push({
      distribution_type: 'fee',
      calculation_type: adj.value_type,
      calculation_value: adj.value,
      // Signed, so the distribution record reads the same direction as the maths.
      calculated_amount: signedCents / 100,
      source_of_funds: 'brokerage',
      rule_id: adj.id,
      notes: adj.notes
    })
  }

  // A held concession is an UNDECIDED commitment: a FINAL calculation (it posts a ledger and a payable) refuses by name
  // rather than post a number the broker has not authorised — or charge the wrong agent. A PREVIEW still runs and shows it.
  if (mode === 'final' && holds.length > 0) {
    throw new Error(`[commission-engine:agent-concession] ${holds.join('; ')}`)
  }

  if (adjustedGrossCents < 0) {
    throw new Error(`[commission-engine:gross-adjustments] the concessions on transaction ${context.transactionId} exceed the gross commission they are taken from`)
  }

  return {
    ...context,
    adjustedGrossCents,
    grossAdjustments,
    concessions,
  }
}
