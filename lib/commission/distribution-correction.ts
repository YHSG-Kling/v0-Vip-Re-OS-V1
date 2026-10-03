/**
 * lib/commission/distribution-correction.ts — PURE (no imports). The money math of a commission
 * CORRECTION (wave 98, owner: "yes build commission correction screen").
 *
 * m689 made a POSTED (status 'paid') commission_distributions entry append-only: it is never
 * edited. A correction is a NEW row (m690: entry_type 'reversal' | 'adjustment',
 * adjusts_distribution_id → the original, correction_reason) whose signed amount, summed with the
 * original and every earlier correction, gives the corrected net. Readers that sum
 * calculated_amount over the entry's rows therefore see the corrected figure with no special case.
 *
 * Deterministic: integer CENTS throughout, one rounding at the boundary.
 * Writer: lib/kernel/financial.ts correctCommissionDistribution (finance-admin gate, session tenant).
 */

export type DistributionCorrectionKind = "reversal" | "adjustment"

export interface CorrectableEntry {
  id: string
  status: string | null
  entry_type?: string | null
  calculated_amount: number | string | null
}

export type CorrectionPlan =
  | { ok: true; amount: number; netBefore: number; netAfter: number }
  | { ok: false; error: string }

const toCents = (v: number | string | null | undefined): number => {
  const n = typeof v === "string" ? Number(v) : (v ?? 0)
  return Number.isFinite(n) ? Math.round((n as number) * 100) : NaN
}
const fromCents = (c: number): number => c / 100

/** Minimum reason length — a correction without a stated why is not an audit trail. */
export const MIN_CORRECTION_REASON_LENGTH = 5

/**
 * Plan ONE correction row for a posted entry.
 *   reversal   → amount = −(current net): the entry nets to zero.
 *   adjustment → amount = corrected − current net: the entry nets to `correctedAmount`.
 * Refuses: an entry that is not posted (it is still editable in the posting lifecycle), a
 * correction row itself (correct the original), an empty reason, a non-finite / negative target,
 * and a no-op (zero delta, or reversing an entry already netting to zero).
 */
export function planDistributionCorrection(args: {
  original: CorrectableEntry
  priorCorrections: Array<{ calculated_amount: number | string | null }>
  kind: DistributionCorrectionKind
  correctedAmount?: number | null
  reason: string
}): CorrectionPlan {
  const { original, priorCorrections, kind } = args
  if (original.status !== "paid") {
    return { ok: false, error: "Only a POSTED (paid) entry is corrected with a new row — an unposted entry is still editable." }
  }
  if ((original.entry_type ?? "entry") !== "entry") {
    return { ok: false, error: "This row is itself a correction — correct the original entry instead." }
  }
  if (String(args.reason ?? "").trim().length < MIN_CORRECTION_REASON_LENGTH) {
    return { ok: false, error: `A reason of at least ${MIN_CORRECTION_REASON_LENGTH} characters is required.` }
  }
  const base = toCents(original.calculated_amount)
  const prior = priorCorrections.reduce((s, r) => s + toCents(r.calculated_amount), 0)
  if (!Number.isFinite(base) || !Number.isFinite(prior)) return { ok: false, error: "The entry's amounts are unreadable." }
  const netBefore = base + prior

  let delta: number
  if (kind === "reversal") {
    if (netBefore === 0) return { ok: false, error: "This entry already nets to zero — nothing to reverse." }
    delta = -netBefore
  } else if (kind === "adjustment") {
    const target = toCents(args.correctedAmount ?? NaN)
    if (!Number.isFinite(target) || target < 0) return { ok: false, error: "Enter the corrected amount (zero or more)." }
    delta = target - netBefore
    if (delta === 0) return { ok: false, error: "The corrected amount equals the current amount — nothing to adjust." }
  } else {
    return { ok: false, error: "Unknown correction kind." }
  }
  return { ok: true, amount: fromCents(delta), netBefore: fromCents(netBefore), netAfter: fromCents(netBefore + delta) }
}
