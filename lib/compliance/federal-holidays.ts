// lib/compliance/federal-holidays.ts
//
// US FEDERAL HOLIDAYS for TRID business-day math. Pure, no I/O, deterministic.
//
// TRID has TWO "business day" definitions (Reg Z §1026.2(a)(6)):
//   • GENERAL business day  — days the creditor is open for substantially all of its
//     business functions. Convention: Mon–Fri excluding federal holidays. Used for
//     the Loan Estimate (delivered within 3 business days of application).
//   • PRECISE/SPECIFIC business day — ALL calendar days EXCEPT Sundays and the legal
//     public holidays in 5 U.S.C. 6103(a). Saturdays COUNT. Used for the Closing
//     Disclosure "received ≥3 business days before consummation" rule and rescission.
//
// Both EXCLUDE federal holidays — which the old clock did not, so it could undercount
// the CD window across a holiday and call a too-late CD "compliant." This module is
// the source of truth for which dates are federal holidays (with the 5 U.S.C. 6103
// observed-shift: a holiday on Saturday is observed the preceding Friday, on Sunday
// the following Monday).

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

// nth weekday of a month (1-indexed n); weekday 0=Sun..6=Sat. Returns day-of-month.
function nthWeekday(year: number, month1: number, weekday: number, n: number): number {
  // month1 is 1-indexed
  const first = new Date(Date.UTC(year, month1 - 1, 1)).getUTCDay()
  const offset = (weekday - first + 7) % 7
  return 1 + offset + (n - 1) * 7
}

function lastWeekday(year: number, month1: number, weekday: number): number {
  const daysInMonth = new Date(Date.UTC(year, month1, 0)).getUTCDate()
  const lastDow = new Date(Date.UTC(year, month1 - 1, daysInMonth)).getUTCDay()
  return daysInMonth - ((lastDow - weekday + 7) % 7)
}

// Apply the 5 U.S.C. 6103(a) observed-shift to a FIXED-date holiday:
// Saturday → observed the preceding Friday; Sunday → observed the following Monday.
function observed(year: number, month1: number, day: number): string {
  const d = new Date(Date.UTC(year, month1 - 1, day))
  const dow = d.getUTCDay()
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1) // Sat → Fri
  else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1) // Sun → Mon
  return d.toISOString().slice(0, 10)
}

const cache = new Map<number, Set<string>>()

/** The set of OBSERVED federal-holiday ISO dates for a given year. */
export function federalHolidaysForYear(year: number): Set<string> {
  const cached = cache.get(year)
  if (cached) return cached

  const set = new Set<string>([
    // Fixed-date holidays — apply the weekend observed-shift.
    observed(year, 1, 1), // New Year's Day
    observed(year, 6, 19), // Juneteenth National Independence Day (federal since 2021)
    observed(year, 7, 4), // Independence Day
    observed(year, 11, 11), // Veterans Day
    observed(year, 12, 25), // Christmas Day
    // Floating Monday/Thursday holidays — never land on a weekend, no shift.
    ymd(year, 1, nthWeekday(year, 1, 1, 3)), // MLK Jr. Day — 3rd Monday in Jan
    ymd(year, 2, nthWeekday(year, 2, 1, 3)), // Washington's Birthday — 3rd Monday in Feb
    ymd(year, 5, lastWeekday(year, 5, 1)), // Memorial Day — last Monday in May
    ymd(year, 9, nthWeekday(year, 9, 1, 1)), // Labor Day — 1st Monday in Sep
    ymd(year, 10, nthWeekday(year, 10, 1, 2)), // Columbus Day — 2nd Monday in Oct
    ymd(year, 11, nthWeekday(year, 11, 4, 4)), // Thanksgiving — 4th Thursday in Nov
  ])

  // Juneteenth observed before 2021 didn't exist federally — drop it for old years.
  if (year < 2021) set.delete(observed(year, 6, 19))

  cache.set(year, set)
  return set
}

/** Is the given ISO date (yyyy-mm-dd) an observed US federal holiday? */
export function isFederalHoliday(iso: string): boolean {
  const year = Number(iso.slice(0, 4))
  if (!Number.isFinite(year)) return false
  if (federalHolidaysForYear(year).has(iso)) return true
  // Cross-year observed shift: New Year's Day (Jan 1) falling on a Saturday is
  // observed the preceding Friday (Dec 31 of the prior year), which lands in the
  // NEXT year's holiday set. Check it for Dec-31 dates.
  if (iso.slice(5) === "12-31" && federalHolidaysForYear(year + 1).has(iso)) return true
  return false
}
