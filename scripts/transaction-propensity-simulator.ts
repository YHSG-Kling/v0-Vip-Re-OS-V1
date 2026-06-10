#!/usr/bin/env tsx
/**
 * scripts/transaction-propensity-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SIGNAL FUSION (AI ISA transaction propensity) harness.
 *
 * Layer 1 (pure): computeTransactionPropensity — weighted fusion, band thresholds,
 *   decay curves (life event / recency), equity saturation, top-reason selection, and
 *   the all-cold floor.
 * Layer 2 (live, gated): seed a high-signal contact + a low-signal contact, rank them,
 *   assert the high-signal contact outranks the low one and lands in a warm/hot band,
 *   then clean up.
 *
 * Run: npx tsx scripts/transaction-propensity-simulator.ts  (npm run test:propensity)
 */
import { computeTransactionPropensity, rankContactsByPropensity } from "../lib/ai-isa/transaction-propensity"

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
  console.log(" ✅ Transaction propensity (signal fusion) verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Transaction propensity (signal fusion) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · computeTransactionPropensity]")
  const allCold = computeTransactionPropensity({ intentScore: 0, engagementScore: 0, equityEstimate: 0, lifeEventDaysAgo: null, referralScore: 0, lastActivityDaysAgo: null })
  check("all-zero signals → score 0 / cold", allCold.score === 0 && allCold.band === "cold")
  check("all-zero → no reasons fired", allCold.topReasons.length === 0)

  const hot = computeTransactionPropensity({ intentScore: 95, engagementScore: 90, equityEstimate: 500_000, lifeEventDaysAgo: 5, referralScore: 80, lastActivityDaysAgo: 2 })
  check("max signals → hot band", hot.band === "hot")
  check("max signals → high score (>= 90)", hot.score >= 90)
  check("hot reasons name the top contributors (intent first)", hot.topReasons[0] === "high buying/selling intent")

  // Decay: a 6-month-old life event contributes ~0; a fresh one a lot.
  const fresh = computeTransactionPropensity({ intentScore: 0, engagementScore: 0, equityEstimate: 0, lifeEventDaysAgo: 0, referralScore: 0, lastActivityDaysAgo: null })
  const stale = computeTransactionPropensity({ intentScore: 0, engagementScore: 0, equityEstimate: 0, lifeEventDaysAgo: 180, referralScore: 0, lastActivityDaysAgo: null })
  check("fresh life event scores higher than a 6-month-old one", fresh.score > stale.score)
  check("6-month-old life event has fully decayed (score 0)", stale.score === 0)

  // Equity saturation: 1M reads the same as 500k (capped).
  const eq500 = computeTransactionPropensity({ intentScore: 0, engagementScore: 0, equityEstimate: 500_000, lifeEventDaysAgo: null, referralScore: 0, lastActivityDaysAgo: null })
  const eq1m = computeTransactionPropensity({ intentScore: 0, engagementScore: 0, equityEstimate: 1_000_000, lifeEventDaysAgo: null, referralScore: 0, lastActivityDaysAgo: null })
  check("equity saturates at $500k (1M == 500k)", eq500.score === eq1m.score && eq500.score > 0)

  // Band thresholds.
  check("band: 75 → hot", computeTransactionPropensity({ intentScore: 100, engagementScore: 100, equityEstimate: 500_000, lifeEventDaysAgo: 0, referralScore: 100, lastActivityDaysAgo: 0 }).band === "hot")
  // Fusion discipline: a SINGLE signal can't warm a contact — intent 60 alone = 18 pts = cold.
  check("band: one signal alone stays cold (fusion needs corroboration)",
    computeTransactionPropensity({ intentScore: 60, engagementScore: 0, equityEstimate: 0, lifeEventDaysAgo: null, referralScore: 0, lastActivityDaysAgo: null }).band === "cold")
  // But intent + engagement + recency together cross into warm.
  check("band: intent + engagement + recency together → warm",
    computeTransactionPropensity({ intentScore: 80, engagementScore: 70, equityEstimate: 0, lifeEventDaysAgo: null, referralScore: 0, lastActivityDaysAgo: 3 }).band === "warm")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live ranking]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__propsim_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — need a brokerage."); report(); return }
    const brokerageId = (brk as any).id

    const { data: hotC } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Hot", last_name: TAG,
      intent_score: 95, engagement_score: 90, equity_estimate: 500_000, referral_score: 70,
      last_life_event_detected: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (hotC as any).id })
    const { data: coldC } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Cold", last_name: TAG,
      intent_score: 5, engagement_score: 0, equity_estimate: 0, referral_score: 0,
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (coldC as any).id })

    const ranked = await rankContactsByPropensity({ brokerageId, limit: 4000 }, svc)
    const hotRank = ranked.findIndex((r) => r.contactId === (hotC as any).id)
    const coldRank = ranked.findIndex((r) => r.contactId === (coldC as any).id)
    check("live: high-signal contact is ranked", hotRank >= 0)
    check("live: high-signal outranks low-signal", hotRank >= 0 && (coldRank < 0 || hotRank < coldRank))
    const hotEntry = ranked.find((r) => r.contactId === (hotC as any).id)
    check("live: high-signal contact is warm/hot", ["warm", "hot"].includes(hotEntry?.result.band ?? ""))
    check("live: ranked entry carries top reasons", (hotEntry?.result.topReasons.length ?? 0) > 0)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("last_name", `${TAG}%`)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
