#!/usr/bin/env tsx
/**
 * scripts/federal-holidays-simulator.ts   (npm run test:federal-holidays)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the US federal-holiday calendar used by TRID business-day math:
 * floating Monday/Thursday holidays land on the right date, fixed-date holidays
 * apply the 5 U.S.C. 6103 observed-shift (Sat→Fri, Sun→Mon), Juneteenth only
 * counts from 2021, and the cross-year New-Year edge (Jan 1 Sat → Dec 31 prior)
 * resolves. Pure: no I/O.
 */
import { isFederalHoliday, federalHolidaysForYear } from "../lib/compliance/federal-holidays"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[2026 floating + fixed holidays]")
  check("New Year's Day 2026-01-01 (Thu)", isFederalHoliday("2026-01-01"))
  check("MLK Day = 2026-01-19 (3rd Mon Jan)", isFederalHoliday("2026-01-19"))
  check("Presidents' Day = 2026-02-16 (3rd Mon Feb)", isFederalHoliday("2026-02-16"))
  check("Memorial Day = 2026-05-25 (last Mon May)", isFederalHoliday("2026-05-25"))
  check("Labor Day = 2026-09-07 (1st Mon Sep)", isFederalHoliday("2026-09-07"))
  check("Columbus Day = 2026-10-12 (2nd Mon Oct)", isFederalHoliday("2026-10-12"))
  check("Thanksgiving = 2026-11-26 (4th Thu Nov)", isFederalHoliday("2026-11-26"))
  check("Veterans Day 2026-11-11 (Wed)", isFederalHoliday("2026-11-11"))
  check("Christmas 2026-12-25 (Fri)", isFederalHoliday("2026-12-25"))

  console.log("\n[observed-shift on weekend fixed-date holidays]")
  // July 4 2026 is a Saturday → observed the preceding Friday, July 3.
  check("July 4 2026 (Sat) observed → 2026-07-03 is a holiday", isFederalHoliday("2026-07-03"))
  check("the actual Saturday 2026-07-04 is NOT the observed holiday", !isFederalHoliday("2026-07-04"))
  // Christmas 2022 is a Sunday → observed Monday Dec 26.
  check("Christmas 2022 (Sun) observed → 2022-12-26 is a holiday", isFederalHoliday("2022-12-26"))
  check("the actual Sunday 2022-12-25 is NOT the observed holiday", !isFederalHoliday("2022-12-25"))

  console.log("\n[cross-year New Year edge]")
  // New Year's Day 2022 (Jan 1) is a Saturday → observed Friday Dec 31, 2021.
  check("2021-12-31 is the observed 2022 New Year's", isFederalHoliday("2021-12-31"))

  console.log("\n[Juneteenth only federal from 2021]")
  check("Juneteenth 2026-06-19 is a holiday", isFederalHoliday("2026-06-19"))
  check("Juneteenth NOT a federal holiday in 2020", !isFederalHoliday("2020-06-19"))

  console.log("\n[non-holidays]")
  check("ordinary Tuesday 2026-03-10 is not a holiday", !isFederalHoliday("2026-03-10"))
  check("a Saturday that isn't a holiday is not flagged", !isFederalHoliday("2026-03-14"))
  check("11 holidays in 2026", federalHolidaysForYear(2026).size === 11)
  check("10 holidays in 2019 (pre-Juneteenth)", federalHolidaysForYear(2019).size === 10)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ FEDERAL_HOLIDAYS_FAIL"); process.exit(1) }
  console.log(" ✅ FEDERAL_HOLIDAYS_PASS — observed federal holidays for TRID business-day math")
}
main()
