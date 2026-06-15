// lib/offers/offer-strength.ts
// PURE buyer-strength scoring — the single source of truth for "how likely is THIS offer to close
// cleanly" (cash vs loan, down payment, contingencies, earnest money). Extracted so the multi-offer
// matrix AND the seller decision room share identical logic (no drift). No I/O.

export type StrengthLabel = "very_strong" | "strong" | "moderate" | "weak"

export interface BuyerStrengthInput {
  financingType: string | null
  downPaymentPercent: number | null
  contingencies: string[]
  emd: number | null
  offerPrice: number
}

/** 0–100 certainty-of-close score. Higher = more likely to close without falling apart. */
export function scoreBuyerStrength(input: BuyerStrengthInput): number {
  let score = 50

  // Cash > Conventional > FHA/VA > USDA
  if (input.financingType === "cash")       score += 30
  else if (input.financingType === "conventional") score += 15
  else if (input.financingType === "fha")   score += 5
  else if (input.financingType === "va")    score += 5

  // Higher down payment = more skin in the game + appraisal cushion
  if (input.downPaymentPercent != null) {
    if (input.downPaymentPercent >= 25) score += 10
    else if (input.downPaymentPercent >= 20) score += 5
    else if (input.downPaymentPercent < 5) score -= 5
  }

  // Fewer contingencies = stronger
  const c = input.contingencies.length
  if (c === 0) score += 15
  else if (c === 1) score += 5
  else if (c >= 3) score -= 10

  // EMD as percent of price
  if (input.emd && input.offerPrice) {
    const emdPct = (input.emd / input.offerPrice) * 100
    if (emdPct >= 5) score += 10
    else if (emdPct >= 3) score += 5
    else if (emdPct < 1) score -= 10
  }

  return Math.max(0, Math.min(100, score))
}

export function labelStrength(score: number): StrengthLabel {
  if (score >= 85) return "very_strong"
  if (score >= 70) return "strong"
  if (score >= 50) return "moderate"
  return "weak"
}
