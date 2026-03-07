import type { WaterfallContext } from '../types'

/**
 * STEP 2: Calculate Gross Commission
 * grossCommissionCents = purchasePriceCents * grossRateDecimal
 * adjustedGrossCents = grossCommissionCents (will be adjusted in step 3)
 */
export function calculateGrossCommission(
  context: WaterfallContext
): WaterfallContext {
  const grossCommissionCents = Math.round(context.purchasePriceCents * context.grossRateDecimal)

  return {
    ...context,
    grossCommissionCents,
    adjustedGrossCents: grossCommissionCents
  }
}
