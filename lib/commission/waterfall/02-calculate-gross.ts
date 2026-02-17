import { createServiceClient } from '@/lib/supabase/service'
import { dollarsToCents } from '../utils'
import type { WaterfallContext } from '../types'

/**
 * STEP 2: Calculate Gross Commission
 * grossCommissionCents = purchasePriceCents * grossRateDecimal
 */
export async function calculateGross(
  transactionId: string,
  grossRateDecimal: number
): Promise<Pick<WaterfallContext, 'purchasePriceCents' | 'grossCommissionCents'>> {
  const supabase = createServiceClient()

  // Get purchase price
  const { data: transaction } = await supabase
    .from('transactions')
    .select('purchase_price')
    .eq('id', transactionId)
    .maybeSingle()

  if (!transaction?.purchase_price) {
    throw new Error(`[commission-engine] Transaction ${transactionId} has no purchase_price`)
  }

  const purchasePrice = transaction.purchase_price
  
  if (purchasePrice <= 0) {
    throw new Error(`[commission-engine] Purchase price must be > 0, got ${purchasePrice}`)
  }

  if (grossRateDecimal <= 0 || grossRateDecimal > 1) {
    throw new Error(`[commission-engine] Gross rate must be 0 < rate <= 1, got ${grossRateDecimal}`)
  }

  const purchasePriceCents = dollarsToCents(purchasePrice)
  const grossCommissionCents = Math.round(purchasePriceCents * grossRateDecimal)

  return {
    purchasePriceCents,
    grossCommissionCents
  }
}
