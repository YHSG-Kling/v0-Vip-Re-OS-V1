export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100)
}

export function centsToDollars(cents: number): number {
  return cents / 100
}

export function calculatePercentAmount(baseCents: number, percent: number): number {
  return Math.round(baseCents * (percent / 100))
}

export function validatePositive(value: number, fieldName: string): void {
  if (value <= 0) {
    throw new Error(`[commission-engine] ${fieldName} must be positive, got ${value}`)
  }
}
