#!/usr/bin/env tsx
/**
 * scripts/relationship-health-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the LIFETIME relationship-health score — folds inbound recency, reply rate, touch cadence,
 * and enrichment freshness into one band the team can reprioritize on (at-risk/dormant first).
 * Pure + shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/relationship-health-simulator.ts   (npm run test:relationship-health)
 */
import { scoreRelationshipHealth, bandForScore, healthPriority } from "../lib/intelligence/relationship-health"

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
  console.log(" ✅ Relationship health verified — engaged thrives, ghosted decays, priority reprioritizes.")
  console.log(" RELATIONSHIP_HEALTH_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Lifetime relationship-health simulator")
  console.log("══════════════════════════════════════════════════\n")

  // Highly engaged, fresh → thriving.
  const thriving = scoreRelationshipHealth({ daysSinceLastInbound: 3, replyRate: 0.4, daysSinceLastTouch: 5, enrichmentAgeDays: 30 })
  check("recent reply + high engagement + fresh → thriving", thriving.band === "thriving" && thriving.score >= 80, JSON.stringify(thriving))

  // Never reached back, low reply, neglected, stale → at_risk/dormant.
  const dying = scoreRelationshipHealth({ daysSinceLastInbound: null, replyRate: 0.0, daysSinceLastTouch: 90, enrichmentAgeDays: 400 })
  check("ghosted + no replies + neglected + stale → at_risk or worse", (dying.band === "at_risk" || dying.band === "dormant"), JSON.stringify(dying))
  check("dying relationship lists drivers (never reached back, stale, neglected)", dying.drivers.some((d) => /never reached back/.test(d)) && dying.drivers.some((d) => /stale/.test(d)))

  // Middle: replied a while ago, ok reply rate → cooling/warm.
  const mid = scoreRelationshipHealth({ daysSinceLastInbound: 45, replyRate: 0.12, daysSinceLastTouch: 20, enrichmentAgeDays: 60 })
  check("replied weeks ago, decent engagement → warm/cooling", (mid.band === "warm" || mid.band === "cooling"), JSON.stringify(mid))

  // Band math + clamping.
  check("band thresholds", bandForScore(85) === "thriving" && bandForScore(65) === "warm" && bandForScore(45) === "cooling" && bandForScore(25) === "at_risk" && bandForScore(5) === "dormant")
  check("score clamped to 0–100", scoreRelationshipHealth({ daysSinceLastInbound: null, replyRate: 0, daysSinceLastTouch: 999, enrichmentAgeDays: 999 }).score >= 0)

  // Priority reprioritizes the team toward decay.
  check("at-risk/dormant outrank healthy for attention", healthPriority("dormant") > healthPriority("at_risk") && healthPriority("at_risk") > healthPriority("thriving"))

  // No-data fields don't crash and don't over-penalize.
  check("null inputs handled (no NaN)", Number.isFinite(scoreRelationshipHealth({ daysSinceLastInbound: null, replyRate: null, daysSinceLastTouch: null, enrichmentAgeDays: null }).score))

  report()
}

main()
