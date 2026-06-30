// ─── CLOSING-OVERDUE POLICY (Deal Coordinator reaper) ────────────────────────
// Pure, import-free policy for the deal-level "this should have closed by now"
// failure mode: a transaction whose ESTIMATED CLOSE DATE has passed by a grace
// window while the deal is still in a non-terminal status. Distinct from the
// per-milestone deadline-monitor (inspection/appraisal/financing) — this is the
// WHOLE DEAL silently slipping past its close date with nobody flagging it.
//
// Pure so it's unit-testable (scripts/closing-overdue-reaper-simulator.ts).

// Terminal transaction statuses — a deal here is DONE (closed/dead), never overdue.
// Sourced from transaction-stages STAGE_TO_STATUS_MAP ('closed'|'lost') plus the
// cancellation vocabulary used by closing-orchestration ('cancelled'|'terminated').
export const TERMINAL_TXN_STATUSES = new Set<string>([
  "closed",
  "lost",
  "cancelled",
  "terminated",
  "withdrawn",
  "dead",
])

// How far past the estimated close date before we flag it (a few days of slack
// is normal in real closings; a week past with no terminal status is a problem).
export const CLOSING_OVERDUE_GRACE_DAYS = 7

export type OverdueClosingAction = "keep" | "escalate"

export interface OverdueClosingInput {
  status: string | null | undefined
  estimatedCloseDate: string | null | undefined
  /** Caller passes "now" so the policy stays deterministic/testable. */
  now: Date
}

export function classifyOverdueClosing(input: OverdueClosingInput): OverdueClosingAction {
  const status = (input.status ?? "").toLowerCase().trim()
  if (status && TERMINAL_TXN_STATUSES.has(status)) return "keep" // already done
  if (!input.estimatedCloseDate) return "keep" // no expected date → can't be "overdue"

  const due = Date.parse(input.estimatedCloseDate)
  if (Number.isNaN(due)) return "keep"

  const graceMs = CLOSING_OVERDUE_GRACE_DAYS * 24 * 60 * 60 * 1000
  return input.now.getTime() - due > graceMs ? "escalate" : "keep"
}

/** Whole days a deal is past its estimated close date (>=0; 0 if not past/unknown). */
export function daysOverdue(estimatedCloseDate: string | null | undefined, now: Date): number {
  if (!estimatedCloseDate) return 0
  const due = Date.parse(estimatedCloseDate)
  if (Number.isNaN(due)) return 0
  const ms = now.getTime() - due
  return ms > 0 ? Math.floor(ms / (24 * 60 * 60 * 1000)) : 0
}
