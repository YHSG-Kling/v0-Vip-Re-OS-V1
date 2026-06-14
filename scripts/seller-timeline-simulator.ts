#!/usr/bin/env tsx
/**
 * scripts/seller-timeline-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves SELLER TIME-TO-LIST: the timeline layer on top of scoreSellerIntent answers WHEN a
 * homeowner is likely to list, so the AI ISA works the right seller at the RIGHT MOMENT. Pure —
 * uses only signals actually present; forced clocks (pre-foreclosure/tax) outrank discretionary
 * windows (expired/divorce/probate) outrank eventual (downsizer/absentee). Annotation only — the
 * canonical gate still decides if a scraped record becomes a lead (never skips the gate).
 *
 * Run: npx tsx scripts/seller-timeline-simulator.ts   (npm run test:seller-timeline)
 */
import { computeSellerListingTimeline, timelineRank } from "../lib/kernel/seller-listing-timeline"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Seller time-to-list verified — the right seller at the right moment, no fabrication.")
  console.log(" SELLER_TIMELINE_PASS")
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Seller time-to-list simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Pure timeline matrix]")
  const pf = computeSellerListingTimeline({ tags: ["pre_foreclosure"] })
  check("pre-foreclosure → forced 30–90d", pf.listingClass === "forced" && pf.windowDaysLow === 30 && pf.windowDaysHigh === 90 && pf.predictedDaysToList === 60)
  check("notice-of-sale → forced 14–45d (auction clock, shortest)", computeSellerListingTimeline({ tags: ["notice-of-sale"] }).windowDaysHigh === 45)
  check("FSBO → active 0–45d (selling now)", computeSellerListingTimeline({ tags: ["fsbo"] }).listingClass === "active")
  const fresh = computeSellerListingTimeline({ tags: ["expired"], expiredDaysAgo: 10 })
  const stale = computeSellerListingTimeline({ tags: ["expired"], expiredDaysAgo: 200 })
  check("fresh expired → tighter window than a stale expired", (fresh.predictedDaysToList ?? 0) < (stale.predictedDaysToList ?? 0))
  check("probate → opportunity 120–365d (court-paced)", computeSellerListingTimeline({ tags: ["probate"] }).windowDaysLow === 120)
  check("long tenure + high equity → eventual downsizer", computeSellerListingTimeline({ tags: [], tenureYears: 18, equityPct: 72 }).listingClass === "eventual")
  check("absentee/vacant → eventual", computeSellerListingTimeline({ tags: ["absentee"] }).listingClass === "eventual")
  const none = computeSellerListingTimeline({ tags: ["high_equity"], equityPct: 40 })
  check("no time-bound signal → unknown, null window (no fabrication)", none.listingClass === "unknown" && none.predictedDaysToList === null)

  console.log("\n[Precedence + ranking]")
  // A record with BOTH a forced clock and an expired flag → the forced clock wins.
  const both = computeSellerListingTimeline({ tags: ["expired", "pre_foreclosure"], expiredDaysAgo: 5 })
  check("forced clock outranks a discretionary expired window", both.listingClass === "forced")
  check("a forced seller ranks ahead of an eventual one (work imminent first)",
    timelineRank(pf) < timelineRank(computeSellerListingTimeline({ tags: ["absentee"] })))
  check("unknown timelines rank LAST", timelineRank(none) === Number.MAX_SAFE_INTEGER)

  report()
}

main()
