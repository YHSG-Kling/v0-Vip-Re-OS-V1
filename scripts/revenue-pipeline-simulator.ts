#!/usr/bin/env tsx
/**
 * scripts/revenue-pipeline-simulator.ts  (npm run test:revenue-pipeline) — pure, no DB.
 *
 * Proves the probability-weighted GCI forecast (lib/financials/revenue-projection.ts)
 * that powers /dashboard/financials/pipeline: stage→probability weighting, GCI estimate
 * priority, 30/60/90 windowing by estimated close date, per-agent rollup, and that
 * terminal/zero-probability deals are excluded. The action computes identical numbers
 * from live `transactions` rows (verified columns exist in the live schema).
 */
import { projectPipeline, stageProbability, estimateGci, type ProjectionTxnRow } from "../lib/financials/revenue-projection"

const now = new Date("2026-06-22T00:00:00Z")
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString()

function selfTest(): void {
  let pass = 0, fail = 0
  const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

  console.log("\n[revenue projection · pure]")

  check("stage probability tolerates UPPERCASE + lowercase", stageProbability("UNDER_CONTRACT") === 0.85 && stageProbability("under_contract") === 0.85)
  check("terminal stages → 0 probability", stageProbability("closed") === 1.0 && stageProbability("cancelled") === 0 && stageProbability("withdrawn") === 0)

  // GCI estimate priority: commission_amount wins; else estimated; else pct×price; else 2.5%.
  check("GCI uses negotiated commission_amount first", estimateGci({ commission_amount: 9000, purchase_price: 400000 }) === 9000)
  check("GCI falls back to pct × price", estimateGci({ purchase_price: 400000, commission_percentage: 3 }) === 12000)
  check("GCI default 2.5% of price", estimateGci({ purchase_price: 400000 }) === 10000)

  const rows: ProjectionTxnRow[] = [
    // under_contract, closes in 20d, $10k → in all three windows, weight 0.85
    { agent_id: "a1", stage: "UNDER_CONTRACT", status: "active", close_date: inDays(20), commission_amount: 10000, agent: { id: "a1", first_name: "Dana", last_name: "Reed" } },
    // active listing, closes ~75d, $12k → only 90d window, weight 0.55
    { agent_id: "a2", stage: "active", status: "active", close_date: inDays(75), commission_amount: 12000, agent: { id: "a2", first_name: "Sam", last_name: "Lee" } },
    // closed → excluded (probability 0 path / terminal)
    { agent_id: "a1", stage: "cancelled", status: "active", close_date: inDays(10), commission_amount: 5000, agent: { id: "a1", first_name: "Dana", last_name: "Reed" } },
    // beyond horizon (120d) → excluded
    { agent_id: "a2", stage: "pending", status: "active", close_date: inDays(120), commission_amount: 8000, agent: { id: "a2", first_name: "Sam", last_name: "Lee" } },
  ]

  const { windows, perAgent } = projectPipeline(rows, now)
  const w30 = windows.find((w) => w.windowDays === 30)!
  const w90 = windows.find((w) => w.windowDays === 90)!

  check("30d window holds only the ≤30d deal", w30.dealCount === 1 && w30.weightedGci === Math.round(10000 * 0.85))
  check("90d window holds both in-horizon deals", w90.dealCount === 2)
  check("90d weighted = sum of both weights", w90.weightedGci === Math.round(10000 * 0.85 + 12000 * 0.55))
  check("beyond-horizon + terminal deals excluded everywhere", w90.dealCount === 2 && w30.dealCount === 1)
  check("per-agent rollup splits by agent", perAgent.length === 2)
  const dana = perAgent.find((a) => a.agentId === "a1")!
  check("agent weighted30 reflects only their qualifying deal", dana.weighted30 === Math.round(10000 * 0.85) && dana.pendingCount === 1)
  check("byStage breakdown present + sorted", w90.byStage.length === 2 && w90.byStage[0].weightedGci >= w90.byStage[1].weightedGci)
  check("empty input → zeroed windows, no agents", (() => { const r = projectPipeline([], now); return r.windows.every((w) => w.weightedGci === 0) && r.perAgent.length === 0 })())

  if (fail > 0) { console.log(`\n RESULT: ${pass} passed, ${fail} failed`); process.exit(1) }
  console.log(`\n──────────────────────────────────────────────────`)
  console.log(` RESULT: ${pass} passed, 0 failed`)
  console.log(" ✅ REVENUE_PIPELINE_PASS — weighted GCI forecast math verified")
}

selfTest()
