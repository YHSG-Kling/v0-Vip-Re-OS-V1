// lib/compliance/trid-disclosure-clock.ts
//
// TRID DISCLOSURE CLOCK — the FORWARD-LOOKING half of TRID compliance (the pure engine).
//
// THE GAP (verified — the system covers the other half): monitorTRIDComplianceService
// (lib/application/compliance-monitoring.ts) detects TRID violations POST-HOC — it computes
// whether the Loan Estimate / Closing Disclosure were delivered on time AFTER the dates are
// recorded, and writes a violation when it's already too late. The regulation's whole point
// is timing: the buyer must RECEIVE the Closing Disclosure at least 3 business days before
// consummation, or the closing must be delayed. Nothing watched the deadline COMING — so a
// deal could sail toward a closing date with the CD still undelivered and the first signal
// was a violation after the closing slipped. trid_timeline even has an `at_risk`
// compliance_status the post-hoc monitor never sets — this clock fills it.
//
// This module is PURE (no I/O): given today + the recorded TRID dates, it computes each
// disclosure's deadline with the SAME inclusive business-day convention as the existing
// post-hoc monitor (no drift), how many business days remain, and a forward status
// (ok/upcoming/at_risk/violation). The runner does the I/O and the gated escalation. HONEST:
// a deadline whose inputs aren't on file is `not_applicable`, never a fabricated countdown.

import { isFederalHoliday } from "./federal-holidays"

export interface TridClockInput {
  /** ISO date (yyyy-mm-dd) for "today" — injectable so the simulator is deterministic. */
  today: string
  loanApplicationDate?: string | null
  loanEstimateDeliveredDate?: string | null
  closingDisclosureDeliveredDate?: string | null
  scheduledCloseDate?: string | null
}

export type DeadlineStatus = "ok" | "upcoming" | "at_risk" | "violation" | "not_applicable"

export interface TridDeadline {
  kind: "loan_estimate" | "closing_disclosure"
  label: string
  /** the latest compliant delivery date (business-day computed), null when N/A */
  dueBy: string | null
  delivered: boolean
  /** business days from today until dueBy (negative = the deadline has passed) */
  businessDaysRemaining: number | null
  status: DeadlineStatus
  message: string
}

export interface TridClockResult {
  deadlines: TridDeadline[]
  overall: "ok" | "at_risk" | "violation" | "insufficient"
  /** at_risk or violation → escalate */
  flagged: boolean
}

// Within this many business days of an undelivered disclosure's deadline → at_risk.
// UN-EXPORTED (§1.1, 2026-08-31, lane M4): its only reader is the verdict
// function below; the behavior it tunes is proven by
// scripts/trid-disclosure-clock-simulator.ts through scenario dates, which
// never needed the raw number.
const WARN_BUSINESS_DAYS = 2
// TRID hard rules.
const LE_MAX_BUSINESS_DAYS = 3 // LE delivered within 3 business days of application
const CD_MIN_BUSINESS_DAYS = 3 // CD delivered at least 3 business days before close

function parse(d: string): Date {
  // Treat as a calendar date in UTC to avoid TZ drift.
  const [y, m, day] = d.split("-").map(Number)
  return new Date(Date.UTC(y, (m ?? 1) - 1, day ?? 1))
}
function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}
// A TRID business day excludes weekends AND federal holidays. Omitting the
// holidays under-counted the window across a holiday and could call a too-late
// Closing Disclosure "compliant" — a federal TRID violation. This conservative
// weekday+holiday convention never under-counts (it only ever requires the CD
// earlier), and the post-hoc monitor (compliance-monitoring) uses the same rule.
function isBusinessDay(d: Date): boolean {
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  return !isFederalHoliday(iso(d))
}

/** Inclusive business-day count between two dates — IDENTICAL convention to the existing
 *  getBusinessDays in compliance-monitoring (so the clock and the post-hoc monitor agree). */
export function businessDaysInclusive(startIso: string, endIso: string): number {
  const start = parse(startIso)
  const end = parse(endIso)
  if (end < start) return 0
  let count = 0
  const cur = new Date(start)
  while (cur <= end) {
    if (isBusinessDay(cur)) count++
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return count
}

/** Signed business days from `fromIso` to `toIso`, EXCLUDING the start day. Positive = the
 *  deadline is in the future; negative = it has passed; 0 = it's the next business boundary. */
export function businessDaysUntil(fromIso: string, toIso: string): number {
  const from = parse(fromIso)
  const to = parse(toIso)
  if (iso(from) === iso(to)) return 0
  const forward = to > from
  let count = 0
  const cur = new Date(forward ? from : to)
  const stop = forward ? to : from
  cur.setUTCDate(cur.getUTCDate() + 1)
  while (cur <= stop) {
    if (isBusinessDay(cur)) count++
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return forward ? count : -count
}

/** The latest date D such that businessDaysInclusive(D, closeIso) >= CD_MIN_BUSINESS_DAYS. */
export function closingDisclosureDueBy(closeIso: string): string {
  const close = parse(closeIso)
  const cur = new Date(close)
  // Walk backward until the inclusive window from cur..close reaches the minimum.
  while (businessDaysInclusive(iso(cur), closeIso) < CD_MIN_BUSINESS_DAYS) {
    cur.setUTCDate(cur.getUTCDate() - 1)
  }
  return iso(cur)
}

/** The latest date the Loan Estimate can be delivered: application + (3 business days). */
export function loanEstimateDueBy(applicationIso: string): string {
  const start = parse(applicationIso)
  const cur = new Date(start)
  // Advance until the inclusive window application..cur reaches the max allowed.
  while (businessDaysInclusive(applicationIso, iso(cur)) < LE_MAX_BUSINESS_DAYS) {
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return iso(cur)
}

function forwardStatus(args: { delivered: boolean; bdRemaining: number; deliveredCompliant: boolean | null }): DeadlineStatus {
  if (args.delivered) return args.deliveredCompliant === false ? "violation" : "ok"
  if (args.bdRemaining < 0) return "violation" // deadline passed, still undelivered
  if (args.bdRemaining <= WARN_BUSINESS_DAYS) return "at_risk"
  return "upcoming"
}

/** Compute the TRID disclosure clock. Pure. */
export function computeTridClock(input: TridClockInput): TridClockResult {
  const deadlines: TridDeadline[] = []

  // ── Closing Disclosure: must be delivered ≥3 business days before close ──
  if (input.scheduledCloseDate) {
    const dueBy = closingDisclosureDueBy(input.scheduledCloseDate)
    const delivered = !!input.closingDisclosureDeliveredDate
    const deliveredCompliant = delivered
      ? businessDaysInclusive(input.closingDisclosureDeliveredDate as string, input.scheduledCloseDate) >= CD_MIN_BUSINESS_DAYS
      : null
    const bdRemaining = businessDaysUntil(input.today, dueBy)
    const status = forwardStatus({ delivered, bdRemaining, deliveredCompliant })
    deadlines.push({
      kind: "closing_disclosure",
      label: "Closing Disclosure to buyer",
      dueBy,
      delivered,
      businessDaysRemaining: bdRemaining,
      status,
      message:
        status === "ok"
          ? `Closing Disclosure delivered with the required 3-business-day window before closing.`
          : status === "violation" && delivered
            ? `Closing Disclosure was delivered too close to closing — fewer than 3 business days before consummation. The closing date must move.`
            : status === "violation"
              ? `The Closing Disclosure deadline (${dueBy}) has passed and the CD is still not delivered — the ${input.scheduledCloseDate} closing cannot stand without a delay.`
              : status === "at_risk"
                ? `Closing Disclosure must reach the buyer by ${dueBy} (${bdRemaining} business day${bdRemaining === 1 ? "" : "s"} left) to protect the ${input.scheduledCloseDate} closing — it's not delivered yet.`
                : `Closing Disclosure due to the buyer by ${dueBy} to keep the ${input.scheduledCloseDate} closing on track.`,
    })
  } else {
    deadlines.push({
      kind: "closing_disclosure", label: "Closing Disclosure to buyer", dueBy: null, delivered: !!input.closingDisclosureDeliveredDate,
      businessDaysRemaining: null, status: "not_applicable", message: "No scheduled closing date on file — Closing Disclosure deadline can't be computed yet.",
    })
  }

  // ── Loan Estimate: must be delivered within 3 business days of application ──
  if (input.loanApplicationDate) {
    const dueBy = loanEstimateDueBy(input.loanApplicationDate)
    const delivered = !!input.loanEstimateDeliveredDate
    const deliveredCompliant = delivered
      ? businessDaysInclusive(input.loanApplicationDate, input.loanEstimateDeliveredDate as string) <= LE_MAX_BUSINESS_DAYS
      : null
    const bdRemaining = businessDaysUntil(input.today, dueBy)
    const status = forwardStatus({ delivered, bdRemaining, deliveredCompliant })
    deadlines.push({
      kind: "loan_estimate",
      label: "Loan Estimate to buyer",
      dueBy,
      delivered,
      businessDaysRemaining: bdRemaining,
      status,
      message:
        status === "ok"
          ? `Loan Estimate delivered within 3 business days of application.`
          : status === "violation" && delivered
            ? `Loan Estimate was delivered more than 3 business days after application.`
            : status === "violation"
              ? `The Loan Estimate deadline (${dueBy}) has passed and it's still not delivered.`
              : status === "at_risk"
                ? `Loan Estimate must reach the buyer by ${dueBy} (${bdRemaining} business day${bdRemaining === 1 ? "" : "s"} left) — it's not delivered yet.`
                : `Loan Estimate due to the buyer by ${dueBy}.`,
    })
  } else {
    deadlines.push({
      kind: "loan_estimate", label: "Loan Estimate to buyer", dueBy: null, delivered: !!input.loanEstimateDeliveredDate,
      businessDaysRemaining: null, status: "not_applicable", message: "No loan application date on file — Loan Estimate deadline can't be computed yet.",
    })
  }

  const anyApplicable = deadlines.some((d) => d.status !== "not_applicable")
  const hasViolation = deadlines.some((d) => d.status === "violation")
  const hasAtRisk = deadlines.some((d) => d.status === "at_risk")
  const overall: TridClockResult["overall"] = !anyApplicable
    ? "insufficient"
    : hasViolation
      ? "violation"
      : hasAtRisk
        ? "at_risk"
        : "ok"

  return { deadlines, overall, flagged: overall === "at_risk" || overall === "violation" }
}

/** The single most urgent deadline driving the verdict (for the alert copy). */
export function mostUrgentDeadline(result: TridClockResult): TridDeadline | null {
  const rank: Record<DeadlineStatus, number> = { violation: 0, at_risk: 1, upcoming: 2, ok: 3, not_applicable: 4 }
  const sorted = [...result.deadlines].sort((a, b) => rank[a.status] - rank[b.status])
  const top = sorted[0]
  return top && top.status !== "not_applicable" ? top : null
}
