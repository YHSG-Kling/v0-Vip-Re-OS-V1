#!/usr/bin/env tsx
/**
 * scripts/deal-confidence-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves DEAL CONFIDENCE — distills the EXISTING fused deal-health score (not a new one) into the
 * single WEAKEST LINK + the one PROTECTIVE ACTION, answering the agent's "is it closing, and what's
 * the one thing to fix?". Pure composition over the health components the caller already computed.
 *
 * Run: npx tsx scripts/deal-confidence-simulator.ts   (npm run test:deal-confidence)
 */
import { distillDealConfidence, type ConfidenceComponent } from "../lib/kernel/deal-confidence"

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
  console.log(" ✅ Deal confidence verified — weakest link + one action, no recompute.")
  console.log(" DEAL_CONFIDENCE_PASS")
}

// Mirrors the health-scorer category weights.
const healthy: ConfidenceComponent[] = [
  { category: "earnest_money", score: 100, weight: 14 },
  { category: "lender", score: 100, weight: 14 },
  { category: "inspection", score: 100, weight: 12 },
  { category: "documents", score: 100, weight: 8 },
  { category: "communication", score: 100, weight: 6 },
]

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Deal confidence simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Distillation]")
  // Lender at 50 (impact (100-50)*14 = 700) is the biggest weighted drag.
  const lenderWeak = distillDealConfidence(72, [
    ...healthy.map(c => c.category === "lender" ? { ...c, score: 50, issues: ["clear-to-close not on file"] } : c),
  ], "watch")
  check("confidence reuses the existing score (round)", lenderWeak.confidence === 72)
  check("verdict maps from riskLevel (watch)", lenderWeak.verdict === "watch")
  check("weakest link is the lender (biggest weighted shortfall)", lenderWeak.weakestLink?.category === "lender")
  check("protective action targets the lender / clear-to-close", /lender|clear-to-close/i.test(lenderWeak.protectiveAction))
  check("weakest link carries the real issue (no fabrication)", lenderWeak.weakestLink?.issue === "clear-to-close not on file")

  // WEIGHTED, not just lowest score: communication at 0 (impact 0*... wait 100*6=600) vs lender at 60 ((100-60)*14=560).
  const weightedCase = distillDealConfidence(60, [
    { category: "communication", score: 0, weight: 6 },   // impact 600
    { category: "lender", score: 60, weight: 14 },         // impact 560
    { category: "earnest_money", score: 100, weight: 14 },
  ], undefined)
  check("ranks by WEIGHTED shortfall (communication@0 beats lender@60)", weightedCase.weakestLink?.category === "communication")
  check("verdict falls back to score banding when no riskLevel (60 → at_risk)", weightedCase.verdict === "at_risk")

  // A higher-weight moderate drag outranks a low-weight severe one when impact says so.
  const impactCase = distillDealConfidence(80, [
    { category: "documents", score: 30, weight: 8 },   // impact (70)*8 = 560
    { category: "lender", score: 55, weight: 14 },      // impact (45)*14 = 630
  ])
  check("higher-weight category wins when its weighted impact is larger (lender)", impactCase.weakestLink?.category === "lender")

  console.log("\n[Healthy + edges]")
  const allGood = distillDealConfidence(95, healthy, "healthy")
  check("everything at 100 → no weakest link", allGood.weakestLink === null)
  check("healthy → on_track + 'keep it moving' action", allGood.verdict === "on_track" && /keep it moving|nothing/i.test(allGood.protectiveAction))
  check("critical band maps through (35 → critical)", distillDealConfidence(35, [{ category: "title", score: 20, weight: 10 }]).verdict === "critical")

  report()
}

main()
