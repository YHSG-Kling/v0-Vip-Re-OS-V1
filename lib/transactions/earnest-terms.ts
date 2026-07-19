/**
 * Pure earnest-money term helpers. Two DISTINCT earnest facts that must never be conflated:
 *   - the earnest DEPOSIT AMOUNT — a dollar figure (offers.earnest_money) → rendered as CURRENCY
 *     ("Earnest Deposit: $5,000"), showing how much the buyer is putting up as good faith.
 *   - the earnest-money DUE DATE — a calendar date, due BY the offer/contract deadline
 *     (contract_date + earnest_money_due_days, or the stored earnest_money_due_at) → rendered
 *     as a DATE ("Earnest Money Due: <date>").
 *
 * Round 28 owner correction: feeding the AMOUNT into the DUE-date slot (e.g. "$5000" as a deadline)
 * is a bug. These helpers keep the two typed apart and GUARD the due-date derivation against a
 * dollar-amount fallback so a mis-passed amount can never be persisted as the earnest DUE date.
 * Pure: no I/O — safe to import from simulators.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** True only for a bare "YYYY-MM-DD" (or an ISO timestamp we can slice to one).
 *  Rejects "$5000", "5000", "" — i.e. anything that is not a real calendar date. */
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== "string") return false
  const head = v.slice(0, 10)
  return ISO_DATE.test(head) && !Number.isNaN(Date.parse(head))
}

/** Add N calendar days to a "YYYY-MM-DD" date string via pure UTC arithmetic (no local-timezone
 *  drift), returning "YYYY-MM-DD". */
export function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number)
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().split("T")[0]
}

/** Derive the earnest-money DUE DATE (never the amount). Precedence:
 *   1. contract_date + earnest_money_due_days — TZ-safe day math off the execution (contract) date.
 *   2. stored earnest_money_due_at — literal date portion.
 *   3. caller fallback — ONLY if it is a real calendar date; a dollar amount (or any non-date) is
 *      refused, returning undefined, so a mis-passed earnest AMOUNT can never land in the due slot. */
export function deriveEarnestDueDate(input: {
  contractDate?: string | null
  earnestMoneyDueDays?: number | null
  earnestMoneyDueAt?: string | null
  fallbackDue?: string | null
}): string | undefined {
  const { contractDate, earnestMoneyDueDays, earnestMoneyDueAt, fallbackDue } = input
  if (contractDate && typeof earnestMoneyDueDays === "number") {
    return addDaysToDateString(contractDate.split("T")[0], earnestMoneyDueDays)
  }
  if (earnestMoneyDueAt) return String(earnestMoneyDueAt).slice(0, 10)
  if (isCalendarDate(fallbackDue)) return fallbackDue.slice(0, 10)
  return undefined // refuse a non-date fallback (e.g. a mis-passed dollar amount)
}

/** Format the earnest DEPOSIT AMOUNT as currency. Null/absent → em dash. Never a date. */
export function formatEarnestAmount(n: number | null | undefined): string {
  return n != null ? `$${Number(n).toLocaleString()}` : "—"
}
