import { dollarsToCents, validatePositive } from "../utils"

export function calculateGrossCommission(
  purchasePrice: number,
  grossRateDecimal: number
): { grossCommissionCents: number } {
  validatePositive(purchasePrice, "purchase_price")
  
  if (grossRateDecimal <= 0 || grossRateDecimal > 1) {
    throw new Error(`[commission-engine:calculate-gross] Invalid gross rate: ${grossRateDecimal}`)
  }
  
  const purchasePriceCents = dollarsToCents(purchasePrice)
  const grossCommissionCents = Math.round(purchasePriceCents * grossRateDecimal)
  
  return { grossCommissionCents }
}
