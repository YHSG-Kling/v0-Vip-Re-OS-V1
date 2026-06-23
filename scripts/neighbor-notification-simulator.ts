#!/usr/bin/env tsx
/**
 * scripts/neighbor-notification-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the PURE core of the neighbor-farming flow: scoreNeighbor — the
 * "knows-a-buyer / likely-to-engage" heuristic that gates which neighbors get
 * routed (>= threshold) into the governed direct-mail pipeline.
 *
 * The rest of neighbor-notifications.ts is DB orchestration (insert campaign,
 * insert recipients, push into direct_mail_campaigns/recipients), so only the
 * scoring helper is simulated. Pure + shell-runnable. NO mocks.
 *
 * Run: npx tsx scripts/neighbor-notification-simulator.ts
 */
import { scoreNeighbor } from "../lib/kernel/neighbor-farm"

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
  console.log(" ✅ Neighbor scoring verified — base/tenure/owner-occupancy weights, clamp, threshold gate.")
  console.log(" NEIGHBOR_NOTIFICATION_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Neighbor notification scoring simulator")
  console.log("══════════════════════════════════════════════════\n")

  const THRESHOLD = 0.6 // default knows_buyer_score_threshold in createNeighborNotificationCampaign

  console.log("[base + components]")
  // Base score is 0.4 (no tenure, not owner-occupied).
  check("unknown tenure, not owner-occupied → 0.4", scoreNeighbor(null, false) === 0.4,
    `got ${scoreNeighbor(null, false)}`)
  // Owner-occupied adds exactly +0.15.
  check("unknown tenure, owner-occupied → 0.55", scoreNeighbor(null, true) === 0.55,
    `got ${scoreNeighbor(null, true)}`)
  // Tenure adds tenureYears * 0.03 (1yr → +0.03).
  check("1yr tenure, not owner-occupied → 0.43", scoreNeighbor(1, false) === 0.43,
    `got ${scoreNeighbor(1, false)}`)
  // 5yr → +0.15 (5 * 0.03), still under the owner-occupied cap.
  check("5yr tenure, not owner-occupied → 0.55", scoreNeighbor(5, false) === 0.55,
    `got ${scoreNeighbor(5, false)}`)

  console.log("\n[tenure cap]")
  // Tenure contribution is capped at +0.35 (min(0.35, years*0.03)). 0.35/0.03 ≈ 11.67y.
  check("12yr tenure caps tenure term → 0.4 + 0.35 = 0.75", scoreNeighbor(12, false) === 0.75,
    `got ${scoreNeighbor(12, false)}`)
  check("40yr tenure does not exceed cap → still 0.75", scoreNeighbor(40, false) === 0.75,
    `got ${scoreNeighbor(40, false)}`)
  check("12yr same whether 12 or 100 (cap stable)",
    scoreNeighbor(12, false) === scoreNeighbor(100, false))

  console.log("\n[clamp to 1]")
  // Max possible: 0.4 + 0.35 (tenure cap) + 0.15 (owner) = 0.90, never exceeds 1.
  check("long-tenure owner-occupied → 0.9 (never > 1)", scoreNeighbor(40, true) === 0.9,
    `got ${scoreNeighbor(40, true)}`)
  check("score never exceeds 1", scoreNeighbor(9999, true) <= 1)

  console.log("\n[monotonicity]")
  check("more tenure never lowers score", scoreNeighbor(8, false) >= scoreNeighbor(3, false))
  check("owner-occupied never lowers score", scoreNeighbor(5, true) >= scoreNeighbor(5, false))

  console.log("\n[threshold gate — who routes into the governed pipeline]")
  // The campaign filters recipients to knowsBuyerScore >= threshold (default 0.6).
  // A rooted owner-occupant (long tenure) clears the gate; a transient renter does not.
  check("fresh renter (1yr, not owner) is BELOW 0.6 gate → excluded",
    scoreNeighbor(1, false) < THRESHOLD, `got ${scoreNeighbor(1, false)}`)
  check("rooted owner (8yr, owner-occupied) is AT/ABOVE 0.6 gate → included",
    scoreNeighbor(8, true) >= THRESHOLD, `got ${scoreNeighbor(8, true)}`)
  check("boundary: 5yr owner-occupied (0.55+0.15=0.70) clears gate",
    scoreNeighbor(5, true) >= THRESHOLD, `got ${scoreNeighbor(5, true)}`)

  report()
}

main()
