#!/usr/bin/env tsx
/**
 * scripts/newsletter-cadence-simulator.ts   (npm run test:newsletter-cadence)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the newsletter auto-cadence's pure "fire today?" decision — newsletter is now
 * auto-produced on a cadence (weekly/biweekly/monthly) like blog/direct-mail/ads, so no human
 * builds one every cycle. shouldFireCadenceToday fires on the configured day, honors 'off' and
 * the paused window (skipped_until), and biweekly lands every OTHER week. Pure: no I/O.
 * The stager (stageNewsletterFromCadence) inserts a GATED draft and is exercised live separately.
 */
import { shouldFireCadenceToday, isoWeekNumber } from "../lib/marketing/cadence-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

// 2026-07-01 is a Wednesday (UTC), day-of-week 3, day-of-month 1.
const wed = new Date("2026-07-01T09:00:00Z")
const fireW = (fireDay: number | null, cadence: string, extra: Partial<{ skippedUntil: string | null }> = {}) =>
  shouldFireCadenceToday({ cadence, fireDay, skippedUntil: extra.skippedUntil ?? null, now: wed })

function main() {
  console.log("\n[weekly]")
  check("weekly on the matching day-of-week (Wed=3) → fires", fireW(3, "weekly") === true)
  check("weekly on a different day → no fire", fireW(1, "weekly") === false)

  console.log("\n[monthly]")
  check("monthly on the matching day-of-month (1) → fires", fireW(1, "monthly") === true)
  check("monthly on a different day-of-month → no fire", fireW(15, "monthly") === false)

  console.log("\n[biweekly — matching day AND even ISO week]")
  const wk = isoWeekNumber(wed)
  check("biweekly on the matching day fires only on even ISO weeks", fireW(3, "biweekly") === (wk % 2 === 0))
  check("biweekly on a non-matching day → no fire", fireW(2, "biweekly") === false)

  console.log("\n[off + guards]")
  check("cadence 'off' → never fires", fireW(3, "off") === false)
  check("null fire_day → never fires", fireW(null, "weekly") === false)

  console.log("\n[paused window (skipped_until, inclusive)]")
  check("paused through a FUTURE date → no fire", fireW(3, "weekly", { skippedUntil: "2026-07-31" }) === false)
  check("paused through TODAY (inclusive) → no fire", fireW(3, "weekly", { skippedUntil: "2026-07-01" }) === false)
  check("paused window in the PAST → fires normally", fireW(3, "weekly", { skippedUntil: "2026-06-01" }) === true)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ NEWSLETTER_CADENCE_FAIL"); process.exit(1) }
  console.log(" ✅ NEWSLETTER_CADENCE_PASS — newsletters auto-produce on cadence; the last standalone type is automated")
}
main()
