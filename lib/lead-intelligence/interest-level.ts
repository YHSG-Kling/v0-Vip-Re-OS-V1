/**
 * lib/lead-intelligence/interest-level.ts
 *
 * Pure mapping between the open_house_attendees.interest_level column
 * (stored as "hot" | "warm" | "cold", or sometimes a raw numeric string)
 * and the 1..5 interestLevel scale expected by
 * buildOpenHouseAttendeeSignal() / ingestOpenHouseAttendeeSignalAction().
 *
 * No side effects, no DB — safe to unit-test directly.
 */

export type InterestSignalScale = 1 | 2 | 3 | 4 | 5

const LABEL_TO_SCALE: Record<string, InterestSignalScale> = {
  hot: 5,
  warm: 3,
  cold: 1,
}

/**
 * Normalise a stored attendee interest_level into the 1..5 signal scale.
 *
 *   • "hot" / "warm" / "cold"   → 5 / 3 / 1
 *   • numeric (1..5, or string) → clamped into 1..5
 *   • null / unknown            → undefined (let the signal builder pick its
 *     own neutral default of 3)
 */
export function interestLevelToSignalScale(
  value: string | number | null | undefined,
): InterestSignalScale | undefined {
  if (value === null || value === undefined) return undefined

  if (typeof value === "number") return clampToScale(value)

  const trimmed = value.trim().toLowerCase()
  if (trimmed === "") return undefined

  if (trimmed in LABEL_TO_SCALE) return LABEL_TO_SCALE[trimmed]

  const numeric = Number(trimmed)
  if (Number.isFinite(numeric)) return clampToScale(numeric)

  return undefined
}

function clampToScale(n: number): InterestSignalScale {
  const rounded = Math.round(n)
  if (rounded <= 1) return 1
  if (rounded >= 5) return 5
  return rounded as InterestSignalScale
}
