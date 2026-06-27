#!/usr/bin/env tsx
/**
 * scripts/alert-cadence-snooze-simulator.ts   (npm run test:alert-cadence-snooze)
 * ─────────────────────────────────────────────────────────────────────────────
 * BUYER ALERT CADENCE + SNOOZE — proves the engine honors the buyer's chosen cadence (instant vs
 * daily vs weekly) and a temporary, AUTO-RESUMING snooze (skip while snoozed_until is future, then
 * resume on its own — the search is never deactivated). Pure: no I/O, deterministic clocks.
 */
import { shouldRunNow, isSnoozed } from "../lib/alerts/alert-cadence"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

// Fixed clocks (UTC): Monday 08:00, Tuesday 13:00, Tuesday 17:00.
const monday8   = new Date("2026-06-29T08:00:00Z") // getUTCDay()===1
const tues1pm   = new Date("2026-06-30T13:00:00Z")
const tues5pm   = new Date("2026-06-30T17:00:00Z")

function main() {
  console.log("\n[Cadence gate — the buyer's chosen frequency is honored]")
  check("instant always runs", shouldRunNow("instant", tues1pm) && shouldRunNow("instant", monday8))
  check("daily runs at 08:00 UTC", shouldRunNow("daily", monday8) === true)
  check("daily does NOT run at 13:00", shouldRunNow("daily", tues1pm) === false)
  check("twice_daily runs at 08 and 17", shouldRunNow("twice_daily", monday8) && shouldRunNow("twice_daily", tues5pm))
  check("twice_daily skips 13:00", shouldRunNow("twice_daily", tues1pm) === false)
  check("weekly runs Monday 08:00", shouldRunNow("weekly", monday8) === true)
  check("weekly skips Tuesday", shouldRunNow("weekly", tues1pm) === false)
  check("unknown frequency never runs (safe default)", shouldRunNow("whenever", monday8) === false)

  console.log("\n[Snooze — temporary mute that auto-resumes, search never deactivated]")
  const future = new Date("2026-07-15T00:00:00Z").toISOString()
  const past   = new Date("2026-06-01T00:00:00Z").toISOString()
  check("snoozed_until in the future → snoozed (skip)", isSnoozed(future, tues1pm) === true)
  check("snoozed_until in the past → NOT snoozed (auto-resumed)", isSnoozed(past, tues1pm) === false)
  check("null → not snoozed (default)", isSnoozed(null, tues1pm) === false)
  check("empty string → not snoozed", isSnoozed("", tues1pm) === false)
  check("garbage timestamp → not snoozed (never silently mutes forever)", isSnoozed("not-a-date", tues1pm) === false)

  console.log("\n[Combined: a daily search snoozed today is skipped even at its run hour]")
  const eligible = (freq: string, snooze: string | null, now: Date) => shouldRunNow(freq, now) && !isSnoozed(snooze, now)
  check("daily @08:00 but snoozed → skipped", eligible("daily", future, monday8) === false)
  check("daily @08:00 not snoozed → runs", eligible("daily", null, monday8) === true)
  check("daily @08:00 snooze expired → runs again (auto-resume)", eligible("daily", past, monday8) === true)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ ALERT_CADENCE_SNOOZE_FAIL"); process.exit(1) }
  console.log(" ✅ ALERT_CADENCE_SNOOZE_PASS — buyer controls cadence + snooze; snooze auto-resumes, no manual reactivation")
}

main()
