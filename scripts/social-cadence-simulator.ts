#!/usr/bin/env tsx
/**
 * scripts/social-cadence-simulator.ts   (npm run test:social-cadence)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the general/brand SOCIAL auto-cadence — the non-listing social channel is now
 * auto-produced on a cadence (like newsletter/blog), not just listing-triggered. Uses the
 * shared shouldFireCadenceToday gate + pickBrandPostType (rotates the CHECK-valid non-listing
 * types market_update/custom so the feed varies week to week). The stager inserts GATED drafts
 * across connected platforms (exercised live separately). Pure: no I/O.
 */
import { shouldFireCadenceToday } from "../lib/marketing/cadence-policy"
import { pickBrandPostType, BRAND_POST_TYPES } from "../lib/marketing/social-cadence"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[cadence gate is the shared helper — fires on the configured day, honors off/pause]")
  const wed = new Date("2026-07-01T09:00:00Z") // Wednesday, day-of-week 3
  check("weekly on the matching day fires", shouldFireCadenceToday({ cadence: "weekly", fireDay: 3, skippedUntil: null, now: wed }))
  check("'off' never fires", !shouldFireCadenceToday({ cadence: "off", fireDay: 3, skippedUntil: null, now: wed }))
  check("paused window blocks", !shouldFireCadenceToday({ cadence: "weekly", fireDay: 3, skippedUntil: "2026-07-31", now: wed }))

  console.log("\n[brand post-type rotation — only CHECK-valid non-listing types, varies week to week]")
  check("BRAND_POST_TYPES are the CHECK-valid non-listing types", JSON.stringify([...BRAND_POST_TYPES]) === JSON.stringify(["market_update", "custom"]))
  check("even week → market_update", pickBrandPostType(null, 10) === "market_update")
  check("odd week → custom", pickBrandPostType(null, 11) === "custom")
  check("consecutive weeks alternate (no repeat)", pickBrandPostType(null, 20) !== pickBrandPostType(null, 21))

  console.log("\n[policy can narrow the set + invalid types are ignored]")
  check("preferred=['market_update'] → always market_update", pickBrandPostType(["market_update"], 5) === "market_update" && pickBrandPostType(["market_update"], 6) === "market_update")
  check("preferred with an invalid type falls back to the valid pool", pickBrandPostType(["testimonial", "custom"], 3) === "custom")
  check("preferred all-invalid → default pool used", (["market_update", "custom"] as string[]).includes(pickBrandPostType(["listing", "just_sold"], 4)))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SOCIAL_CADENCE_FAIL"); process.exit(1) }
  console.log(" ✅ SOCIAL_CADENCE_PASS — brand social auto-produces on cadence; the non-listing channel is covered")
}
main()
