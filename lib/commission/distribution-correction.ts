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

// ─── SUMMARY RE-STAMP (wave 100, lane 100C — 98A open item / gap row 16) ──────────────────────────
// agent_commissions and transaction_commissions are NOT derived reads: they are rows the waterfall
// (lib/commission/waterfall/11-validate-persist.ts) and the deal recalculation (lib/kernel/
// transactions.ts) WRITE, with no trigger or view behind them (live pg_trigger, 2026-10-03: only
// commission_distribution_posted_is_append_only exists on the three tables). So a correction row left
// them stating the pre-correction figure. The waterfall writes EXACTLY ONE 'agent' distribution (the
// agent's final net → agent_commissions.net_to_agent) and ONE 'brokerage' distribution (→ net_to_brokerage)
// per commission, and a correction inherits the original's commission_id + distribution_type — so the
// summary is RE-DERIVED from the rows (original + every correction), never incremented: re-running it
// gives the same answer, and a lost write is healed by the next correction's re-stamp.

/** The distribution types that HAVE a summary column. fee / referral / residual / royalty /
 *  team_member corrections net in the distribution rows only (no summary column carries them). */
export const SUMMARIZED_DISTRIBUTION_TYPES = { agent: "net_to_agent", brokerage: "net_to_brokerage" } as const
export type SummarizedDistributionType = keyof typeof SUMMARIZED_DISTRIBUTION_TYPES

export function isSummarizedDistributionType(t: string | null | undefined): t is SummarizedDistributionType {
  return t === "agent" || t === "brokerage"
}

/** PURE — the summary figure for one distribution type: Σ calculated_amount over the rows of that type
 *  (original + its corrections), in cents, one rounding at the boundary. Rows of other types are ignored. */
export function summaryAmountFromDistributions(
  rows: ReadonlyArray<{ distribution_type: string | null; calculated_amount: number | string | null }>,
  type: SummarizedDistributionType,
): number {
  return fromCents(rows.filter((r) => r.distribution_type === type).reduce((s, r) => s + toCents(r.calculated_amount), 0))
}
