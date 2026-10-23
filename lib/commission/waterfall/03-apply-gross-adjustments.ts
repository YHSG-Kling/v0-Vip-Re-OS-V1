import { createServiceClient } from '@/lib/supabase/service'
import { dollarsToCents } from '../utils'
import type { WaterfallContext, DistributionRecord } from '../types'

/**
 * STEP 3: Apply Gross Adjustments
 * Query commission_adjustments for gross-level changes
 */
export async function applyGrossAdjustments(
  context: WaterfallContext
): Promise<WaterfallContext> {
  const supabase = createServiceClient()

  const { data: adjustments } = await supabase
    .from('commission_adjustments')
    .select('*')
    .eq('transaction_id', context.transactionId)
    .eq('applies_to', 'gross')
    .eq('is_active', true)

  if (!adjustments || adjustments.length === 0) {
    return {
      ...context,
      grossAdjustments: []
    }
  }

  let adjustedGrossCents = context.grossCommissionCents
  const grossAdjustments: DistributionRecord[] = []

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

    adjustedGrossCents += signedCents

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

  return {
    ...context,
    adjustedGrossCents,
    grossAdjustments
  }
}
