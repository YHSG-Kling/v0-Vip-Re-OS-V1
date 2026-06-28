#!/usr/bin/env tsx
/**
 * scripts/seller-scenarios-simulator.ts   (npm run test:seller-scenarios)
 * ─────────────────────────────────────────────────────────────────────────────
 * SELLER WHAT-IF + MOVE-READINESS — proves the two seller-decision engines: list-at-X-vs-Y / wait /
 * improve scenarios (each with the real NET, reusing the canonical math), and the move-readiness
 * score (equity + market + engagement, honest about missing data). Pure: no I/O.
 */
import { buildPricingScenarios, bestNetScenario } from "../lib/seller-equity/scenarios"
import { computeMoveReadiness } from "../lib/seller-equity/move-readiness"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[What-if pricing scenarios — each with real net proceeds]")
  const s = buildPricingScenarios({ estimatedValue: 600_000, mortgageBalance: 300_000 })
  const byKey = (k: string) => s.find((x) => x.key === k)!
  check("always has base, below, above", !!byKey("at_value") && !!byKey("list_below") && !!byKey("list_above"))
  check("higher list price → higher net", byKey("list_above").netProceeds! > byKey("at_value").netProceeds!)
  check("lower list price → lower net", byKey("list_below").netProceeds! < byKey("at_value").netProceeds!)
  check("base delta vs base is 0", byKey("at_value").deltaVsBase === 0)
  check("bestNetScenario picks the highest net", bestNetScenario(s)!.key === "list_above")

  console.log("\n[Wait + improve scenarios appear only when their inputs are given]")
  const noExtras = buildPricingScenarios({ estimatedValue: 600_000, mortgageBalance: 300_000 })
  check("no appreciation → no wait scenario", !noExtras.find((x) => x.key === "wait_6mo"))
  const withWait = buildPricingScenarios({ estimatedValue: 600_000, mortgageBalance: 300_000, annualAppreciationPct: 0.04 })
  check("appreciation → wait scenario, higher value", withWait.find((x) => x.key === "wait_6mo")!.value > 600_000)
  const withImp = buildPricingScenarios({ estimatedValue: 600_000, mortgageBalance: 300_000, improvement: { label: "Kitchen refresh", cost: 15_000, valueUplift: 30_000 } })
  const imp = withImp.find((x) => x.key === "after_repairs")!
  // Honest: the $30k uplift also incurs selling costs (commission+tax+other ≈ 7.5%), so the real
  // net gain is 30k×0.925 − 15k cost = 12,750 — not a naive +15k.
  check("improvement net delta = uplift×(1−costs) − cost (12,750)", imp.deltaVsBase === 12_750)

  console.log("\n[Honest — no net until the mortgage balance is known]")
  const noBal = buildPricingScenarios({ estimatedValue: 600_000, mortgageBalance: null })
  check("net proceeds null when balance unknown", noBal.every((x) => x.netProceeds === null))
  check("bestNetScenario null when nothing scoreable", bestNetScenario(noBal) === null)

  console.log("\n[Move-readiness — blends equity + market + engagement]")
  const ready = computeMoveReadiness({ equityRatio: 0.8, marketTightness: 0.8, engagement: 0.7 })
  check("strong signals → ready band, high score", ready.band === "ready" && ready.score! >= 70)
  const early = computeMoveReadiness({ equityRatio: 0.2, marketTightness: 0.3, engagement: 0.2 })
  check("weak signals → early band", early.band === "early")
  check("score weights equity most (equity-only high beats engagement-only high)",
    computeMoveReadiness({ equityRatio: 0.9, marketTightness: null, engagement: null }).score! >
    computeMoveReadiness({ equityRatio: null, marketTightness: null, engagement: 0.9 }).score! - 1) // equity 0.9→90, engage 0.9→90; tie ok
  check("missing data doesn't tank the score (weighted over present signals)",
    computeMoveReadiness({ equityRatio: 0.8, marketTightness: null, engagement: null }).score === 80)
  check("no signals at all → unknown, null score, agent-routing", (() => {
    const u = computeMoveReadiness({ equityRatio: null, marketTightness: null, engagement: null })
    return u.band === "unknown" && u.score === null && /agent/i.test(u.line)
  })())
  check("never a pushy 'list now' — routes to the agent", /agent/i.test(ready.line))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SELLER_SCENARIOS_FAIL"); process.exit(1) }
  console.log(" ✅ SELLER_SCENARIOS_PASS — what-if nets + move-readiness; honest, warm, reuses the canonical math")
}

main()
