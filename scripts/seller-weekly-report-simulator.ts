#!/usr/bin/env tsx
/**
 * scripts/seller-weekly-report-simulator.ts   (npm run test:seller-weekly-report)
 * ─────────────────────────────────────────────────────────────────────────────
 * SELLER WEEKLY REPORT — proves the client-safe weekly digest: momentum derivation, a quiet week is
 * framed constructively (never "0 showings!"), feedback is summarized gently (NEVER raw negatives to
 * the seller), the headline is data-driven (factual, not a canned script), and the week key is a stable
 * Monday. Pure: no I/O. The DB upsert is proven by the live round-trip in the PR.
 */
import {
  buildSellerWeeklyReport, deriveSellerMomentum, buildFeedbackNote, weekStartMonday,
} from "../lib/listings/seller-weekly-report"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[Momentum from real activity — never alarms on a quiet week]")
  check("3+ showings → strong", deriveSellerMomentum({ showingsThisWeek: 4, saves: 2, inquiries: 0 }) === "strong")
  check("some interest → steady", deriveSellerMomentum({ showingsThisWeek: 1, saves: 3, inquiries: 0 }) === "steady")
  check("quiet week → building (not alarming)", deriveSellerMomentum({ showingsThisWeek: 0, saves: 1, inquiries: 0 }) === "building")

  console.log("\n[Quiet week is framed constructively, never a scary 0]")
  // A truly no-activity week → the agent-driving-traffic fallback (no naked zeros).
  const empty = buildSellerWeeklyReport({ weekStart: "2026-06-22", showingsThisWeek: 0, totalShowings: 2, views: 5, saves: 0, inquiries: 0, daysOnMarket: 9, feedback: { positive: 0, neutral: 0, negative: 0 }, marketingChannelsActive: 3 })
  check("no naked '0 showings' in the headline", !/0 showing/i.test(empty.headline))
  check("no-activity week leads with the agent driving traffic", /driving buyer traffic/i.test(empty.headline))
  check("no-activity week momentum is 'building'", empty.momentum === "building")
  // A light week with a single save still reads constructively (not a scary zero).
  const light = buildSellerWeeklyReport({ weekStart: "2026-06-22", showingsThisWeek: 0, totalShowings: 2, views: 5, saves: 1, inquiries: 0, daysOnMarket: 9, feedback: { positive: 0, neutral: 0, negative: 0 }, marketingChannelsActive: 3 })
  check("a single save reads as 'Building interest — 1 save'", /Building interest — 1 save/.test(light.headline))

  console.log("\n[Feedback is gentle — NEVER raw negatives to the seller]")
  check("no feedback yet → forward-looking note", /will gather/i.test(buildFeedbackNote({ positive: 0, neutral: 0, negative: 0 })))
  check("positive-leaning → encouraging", /responding well/i.test(buildFeedbackNote({ positive: 3, neutral: 1, negative: 0 })))
  const critical = buildFeedbackNote({ positive: 0, neutral: 1, negative: 4 })
  check("critical feedback → agent shares takeaways (no raw negatives surfaced)", /reviewing|takeaways/i.test(critical) && !/bad|negative|hated|poor/i.test(critical))

  console.log("\n[Headline is data-driven + factual]")
  const strong = buildSellerWeeklyReport({ weekStart: "2026-06-22", showingsThisWeek: 4, totalShowings: 9, views: 40, saves: 12, inquiries: 2, daysOnMarket: 14, feedback: { positive: 3, neutral: 1, negative: 0 }, marketingChannelsActive: 5 })
  check("headline cites the real showings number", /4 showings/.test(strong.headline))
  check("headline cites the real saves number", /12 saves/.test(strong.headline))
  check("strong week labeled Strong", strong.headline.startsWith("Strong week"))
  check("activity carries the real metrics", strong.activity.views === 40 && strong.activity.saves === 12 && strong.activity.total_showings === 9)

  console.log("\n[Week key is a stable Monday (UTC)]")
  check("a Wednesday maps back to that week's Monday", weekStartMonday(new Date("2026-06-24T12:00:00Z")) === "2026-06-22")
  check("a Sunday maps back to the PRIOR Monday", weekStartMonday(new Date("2026-06-28T12:00:00Z")) === "2026-06-22")
  check("a Monday maps to itself", weekStartMonday(new Date("2026-06-22T00:00:00Z")) === "2026-06-22")

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SELLER_WEEKLY_REPORT_FAIL"); process.exit(1) }
  console.log(" ✅ SELLER_WEEKLY_REPORT_PASS — client-safe weekly digest: gentle, factual, never alarming")
}

main()
