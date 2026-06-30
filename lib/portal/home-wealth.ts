// ─── HOME WEALTH STORY ───────────────────────────────────────────────────────
// Pure, import-free math behind the lifetime portal's "home wealth story" — the
// realized journey from purchase price → today's estimated value. Realized /
// historical only: no forward forecast, projection, or guarantee (compliance).
//
// This module has NO imports so it stays trivially unit-testable
// (scripts/home-wealth-simulator.ts) and safe to use on the client.

export interface HomeValuePoint {
  estimated_value_mid: number
  estimated_value_low?: number | null
  estimated_value_high?: number | null
  generated_at?: string | null
}

export interface HomeWealthStory {
  hasEstimate: boolean
  /** Most recent estimated mid value. */
  currentValue: number
  purchasePrice: number
  /** currentValue - purchasePrice. Gross change in value, not net of mortgage. */
  estimatedEquity: number
  equityLow: number
  equityHigh: number
  /** Same as estimatedEquity, named for the "you've gained $X" framing. */
  gainAbsolute: number
  /** gainAbsolute / purchasePrice * 100. 0 when purchasePrice is unknown. */
  gainPercent: number
  /** Whole years between purchase and the latest estimate, when derivable. */
  yearsHeld: number | null
  /** Historical compound annual growth rate %, when yearsHeld >= 1. Null otherwise. */
  annualizedPercent: number | null
  isGain: boolean
  /**
   * Points for the living curve, oldest → newest, always anchored by the
   * purchase price as the first point. Each y is normalized 0..1 across the
   * series for a dependency-free sparkline.
   */
  curve: { value: number; y: number; at: string | null; isPurchase: boolean }[]
}

export interface HomeWealthInput {
  purchasePrice?: number | null
  closeDate?: string | null
  /** Latest estimate (used when no series is supplied). */
  estimatedValueMid?: number | null
  estimatedValueLow?: number | null
  estimatedValueHigh?: number | null
  latestGeneratedAt?: string | null
  /** Optional value series oldest → newest. */
  series?: HomeValuePoint[]
}

function yearsBetween(fromIso: string | null | undefined, toIso: string | null | undefined): number | null {
  if (!fromIso) return null
  const from = Date.parse(fromIso)
  const to = toIso ? Date.parse(toIso) : NaN
  if (Number.isNaN(from)) return null
  // Caller passes latestGeneratedAt as `to`; if missing we cannot anchor "today"
  // deterministically (Date.now is non-deterministic), so we require it.
  if (Number.isNaN(to)) return null
  const ms = to - from
  if (ms <= 0) return 0
  return ms / (365.25 * 24 * 60 * 60 * 1000)
}

export function computeHomeWealthStory(input: HomeWealthInput): HomeWealthStory {
  const series = (input.series ?? []).filter(
    (p) => typeof p.estimated_value_mid === "number" && p.estimated_value_mid > 0,
  )
  const latest = series.length > 0 ? series[series.length - 1] : null

  const currentValue = latest?.estimated_value_mid ?? input.estimatedValueMid ?? 0
  const currentLow = latest?.estimated_value_low ?? input.estimatedValueLow ?? null
  const currentHigh = latest?.estimated_value_high ?? input.estimatedValueHigh ?? null
  const latestAt = latest?.generated_at ?? input.latestGeneratedAt ?? null
  const purchasePrice = input.purchasePrice && input.purchasePrice > 0 ? input.purchasePrice : 0

  const hasEstimate = currentValue > 0

  if (!hasEstimate) {
    return {
      hasEstimate: false,
      currentValue: 0,
      purchasePrice,
      estimatedEquity: 0,
      equityLow: 0,
      equityHigh: 0,
      gainAbsolute: 0,
      gainPercent: 0,
      yearsHeld: null,
      annualizedPercent: null,
      isGain: false,
      curve: [],
    }
  }

  const estimatedEquity = currentValue - purchasePrice
  const equityLow = (currentLow ?? currentValue * 0.95) - purchasePrice
  const equityHigh = (currentHigh ?? currentValue * 1.05) - purchasePrice
  const gainAbsolute = estimatedEquity
  const gainPercent = purchasePrice > 0 ? (gainAbsolute / purchasePrice) * 100 : 0

  const yearsHeld = yearsBetween(input.closeDate, latestAt)
  let annualizedPercent: number | null = null
  if (yearsHeld !== null && yearsHeld >= 1 && purchasePrice > 0 && currentValue > 0) {
    annualizedPercent = (Math.pow(currentValue / purchasePrice, 1 / yearsHeld) - 1) * 100
  }

  // Build the curve anchored by purchase price, then each estimate in the series.
  const rawPoints: { value: number; at: string | null; isPurchase: boolean }[] = []
  if (purchasePrice > 0) {
    rawPoints.push({ value: purchasePrice, at: input.closeDate ?? null, isPurchase: true })
  }
  if (series.length > 0) {
    for (const p of series) {
      rawPoints.push({ value: p.estimated_value_mid, at: p.generated_at ?? null, isPurchase: false })
    }
  } else {
    rawPoints.push({ value: currentValue, at: latestAt, isPurchase: false })
  }

  const values = rawPoints.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const curve = rawPoints.map((p) => ({
    value: p.value,
    y: span > 0 ? (p.value - min) / span : 0.5,
    at: p.at,
    isPurchase: p.isPurchase,
  }))

  return {
    hasEstimate: true,
    currentValue,
    purchasePrice,
    estimatedEquity,
    equityLow,
    equityHigh,
    gainAbsolute,
    gainPercent,
    yearsHeld: yearsHeld === null ? null : Math.floor(yearsHeld),
    annualizedPercent,
    isGain: gainAbsolute >= 0,
    curve,
  }
}
