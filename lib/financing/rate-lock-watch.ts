// lib/financing/rate-lock-watch.ts
//
// RATE-LOCK EXPIRATION WATCH — the pure engine.
//
// THE GAP (verified white space): a buyer's mortgage rate is locked for a finite window
// (commonly 30/45/60 days). If the closing date slips toward — or past — the lock's
// expiration, the buyer must pay to EXTEND the lock or re-lock at a (usually worse) rate.
// The stack tracked the financing DATE chain (financing-pit-stop works the rate/lender side,
// the watchtower the closing date) but NOTHING watched the rate lock vs the closing date, so
// a quietly slipping closing could blow past the lock and cost the buyer real money with no
// warning. Competitors don't surface this; it's the kind of catch that makes an agent look
// like a hero.
//
// This module is PURE (no I/O): given the lock expiration, the scheduled closing date, and
// today, it computes the buffer (calendar days between the closing and the lock expiry) and
// a verdict. HONEST: no lock expiration on file → not_applicable (never a fabricated
// countdown — most deals won't have a lock date captured, and that's fine, they're skipped).

export interface RateLockInput {
  /** ISO date — injectable so the simulator is deterministic */
  today: string
  rateLockExpirationDate?: string | null
  scheduledCloseDate?: string | null
}

export type RateLockStatus = "ok" | "tight" | "at_risk" | "expired" | "not_applicable"

export interface RateLockVerdict {
  status: RateLockStatus
  /** calendar days the lock expiry sits AFTER the closing (positive = cushion, negative =
   *  the closing is past the lock) — null when N/A */
  bufferDays: number | null
  /** calendar days from today until the lock expires (negative = already expired) — null when N/A */
  daysToExpiry: number | null
  /** at_risk or expired → escalate */
  flagged: boolean
  message: string
}

// Tunables. A closing within this cushion of the lock expiry is "tight"; a closing AT/after
// the expiry is "at_risk"; a lock already past today (and not yet closed) is "expired".
export const TIGHT_BUFFER_DAYS = 7
export const AT_RISK_BUFFER_DAYS = 2

function parse(d: string): Date {
  const [y, m, day] = d.split("-").map(Number)
  return new Date(Date.UTC(y, (m ?? 1) - 1, day ?? 1))
}
function calendarDaysBetween(fromIso: string, toIso: string): number {
  return Math.round((parse(toIso).getTime() - parse(fromIso).getTime()) / 86_400_000)
}

/** Compute the rate-lock risk. Pure. */
export function computeRateLockRisk(input: RateLockInput): RateLockVerdict {
  if (!input.rateLockExpirationDate) {
    return { status: "not_applicable", bufferDays: null, daysToExpiry: null, flagged: false, message: "No rate-lock expiration on file — nothing to watch yet." }
  }
  const daysToExpiry = calendarDaysBetween(input.today, input.rateLockExpirationDate)

  if (!input.scheduledCloseDate) {
    // We know the lock but not the close date. Only an IMMINENT/past lock is worth a flag.
    if (daysToExpiry < 0) {
      return { status: "expired", bufferDays: null, daysToExpiry, flagged: true, message: `The rate lock expired ${Math.abs(daysToExpiry)} day(s) ago and no closing date is set — confirm the lock status with the lender before proceeding.` }
    }
    if (daysToExpiry <= TIGHT_BUFFER_DAYS) {
      return { status: "at_risk", bufferDays: null, daysToExpiry, flagged: true, message: `The rate lock expires in ${daysToExpiry} day(s) and there's no scheduled closing date yet — lock an extension or confirm timing with the lender.` }
    }
    return { status: "ok", bufferDays: null, daysToExpiry, flagged: false, message: `Rate lock expires in ${daysToExpiry} day(s); no closing date set yet.` }
  }

  // bufferDays = how many days the lock expiry sits AFTER the closing (cushion).
  const bufferDays = calendarDaysBetween(input.scheduledCloseDate, input.rateLockExpirationDate)

  // The lock has already lapsed (and the deal hasn't closed) — the worst case.
  if (daysToExpiry < 0) {
    return { status: "expired", bufferDays, daysToExpiry, flagged: true, message: `The rate lock expired ${Math.abs(daysToExpiry)} day(s) ago but the deal closes ${input.scheduledCloseDate} — the buyer is exposed to a re-lock at today's rate. Extend or re-lock now.` }
  }
  // Closing is AT or AFTER the lock expiry → the lock won't survive to closing.
  if (bufferDays < 0) {
    return { status: "at_risk", bufferDays, daysToExpiry, flagged: true, message: `The closing (${input.scheduledCloseDate}) is ${Math.abs(bufferDays)} day(s) AFTER the rate lock expires (${input.rateLockExpirationDate}) — request a lock extension now so the buyer keeps their rate.` }
  }
  // Closing lands inside the danger cushion before expiry.
  if (bufferDays <= AT_RISK_BUFFER_DAYS) {
    return { status: "at_risk", bufferDays, daysToExpiry, flagged: true, message: `The rate lock (${input.rateLockExpirationDate}) expires only ${bufferDays} day(s) after the ${input.scheduledCloseDate} closing — any slip blows the lock. Line up an extension as a safety net.` }
  }
  if (bufferDays <= TIGHT_BUFFER_DAYS) {
    return { status: "tight", bufferDays, daysToExpiry, flagged: false, message: `Rate lock cushion is tight — only ${bufferDays} day(s) between the ${input.scheduledCloseDate} closing and the ${input.rateLockExpirationDate} lock expiry. Keep the closing on schedule.` }
  }
  return { status: "ok", bufferDays, daysToExpiry, flagged: false, message: `Rate lock has a healthy ${bufferDays}-day cushion beyond the scheduled closing.` }
}
