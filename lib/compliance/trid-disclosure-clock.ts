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
// disclosure's deadline, how many business days remain, and a forward status
// (ok/upcoming/at_risk/violation). The runner does the I/O and the gated escalation. HONEST:
// a deadline whose inputs aren't on file is `not_applicable`, never a fabricated countdown.
//
// WAVE 153 (lane 153C) — THE CLOSING DISCLOSURE CLOCK STARTS AT RECEIPT, ON THE PRECISE CALENDAR (CORRECTED).
// Owner (verbatim, 2026-11-14): "trid is determined from the lender because the lender sends the final cd to the buyer to sign
// and should mark when trid starts and if lender isn't on the platform, the agent needs to find out from the lender and then
// mark the timeline (a good coaching moment)". The CD half of this clock was a day early in two ways, both measured against the
// rule text (CFPB, 12 CFR 1026.19(f)) rather than reasoned about:
//   1. It counted the RECEIPT DAY ITSELF ("inclusive ≥ 3"), so a CD received Monday cleared a WEDNESDAY closing. The rule is
//      receipt "no later than three business days before consummation" and "consummation may occur any time on the third
//      business day following" (comment 19(f)(1)(iii)-1; comment 19(f)(2)(i)-1: received Monday, consummation Thursday).
//   2. It used the GENERAL business day (Mon–Fri) and the OBSERVED holiday calendar. The CD waiting period and the deemed-receipt
//      rule use the PRECISE definition (1026.2(a)(6)): every calendar day except Sundays and the 5 U.S.C. 6103(a) holidays —
//      Saturdays COUNT, and when a fixed-date holiday falls on a Saturday the observed Friday IS a business day (comment
//      2(a)(6)-2). The commentary is silent on a Sunday holiday observed Monday; that Monday is treated as NOT a business day
//      (the later, safe answer — published as a blind spot, the lender confirms).
// And a third, the owner's own point: a date somebody TYPED is not receipt. Receipt is the consumer's event — in person, a
// consumer acknowledgment of receipt, the lender's own receipt evidence, or the mailbox rule (not in person → received three
// business days after delivery or mailing, 1026.19(f)(1)(iii)). A signature is NOT a universal substitute for receipt, so an
// acknowledgment signature is stored beside the evidence and never read as receipt unless the lender names it as its evidence.
// The Loan Estimate half is unchanged (the general business day; `businessDaysInclusive` keeps its convention and its importer).
// This is workflow logic beside the lender's own compliance, never legal advice or a replacement for the lender's authority.

import { isFederalHoliday } from "./federal-holidays"

export interface TridClockInput {
  /** ISO date (yyyy-mm-dd) for "today" — injectable so the simulator is deterministic. */
  today: string
  loanApplicationDate?: string | null
  loanEstimateDeliveredDate?: string | null
  /**
   * The Closing Disclosure's EFFECTIVE RECEIPT date (yyyy-mm-dd) — read from trid_timeline.closing_disclosure_delivered_date,
   * whose ONLY writer since wave 153 is the receipt ledger (lib/compliance/trid-disclosure-clock-evidence.ts), which mirrors the
   * lender-verified actual or deemed receipt there and nothing else. The column name is legacy; its meaning is receipt.
   */
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

// ── THE PRECISE ("SPECIFIC") BUSINESS DAY — 12 CFR 1026.2(a)(6) ────────────────────────────────────────────────────────
// Used for the Closing Disclosure waiting period (1026.19(f)(1)(ii)) and the deemed-receipt rule (1026.19(f)(1)(iii)).

/** The 5 U.S.C. 6103(a) holidays identified by a SPECIFIC DATE (month-day). Juneteenth only from 2021. */
const SPECIFIC_DATE_HOLIDAYS = ["01-01", "06-19", "07-04", "11-11", "12-25"] as const

function addDaysIso(d: string, n: number): string {
  const x = parse(d)
  x.setUTCDate(x.getUTCDate() + n)
  return iso(x)
}
function isSpecificDateHoliday(d: string): boolean {
  const md = d.slice(5)
  if (md === "06-19" && Number(d.slice(0, 4)) < 2021) return false
  return (SPECIFIC_DATE_HOLIDAYS as readonly string[]).includes(md)
}
/** A weekday that is a holiday only because a fixed-date holiday fell on the adjacent weekend day (the OBSERVED day). */
function isObservedShiftDay(d: string): boolean {
  const dow = parse(d).getUTCDay()
  return (dow === 5 && isSpecificDateHoliday(addDaysIso(d, 1))) || (dow === 1 && isSpecificDateHoliday(addDaysIso(d, -1)))
}
function isPreciseBusinessDay(d: string): boolean {
  const dow = parse(d).getUTCDay()
  if (dow === 0) return false // Sundays
  if (isSpecificDateHoliday(d)) return false // the holiday's own date, even a Saturday (July 4 on a Saturday)
  // The floating holidays (MLK, Washington's Birthday, Memorial, Labor, Columbus, Thanksgiving) never land on a weekend and are
  // read off the ONE holiday calendar; an observed-shift weekday is NOT one of them.
  if (isFederalHoliday(d) && !isObservedShiftDay(d)) return false
  // A Sunday fixed-date holiday observed on Monday: the commentary is silent — the SAFE answer (not a business day).
  if (dow === 1 && isSpecificDateHoliday(addDaysIso(d, -1))) return false
  // Saturdays, and the Friday observed for a Saturday holiday (comment 2(a)(6)-2), ARE business days.
  return true
}
/** The Nth precise business day AFTER `fromIso` (the start day itself never counts). */
function nthPreciseBusinessDayAfter(fromIso: string, n: number): string {
  let cur = fromIso
  let counted = 0
  while (counted < n) {
    cur = addDaysIso(cur, 1)
    if (isPreciseBusinessDay(cur)) counted++
  }
  return cur
}

/**
 * The EARLIEST CONSUMMATION DATE for a Closing Disclosure the consumer received on `receiptIso`: the third precise business day
 * following receipt ("consummation may occur any time on the third business day following" — comment 19(f)(1)(iii)-1).
 * Received Monday → Thursday; received Thursday → Monday (Saturday counts, Sunday does not).
 */
export function earliestConsummationDate(receiptIso: string): string {
  return nthPreciseBusinessDayAfter(receiptIso.slice(0, 10), CD_MIN_BUSINESS_DAYS)
}

/** The latest RECEIPT date that still allows consummation on `closeIso` (receipt at least three business days before). */
export function closingDisclosureDueBy(closeIso: string): string {
  let cur = addDaysIso(closeIso, -1)
  // earliestConsummationDate is monotone in the receipt date — walk back until the receipt clears the close.
  while (earliestConsummationDate(cur) > closeIso) cur = addDaysIso(cur, -1)
  return cur
}

/** HOW the Closing Disclosure reached the consumer (one vocabulary — trid_disclosure_receipts.delivery_method, m905). */
export const TRID_DELIVERY_METHODS = ["in_person", "mail", "email", "electronic_portal", "courier", "fax", "other"] as const

/**
 * WHAT proves receipt (trid_disclosure_receipts.receipt_evidence, m905). `mailbox_rule` = no evidence of an actual receipt
 * date — receipt is DEEMED three business days after delivery or mailing. A signature request is deliberately NOT a value: a
 * signed CD is evidence only when the lender itself names it as its receipt evidence (`consumer_acknowledged_receipt`).
 */
export const TRID_RECEIPT_EVIDENCE = ["in_person_delivery", "consumer_acknowledged_receipt", "lender_esign_receipt", "lender_statement", "mailbox_rule"] as const
type TridReceiptEvidence = (typeof TRID_RECEIPT_EVIDENCE)[number]

/**
 * PURE — the effective receipt date: actual receipt evidence when the lender states it, delivery day when handed over in
 * person, otherwise DEEMED three precise business days after delivery or mailing (1026.19(f)(1)(iii); comment 19(f)(1)(iii)-2:
 * emailed Monday → received Thursday). Null when neither a receipt nor a delivery date is on file — never a guessed date.
 */
export function effectiveReceiptDate(e: {
  deliveryMethod: string | null
  deliveredOn: string | null
  receivedOn: string | null
  evidence: string | null
}): { date: string | null; basis: "actual_receipt" | "in_person" | "deemed_mailbox_rule" | "none" } {
  const inPerson = e.deliveryMethod === "in_person" || e.evidence === "in_person_delivery"
  if (inPerson) {
    const d = e.receivedOn ?? e.deliveredOn
    return d ? { date: d.slice(0, 10), basis: "in_person" } : { date: null, basis: "none" }
  }
  const actual: TridReceiptEvidence[] = ["consumer_acknowledged_receipt", "lender_esign_receipt", "lender_statement"]
  if (e.receivedOn && actual.includes(e.evidence as TridReceiptEvidence)) return { date: e.receivedOn.slice(0, 10), basis: "actual_receipt" }
  if (e.deliveredOn) return { date: nthPreciseBusinessDayAfter(e.deliveredOn.slice(0, 10), 3), basis: "deemed_mailbox_rule" }
  return { date: null, basis: "none" }
}

/** PURE — the consumer's LOCAL calendar day for a receipt instant in an IANA time zone. Null on an unreadable instant or zone. */
export function localReceiptDay(instant: string, timeZone: string): string | null {
  const t = Date.parse(instant)
  if (Number.isNaN(t)) return null
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(t))
    const get = (k: string) => parts.find((p) => p.type === k)?.value
    const y = get("year"), m = get("month"), d = get("day")
    return y && m && d ? `${y}-${m}-${d}` : null
  } catch {
    return null
  }
}

/** PURE — the inverse: a wall-clock time ("2026-06-15T14:30", a datetime-local value) in an IANA zone → an ISO instant. Two
 *  passes settle a daylight-saving boundary. Null on an unreadable value or zone. Read by the receipt forms (agent and lender). */
export function zonedWallTimeToInstant(wall: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(wall)
  if (!m) return null
  const target = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  try {
    const offsetAt = (t: number) => {
      const p = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(t))
      const g = (k: string) => Number(p.find((x) => x.type === k)?.value)
      return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - t
    }
    let t = target - offsetAt(target)
    t = target - offsetAt(t)
    return new Date(t).toISOString()
  } catch {
    return null
  }
}

/**
 * PURE — does a revised Closing Disclosure's APR make the earlier disclosed APR INACCURATE (1026.19(f)(2)(ii)(A) → 1026.22)?
 * The tolerance is 1/8 of a percentage point for a REGULAR transaction and 1/4 for an IRREGULAR one (1026.22(a)(2)–(3)), and
 * ONLY THE LENDER says which this loan is. So: within 1/8 is inside both; a rise beyond 1/4 is outside both (still the lender's
 * to confirm); anything between, or a DECREASE beyond 1/8 (which can still be accurate, 1026.22(a)(4)), is the lender's call.
 * Never a hard-coded single band, never a reconstructed APR. The ONE rule — tridRevisionAssessment (cda-closing-policy.ts) and
 * assessTridReadiness below both read it.
 */
export function aprRevisionVerdict(input: { previous: number | null; current: number | null; regularity: string | null }): {
  verdict: "unknown" | "within_tolerance" | "beyond_tolerance" | "lender_must_classify" | "decrease_lender_review"
  basis: "not_stated" | "within_both" | "beyond_both" | "lender_classified" | "lender_review"
  delta: number | null
  detail: string
} {
  if (input.previous == null || input.current == null || !Number.isFinite(input.previous) || !Number.isFinite(input.current)) {
    return { verdict: "unknown", basis: "not_stated", delta: null, detail: "the APR is not stated on both Closing Disclosures" }
  }
  const delta = Math.round((input.current - input.previous) * 1000) / 1000
  const abs = Math.abs(delta)
  if (abs <= 0.125) return { verdict: "within_tolerance", basis: "within_both", delta, detail: "the APR moved within 1/8 of a point — inside both tolerances" }
  if (delta < 0) return { verdict: "decrease_lender_review", basis: "lender_review", delta, detail: "the APR fell more than 1/8 of a point — it can still be accurate when the finance charge was overstated (12 CFR 1026.22(a)(4)); the lender confirms" }
  const tolerance = input.regularity === "irregular" ? 0.25 : input.regularity === "regular" ? 0.125 : null
  if (tolerance != null) {
    return delta > tolerance
      ? { verdict: "beyond_tolerance", basis: "lender_classified", delta, detail: `the APR rose ${delta} points — beyond the ${input.regularity === "irregular" ? "1/4-point (irregular)" : "1/8-point (regular)"} tolerance the lender stated` }
      : { verdict: "within_tolerance", basis: "lender_classified", delta, detail: `the APR rose ${delta} points — within the 1/4-point tolerance for the irregular transaction the lender stated` }
  }
  if (delta > 0.25) return { verdict: "beyond_tolerance", basis: "beyond_both", delta, detail: `the APR rose ${delta} points — beyond both the 1/8-point (regular) and 1/4-point (irregular) tolerances; the lender confirms` }
  return { verdict: "lender_must_classify", basis: "lender_review", delta, detail: `the APR rose ${delta} points — accurate only if the lender classifies the loan as an irregular transaction` }
}

/** The latest date the Loan Estimate can be delivered: application + (3 business days). */
function loanEstimateDueBy(applicationIso: string): string {
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

  // ── Closing Disclosure: must be RECEIVED ≥3 precise business days before consummation (wave 153: receipt-based) ──
  if (input.scheduledCloseDate) {
    const dueBy = closingDisclosureDueBy(input.scheduledCloseDate)
    const delivered = !!input.closingDisclosureDeliveredDate
    const deliveredCompliant = delivered
      ? earliestConsummationDate(input.closingDisclosureDeliveredDate as string) <= input.scheduledCloseDate
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
          ? `The buyer received the Closing Disclosure on ${input.closingDisclosureDeliveredDate}; the earliest closing day is ${earliestConsummationDate(input.closingDisclosureDeliveredDate as string)}.`
          : status === "violation" && delivered
            ? `The buyer received the Closing Disclosure on ${input.closingDisclosureDeliveredDate}, so the earliest closing day is ${earliestConsummationDate(input.closingDisclosureDeliveredDate as string)} — later than ${input.scheduledCloseDate}. The closing date must move.`
            : status === "violation"
              ? `The buyer had to receive the Closing Disclosure by ${dueBy} and no receipt is on file — the ${input.scheduledCloseDate} closing cannot stand without a delay.`
              : status === "at_risk"
                ? `The buyer must receive the Closing Disclosure by ${dueBy} (${bdRemaining} business day${bdRemaining === 1 ? "" : "s"} left) to protect the ${input.scheduledCloseDate} closing — no receipt is on file yet.`
                : `The buyer must receive the Closing Disclosure by ${dueBy} to keep the ${input.scheduledCloseDate} closing on track.`,
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

// ── TRID READINESS FROM THE RECEIPT LEDGER (wave 153, lane 153C) ──────────────────────────────────────────────────────
// The vocabularies below are the ONE source of the m905 CHECKs on public.trid_disclosure_receipts (CLAUDE.md §6): the
// migration states the same literals, the guard holds them equal.

/** WHO recorded the row. `agent_reported` / `tc_reported` are a statement the lender has not confirmed — never a started clock. */
export const TRID_RECEIPT_SOURCES = ["lender_portal", "agent_reported", "tc_reported", "compliance_verified"] as const
/** The row's standing. Only `lender_confirmed` can start the waiting period. */
export const TRID_VERIFICATION_STATUSES = ["lender_confirmed", "pending_lender_confirmation", "rejected"] as const
/** The lender's classification for the APR tolerance (1026.22(a)(2)–(3)). */
export const TRID_TRANSACTION_REGULARITY = ["regular", "irregular"] as const
/** The lender's own determination for a revision the documents cannot settle. */
export const TRID_NEW_WAIT_DETERMINATIONS = ["new_wait_required", "no_new_wait"] as const
/** Who sent the disclosure — the creditor keeps responsibility even when a settlement agent delivers it (1026.19(f)(1)(v)). */
export const TRID_SENDER_ROLES = ["creditor", "settlement_agent"] as const
/** What a REVISED Closing Disclosure changed (trid_disclosure_receipts.revision_changes; empty on the initial disclosure). */
export const TRID_REVISION_CHANGES = ["apr_changed", "loan_product_changed", "prepayment_penalty_added", "other_terms"] as const

/** The coaching task an agent / TC receives when the lender is not on the platform (directive §153C C2, verbatim intent). */
export const TRID_LENDER_COACHING =
  "Confirm with the lender when the buyer received the initial Closing Disclosure, whether the delivery/receipt evidence is confirmed and whether any revised disclosure restarts the waiting period."

/** One row of the receipt ledger, as the readiness rule reads it. */
export interface TridReceiptRecord {
  id: string
  version: number
  supersedesId: string | null
  verification: string
  source: string
  deliveryMethod: string | null
  deliveredOn: string | null
  receivedOn: string | null
  evidence: string | null
  revisionChanges: string[]
  aprPrevious: number | null
  aprCurrent: number | null
  regularity: string | null
  lenderNewWaitDetermination: string | null
  issuerName: string | null
  createdAt: string
}

type TridReadinessState =
  | "not_applicable" | "undetermined" | "awaiting_disclosure" | "draft_only" | "pending_lender_confirmation"
  | "escalated_to_lender" | "closing_before_earliest_date" | "waiting_period_running" | "ready"

export interface TridReadiness {
  applicable: boolean
  state: TridReadinessState
  /** Consummation may happen TODAY — the close gate's question. Never true on a pending report or an escalated revision. */
  readyToConsummateToday: boolean
  /** The scheduled close is on or after the earliest consummation date (null = no close date or no governing receipt). */
  onTrackForScheduledClose: boolean | null
  /** The receipt the waiting period runs from (the initial CD, or the latest revision that restarted it). */
  governing: { id: string; version: number; effectiveReceiptDate: string; earliestConsummationDate: string; basis: string; issuerName: string | null } | null
  /** The newest statement the lender has not confirmed (shown, never counted). */
  reportedPending: { id: string; version: number; reportedReceiptDate: string | null } | null
  /** Set when the lender is not on the platform and the agent / TC must ask it. */
  coaching: string | null
  reasons: string[]
  nextAction: string
}

/** PURE — does a confirmed REVISED disclosure restart the three-business-day wait (1026.19(f)(2)(ii)) or not ((f)(2)(i))? */
function revisionRestartsWait(r: TridReceiptRecord): { decision: "restart" | "no_restart" | "escalate"; why: string } {
  const changes = new Set(r.revisionChanges)
  if (changes.has("loan_product_changed")) return { decision: "restart", why: "the loan product changed" }
  if (changes.has("prepayment_penalty_added")) return { decision: "restart", why: "a prepayment penalty was added" }
  if (changes.has("apr_changed")) {
    const apr = aprRevisionVerdict({ previous: r.aprPrevious, current: r.aprCurrent, regularity: r.regularity })
    if (apr.verdict === "beyond_tolerance") return { decision: "restart", why: apr.detail }
    if (apr.verdict !== "within_tolerance") {
      // The lender's determination settles ONLY what the documents cannot — never a documented trigger above.
      if (r.lenderNewWaitDetermination === "new_wait_required") return { decision: "restart", why: "the lender determined a new waiting period applies" }
      if (r.lenderNewWaitDetermination === "no_new_wait") return { decision: "no_restart", why: "the lender determined no new waiting period applies" }
      return { decision: "escalate", why: apr.detail }
    }
  }
  if (r.lenderNewWaitDetermination === "new_wait_required") return { decision: "restart", why: "the lender determined a new waiting period applies" }
  return { decision: "no_restart", why: "the revision changes no APR beyond tolerance, no loan product and adds no prepayment penalty — a corrected disclosure at or before closing, no new wait" }
}

/**
 * PURE — TRID readiness from the receipt ledger. The waiting period runs from the LENDER-CONFIRMED receipt of the initial
 * Closing Disclosure, or of the latest confirmed revision that restarts it; an agent's report waits for the lender; a CD that
 * was only uploaded starts nothing; a cash closing is not a TRID closing (the settlement statement governs). Never a TRID-ready
 * built from a guess: every state that is not `ready` / `not_applicable` refuses the close.
 */
export function assessTridReadiness(input: {
  financing: "cash" | "financed" | null
  tridTracked: boolean
  today: string
  scheduledCloseDate: string | null
  receipts: TridReceiptRecord[]
  draftOnFile: boolean
  lenderOnPlatform: boolean
}): TridReadiness {
  const base = { governing: null, reportedPending: null, coaching: null, onTrackForScheduledClose: null } as const
  const receipts = input.receipts ?? []
  if (!input.tridTracked && receipts.length === 0 && input.financing === "cash") {
    return { ...base, applicable: false, state: "not_applicable", readyToConsummateToday: true, reasons: ["Cash closing: the settlement statement is the record — no Closing Disclosure waiting period applies."], nextAction: "Nothing to do for TRID on a cash closing." }
  }
  if (!input.tridTracked && receipts.length === 0 && input.financing == null) {
    return { ...base, applicable: true, state: "undetermined", readyToConsummateToday: false, reasons: ["The financing type is not on file, so whether a lender's Closing Disclosure applies is not known."], nextAction: "Record whether the purchase is financed or cash." }
  }
  const coaching = input.lenderOnPlatform ? null : TRID_LENDER_COACHING
  const supersededIds = new Set(receipts.map((r) => r.supersedesId).filter((x): x is string => !!x))
  const active = receipts.filter((r) => r.verification !== "rejected" && !supersededIds.has(r.id))
  const byNewest = (a: TridReceiptRecord, b: TridReceiptRecord) => (b.version - a.version) || (b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : 0)
  const confirmed = active.filter((r) => r.verification === "lender_confirmed")
  const pending = active.filter((r) => r.verification === "pending_lender_confirmation").sort(byNewest)
  const reportedPending = pending[0]
    ? { id: pending[0].id, version: pending[0].version, reportedReceiptDate: effectiveReceiptDate(pending[0]).date }
    : null

  if (confirmed.length === 0) {
    if (reportedPending) {
      return {
        ...base, applicable: true, state: "pending_lender_confirmation", readyToConsummateToday: false, reportedPending, coaching,
        reasons: ["A receipt date was reported for the Closing Disclosure, and the lender has not confirmed it. A reported date does not start the waiting period."],
        nextAction: input.lenderOnPlatform ? "Ask the lender to confirm the receipt on its loan file." : "Get the lender's written confirmation of the receipt and have compliance or a broker verify it.",
      }
    }
    if (input.draftOnFile) {
      return { ...base, applicable: true, state: "draft_only", readyToConsummateToday: false, coaching, reasons: ["A Closing Disclosure is uploaded, but no delivery to the buyer or receipt is recorded. An upload does not start the waiting period."], nextAction: input.lenderOnPlatform ? "The lender records when the buyer received it." : "Ask the lender when the buyer received it and record what the lender says." }
    }
    return { ...base, applicable: true, state: "awaiting_disclosure", readyToConsummateToday: false, coaching, reasons: ["No receipt of the Closing Disclosure by the buyer is on file."], nextAction: input.lenderOnPlatform ? "The lender records the delivery and the buyer's receipt." : "Ask the lender when the buyer received the Closing Disclosure and record what the lender says." }
  }

  // The newest confirmed row of each version, oldest version first.
  const perVersion = new Map<number, TridReceiptRecord>()
  for (const r of [...confirmed].sort(byNewest)) if (!perVersion.has(r.version)) perVersion.set(r.version, r)
  const chain = [...perVersion.values()].sort((a, b) => a.version - b.version)
  let governing = chain[0]
  let escalated: { r: TridReceiptRecord; why: string } | null = null
  const reasons: string[] = []
  for (const r of chain.slice(1)) {
    const d = revisionRestartsWait(r)
    if (d.decision === "restart") { governing = r; reasons.push(`Revised Closing Disclosure (version ${r.version}): ${d.why} — a new three-business-day waiting period runs from its receipt.`) }
    else if (d.decision === "escalate") { escalated = { r, why: d.why }; break }
    else reasons.push(`Revised Closing Disclosure (version ${r.version}): ${d.why}.`)
  }
  const latestConfirmedVersion = chain[chain.length - 1].version
  const pendingRevision = pending.find((p) => p.version > latestConfirmedVersion) ?? null

  const eff = effectiveReceiptDate(governing)
  if (!eff.date) {
    return { ...base, applicable: true, state: "awaiting_disclosure", readyToConsummateToday: false, reportedPending, coaching, reasons: [...reasons, "The confirmed record has neither a receipt date nor a delivery date, so the waiting period cannot start."], nextAction: "The lender records when the Closing Disclosure was delivered and received." }
  }
  const earliest = earliestConsummationDate(eff.date)
  const gov = { id: governing.id, version: governing.version, effectiveReceiptDate: eff.date, earliestConsummationDate: earliest, basis: eff.basis, issuerName: governing.issuerName }
  const onTrack = input.scheduledCloseDate ? input.scheduledCloseDate.slice(0, 10) >= earliest : null
  const waitOver = input.today >= earliest
  reasons.unshift(`The buyer's receipt of the Closing Disclosure (version ${governing.version}) is ${eff.basis === "deemed_mailbox_rule" ? "deemed" : "confirmed"} for ${eff.date}; the earliest closing day is ${earliest}.`)

  if (escalated) {
    return { ...base, applicable: true, state: "escalated_to_lender", readyToConsummateToday: false, governing: gov, reportedPending, onTrackForScheduledClose: onTrack, coaching,
      reasons: [...reasons, `Revised Closing Disclosure (version ${escalated.r.version}): whether it restarts the waiting period cannot be decided from the record — ${escalated.why}.`],
      nextAction: "The lender states whether this revision requires a new three-business-day waiting period." }
  }
  if (pendingRevision) {
    return { ...base, applicable: true, state: "pending_lender_confirmation", readyToConsummateToday: false, governing: gov, reportedPending, onTrackForScheduledClose: onTrack, coaching,
      reasons: [...reasons, `A revised Closing Disclosure (version ${pendingRevision.version}) was reported and the lender has not confirmed it — it may restart the waiting period.`],
      nextAction: "The lender confirms the revised Closing Disclosure and whether it restarts the waiting period." }
  }
  if (onTrack === false) {
    return { ...base, applicable: true, state: "closing_before_earliest_date", readyToConsummateToday: waitOver, governing: gov, reportedPending, onTrackForScheduledClose: false, coaching: null,
      reasons: [...reasons, `The scheduled closing (${input.scheduledCloseDate}) is before the earliest closing day.`], nextAction: `Move the closing to ${earliest} or later.` }
  }
  if (!waitOver) {
    return { ...base, applicable: true, state: "waiting_period_running", readyToConsummateToday: false, governing: gov, reportedPending, onTrackForScheduledClose: onTrack, coaching: null,
      reasons, nextAction: `Closing can happen on ${earliest} or later.` }
  }
  return { ...base, applicable: true, state: "ready", readyToConsummateToday: true, governing: gov, reportedPending, onTrackForScheduledClose: onTrack, coaching: null, reasons, nextAction: "TRID timing is satisfied." }
}
