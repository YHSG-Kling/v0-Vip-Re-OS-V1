/**
 * Convert dollars to cents (rounds to nearest cent)
 */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100)
}

/**
 * Convert cents to dollars
 */
export function centsToDollars(cents: number): number {
  return cents / 100
}

/**
 * Calculate percentage of amount in cents
 */
export function calculatePercentCents(amountCents: number, percent: number): number {
  return Math.round(amountCents * (percent / 100))
}

/**
 * Validate waterfall totals match within tolerance
 */
export function validateWaterfall(
  grossCents: number,
  distributedCents: number,
  toleranceCents: number = 1
): { valid: boolean; difference: number } {
  const difference = Math.abs(grossCents - distributedCents)
  return {
    valid: difference <= toleranceCents,
    difference
  }
}

/**
 * Sum array of cent values
 */
export function sumCents(values: number[]): number {
  return values.reduce((sum, val) => sum + val, 0)
}
