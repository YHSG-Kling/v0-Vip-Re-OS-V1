#!/usr/bin/env tsx
/**
 * scripts/spend-governance-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — platform-vendor spend-governance harness.
 *
 * The platform owns the keys for the paid AI vendors (D-ID, ElevenLabs, Vapi,
 * AVM) + Lob direct mail, so a runaway agent loop spends the PLATFORM's money.
 * The defense is a month-to-date vendor-spend ceiling per plan tier
 * (checkVendorBudget → vendor_usage_tracking). This harness proves it works —
 * and guards the column-name drift that had silently disabled it.
 *
 *   Layer 1 — the real pure decision core (budget-eval.ts, no server-only):
 *     evaluateVendorBudget (allow / soft-warn@80% / block@100% + addCost
 *     pre-flight), vendorBudgetForTier (every tier), aggregateBrokerageSpend.
 *
 *   Layer 2 — live ledger round-trip (gated on SUPABASE_SERVICE_ROLE_KEY):
 *     seeds vendor_usage_tracking.total_cost rows and runs the EXACT query the
 *     gate runs, asserting the cap transitions ok → approaching → paused. This
 *     fails if the readers ever drift off `total_cost` again (the bug: readers
 *     summed a non-existent `estimated_cost` column → every read errored →
 *     fail-open → cap silently disabled). Self-cleans every seeded row.
 *
 * Run:  npx tsx scripts/spend-governance-simulator.ts   (npm run test:spend-governance)
 */
import {
  evaluateVendorBudget, vendorBudgetForTier, aggregateBrokerageSpend,
  MONTHLY_VENDOR_BUDGET_USD, DEFAULT_VENDOR_BUDGET,
} from "../lib/vendor-governance/budget-eval"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — pure budget decision core
// ─────────────────────────────────────────────────────────────────────────────

function testBudgetEval() {
  console.log("\n[Layer 1 · evaluateVendorBudget]")
  const b = 200 // team tier
  check("well under budget → allowed, no warning", (() => { const e = evaluateVendorBudget(50, b); return e.allowed && !e.softWarning })())
  check("at 80% → soft warning (still allowed)", (() => { const e = evaluateVendorBudget(160, b); return e.allowed && e.softWarning })())
  check("at 100% exactly → still allowed (boundary)", evaluateVendorBudget(200, b).allowed === true)
  check("over budget → BLOCKED", evaluateVendorBudget(201, b).allowed === false)
  check("addCost pre-flight projects the would-be spend", evaluateVendorBudget(190, b, 20).allowed === false)
  check("addCost under ceiling stays allowed", evaluateVendorBudget(150, b, 20).allowed === true)
  check("percent reported correctly", evaluateVendorBudget(100, b).percent === 50)
  check("negative/garbage spend floored at 0", evaluateVendorBudget(-5, b).allowed === true)
  check("zero budget falls back to default (never divide-by-zero)", evaluateVendorBudget(10, 0).budget === DEFAULT_VENDOR_BUDGET)
}

function testTierBudgets() {
  console.log("\n[Layer 1 · vendorBudgetForTier — plan-tier ceilings]")
  check("solo_agent ceiling", vendorBudgetForTier("solo_agent") === MONTHLY_VENDOR_BUDGET_USD.solo_agent)
  check("team ceiling", vendorBudgetForTier("team") === MONTHLY_VENDOR_BUDGET_USD.team)
  check("brokerage ceiling", vendorBudgetForTier("brokerage") === MONTHLY_VENDOR_BUDGET_USD.brokerage)
  check("multi_location ceiling", vendorBudgetForTier("multi_location") === MONTHLY_VENDOR_BUDGET_USD.multi_location)
  check("ceilings increase monotonically with tier",
    MONTHLY_VENDOR_BUDGET_USD.solo_agent < MONTHLY_VENDOR_BUDGET_USD.team &&
    MONTHLY_VENDOR_BUDGET_USD.team < MONTHLY_VENDOR_BUDGET_USD.brokerage &&
    MONTHLY_VENDOR_BUDGET_USD.brokerage < MONTHLY_VENDOR_BUDGET_USD.multi_location)
  check("unknown tier falls back to default", vendorBudgetForTier("enterprise_made_up") === DEFAULT_VENDOR_BUDGET)
  check("null tier falls back to default", vendorBudgetForTier(null) === DEFAULT_VENDOR_BUDGET)
}

function testAggregate() {
  console.log("\n[Layer 1 · aggregateBrokerageSpend — platform overview]")
  // NOTE: rows carry `total_cost` — the real ledger column. If this field name
  // drifts, the live layer below catches it against the DB.
  const rows = [
    { brokerage_id: "A", total_cost: 45 },
    { brokerage_id: "A", total_cost: 10 },   // A = 55 (team=200 → ok)
    { brokerage_id: "B", total_cost: 190 },  // B = 190 (team=200 → approaching)
    { brokerage_id: "C", total_cost: 800 },  // C = 800 (team=200 → paused)
    { brokerage_id: null, total_cost: 999 }, // ignored (no brokerage)
  ]
  const brokers = [
    { id: "A", name: "Alpha", plan_tier: "team" },
    { id: "B", name: "Bravo", plan_tier: "team" },
    { id: "C", name: "Charlie", plan_tier: "team" },
  ]
  const agg = aggregateBrokerageSpend(rows, brokers)
  const byId = Object.fromEntries(agg.map((r) => [r.brokerageId, r]))
  check("A summed to 55 and classified ok", byId.A.spent === 55 && byId.A.level === "ok")
  check("B near ceiling → approaching", byId.B.level === "approaching")
  check("C over ceiling → paused", byId.C.level === "paused")
  check("null-brokerage rows excluded", agg.length === 3)
  check("sorted closest-to-limit first (C, B, A)", agg[0].brokerageId === "C" && agg[2].brokerageId === "A")
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — live ledger round-trip (mirrors checkVendorBudget's exact query)
// ─────────────────────────────────────────────────────────────────────────────

async function testLiveLedger() {
  console.log("\n[Layer 2 · live vendor_usage_tracking ledger]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer still ran).")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const VENDOR = `__spendsim_${Date.now()}__`
  const startOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()

  // The exact read checkVendorBudget performs — proves the column name is real.
  async function mtdSpend(brokerageId: string): Promise<number> {
    const { data, error } = await svc.from("vendor_usage_tracking")
      .select("total_cost").eq("brokerage_id", brokerageId).gte("created_at", startOfMonth)
    if (error) throw new Error(`ledger read failed (column drift?): ${error.message}`)
    return (data ?? []).reduce((s, r: any) => s + (Number(r.total_cost) || 0), 0)
  }
  async function seed(brokerageId: string, cost: number) {
    const { error } = await svc.from("vendor_usage_tracking").insert({
      vendor_name: VENDOR, usage_type: "video", units_used: 1, cost_per_unit: cost,
      total_cost: cost, brokerage_id: brokerageId,
    })
    if (error) throw new Error(`seed failed: ${error.message}`)
  }

  try {
    const { data: brk } = await svc.from("brokerages").select("id, plan_tier").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as any).id
    const budget = vendorBudgetForTier((brk as any).plan_tier)

    const baseline = await mtdSpend(brokerageId)
    check("ledger read succeeds on real column (total_cost, not estimated_cost)", baseline >= 0)

    // Seed to ~85% of the remaining headroom → approaching (soft warn, still allowed).
    const toApproaching = Math.max(0, budget * 0.85 - baseline)
    if (toApproaching > 0) await seed(brokerageId, Math.round(toApproaching * 100) / 100)
    const spent1 = await mtdSpend(brokerageId)
    const e1 = evaluateVendorBudget(spent1, budget)
    check("after seeding ~85% → real spend is summed (not 0 — the bug)", spent1 > 0)
    check("~85% of ceiling → soft warning, still allowed", e1.softWarning && e1.allowed)

    // Seed past the ceiling → paused (BLOCKED). This is the protection that was
    // silently disabled while readers summed a non-existent column.
    await seed(brokerageId, budget * 0.5 + 5)
    const spent2 = await mtdSpend(brokerageId)
    const e2 = evaluateVendorBudget(spent2, budget)
    check("over the monthly ceiling → BLOCKED (cap actually enforces now)", e2.allowed === false)
    check("addCost pre-flight would also block a further spend", evaluateVendorBudget(spent2, budget, 0.1).allowed === false)
  } finally {
    // Remove only this run's seeded ledger rows.
    try { await svc.from("vendor_usage_tracking").delete().eq("vendor_name", VENDOR) } catch { /* noop */ }
    const { count } = await svc.from("vendor_usage_tracking").select("id", { count: "exact", head: true }).eq("vendor_name", VENDOR)
    check("cleanup verified — 0 seeded ledger rows remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Spend governance simulator (platform-vendor budget cap)")
  console.log("══════════════════════════════════════════════════")
  testBudgetEval(); testTierBudgets(); testAggregate()
  await testLiveLedger()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Spend governance verified (cap enforces; ledger column drift guarded)")
}
main().catch((e) => { console.error(e); process.exit(1) })
