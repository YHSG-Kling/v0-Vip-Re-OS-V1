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
 * Writers: lib/kernel/financial.ts correctCommissionDistribution (finance-admin gate, session tenant) and,
 * for an UNPAID entry, voidCommissionDistribution (wave 105E — planDistributionVoid below is its rule).
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

/** ONE void predicate (wave 105, lane 105E — CLAUDE.md §6): status 'voided' is the signal every reader
 *  keys on (the CHECK vocabulary); `voided_at` / `voided_reason` are the stamps voidCommissionDistribution
 *  writes beside it. The re-stamp, the reconciler and the economic graph all exclude rows through THIS. */
export function isVoidedDistribution(r: { status?: string | null }): boolean {
  return (r.status ?? "").toLowerCase() === "voided"
}

/** PURE — the summary figure for one distribution type: Σ calculated_amount over the LIVE rows of that
 *  type (original + its corrections; a voided row carries no money — isVoidedDistribution), in cents, one
 *  rounding at the boundary. Rows of other types are ignored. A row with no `status` counts as live. */
export function summaryAmountFromDistributions(
  rows: ReadonlyArray<{ distribution_type: string | null; calculated_amount: number | string | null; status?: string | null }>,
  type: SummarizedDistributionType,
): number {
  return fromCents(rows.filter((r) => r.distribution_type === type && !isVoidedDistribution(r)).reduce((s, r) => s + toCents(r.calculated_amount), 0))
}

// ─── VOID (wave 105, lane 105E — owner ruling 1, 2026-10-06) ─────────────────────────────────────
// A void is for an entry whose money has NOT moved: status pending | approved, never posted (no
// paid_at), not already voided, and not the original of a POSTED correction. It stamps status 'voided'
// + voided_at + voided_reason on the SAME row (preserved — amounts untouched, never deleted) so every
// Σ-over-rows reader drops it through isVoidedDistribution. A PAID entry can NEVER be voided: m689 made
// it append-only and the money left at disbursement — it is corrected through a reversal / adjustment
// row (planDistributionCorrection), and that refusal is spelled ONCE here (VOID_REFUSED_PAID).
// Writer: lib/kernel/financial.ts voidCommissionDistribution (finance-admin gate, session tenant,
// withActionLedger FINANCIAL + COMMISSION_UPDATED event + summary re-stamp + reconciler).

/** A void reason is required and bounded — it is the audit trail's WHY, not an essay. */
export const MAX_VOID_REASON_LENGTH = 500

/** The one spelling of "a paid entry is not voided" (the UI shows it on posted rows, the kernel returns it). */
export const VOID_REFUSED_PAID = "paid distributions are corrected through reversal/adjustment"

/** The statuses a void may start from (commission_distributions.status vocabulary: approved | paid | pending | voided). */
export const VOIDABLE_STATUSES: ReadonlySet<string> = new Set(["pending", "approved"])

export interface VoidableEntry {
  id: string
  status: string | null
  entry_type?: string | null
  paid_at?: string | null
  voided_at?: string | null
}

export type VoidPlan =
  | { ok: true; reason: string }
  | { ok: false; error: string }

/**
 * PURE eligibility + reason rule for voiding ONE entry. `corrections` are the rows whose
 * adjusts_distribution_id names this entry: a POSTED one (status 'paid' or paid_at) means the entry is
 * already in the reversal/adjustment lifecycle and is refused the same way a paid entry is.
 * @proofSeam scripts/commission-set-in-stone-simulator.ts drives every refusal (paid, posted, voided,
 * corrected, no reason, over-long reason) and the one admit directly, before the kernel command.
 */
export function planDistributionVoid(args: {
  entry: VoidableEntry
  corrections: ReadonlyArray<{ status?: string | null; paid_at?: string | null }>
  reason: string
}): VoidPlan {
  const { entry } = args
  const status = (entry.status ?? "").toLowerCase()
  if (status === "paid" || entry.paid_at) return { ok: false, error: VOID_REFUSED_PAID }
  if (isVoidedDistribution(entry) || entry.voided_at) return { ok: false, error: "This entry is already voided." }
  if ((entry.entry_type ?? "entry") !== "entry") {
    return { ok: false, error: "A correction row is posted the moment it is written — it is itself corrected by a new row, never voided." }
  }
  if (!VOIDABLE_STATUSES.has(status)) return { ok: false, error: `An entry in status '${entry.status ?? "unknown"}' cannot be voided.` }
  if (args.corrections.some((c) => (c.status ?? "").toLowerCase() === "paid" || !!c.paid_at)) {
    return { ok: false, error: `This entry already carries a posted correction — ${VOID_REFUSED_PAID}` }
  }
  const reason = String(args.reason ?? "").trim()
  if (reason.length === 0) return { ok: false, error: "A reason is required to void an entry." }
  if (reason.length > MAX_VOID_REASON_LENGTH) return { ok: false, error: `The reason must be ${MAX_VOID_REASON_LENGTH} characters or fewer.` }
  return { ok: true, reason }
}
