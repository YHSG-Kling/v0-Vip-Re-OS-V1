// ─── COMMISSION-LEAK POLICY (Finance Manager reaper) ─────────────────────────
// Pure, import-free policy for the money-leak failure: a deal that CLOSED but has
// no commission recorded. The commission engine (lib/commission) is triggered on
// close, but stage-progression deliberately does NOT block the close if the calc
// fails (so the deal can close even when commission persistence errored) — leaving
// a closed transaction with no row in the canonical `commissions` table. That's
// real revenue the brokerage may never reconcile. This policy decides when a
// commission-less closed deal is past the reconciliation grace and must escalate.
//
// Pure → unit-testable (scripts/commission-leak-reaper-simulator.ts).

// The commission calc runs synchronously on close; a couple of days of slack
// covers manual reconciliation before we flag a genuine miss.
export const COMMISSION_LEAK_GRACE_DAYS = 2

export type CommissionLeakAction = "keep" | "escalate"

export interface CommissionLeakInput {
  /** transactions.status — only a CLOSED deal can leak commission. */
  status: string | null | undefined
  /** transactions.close_date. */
  closeDate: string | null | undefined
  /** Whether a canonical `commissions` row exists for this transaction. */
  hasCommissionRow: boolean
  /** Caller passes "now" so the policy stays deterministic/testable. */
  now: Date
}

export function classifyCommissionLeak(input: CommissionLeakInput): CommissionLeakAction {
  const status = (input.status ?? "").toLowerCase().trim()
  if (status !== "closed") return "keep" // only closed deals owe a commission record
  if (input.hasCommissionRow) return "keep" // commission was recorded — no leak
  if (!input.closeDate) return "keep" // closed but no date → can't age it; don't guess

  const closed = Date.parse(input.closeDate)
  if (Number.isNaN(closed)) return "keep"

  const graceMs = COMMISSION_LEAK_GRACE_DAYS * 24 * 60 * 60 * 1000
  return input.now.getTime() - closed > graceMs ? "escalate" : "keep"
}
