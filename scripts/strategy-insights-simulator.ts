#!/usr/bin/env tsx
/**
 * scripts/strategy-insights-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * STRATEGY-LEARNING READ SIDE harness — proves accumulated strategy_outcomes fold
 * into market intelligence + a recommender-ready prompt context.
 *
 * Layer 1 (pure): computeStrategyInsights — win rate, avg accepted deviation,
 *   per-strategy-type breakdown, and the prompt context (incl. the empty-history line).
 * Layer 2 (live, gated): seed recommendations + outcomes, read them back through
 *   generateStrategyInsights, assert the aggregates + that the context names the
 *   winning strategy, then clean up.
 *
 * Run: npx tsx scripts/strategy-insights-simulator.ts  (npm run test:strategy-insights)
 */
import { computeStrategyInsights, generateStrategyInsights } from "../lib/strategy-learning/strategy-insights"

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
  console.log(" ✅ Strategy-learning read side verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Strategy-learning read side (insights) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · computeStrategyInsights]")
  const empty = computeStrategyInsights([], 90)
  check("empty: sampleSize 0", empty.sampleSize === 0)
  check("empty: winRate null", empty.winRate === null)
  check("empty: prompt context says no history", /no prior/i.test(empty.promptContext))

  const rows = [
    { outcome: "accepted", deviation_from_recommendation: 4000, recommendation_id: "r1", strategyType: "aggressive" },
    { outcome: "accepted", deviation_from_recommendation: 6000, recommendation_id: "r2", strategyType: "aggressive" },
    { outcome: "rejected", deviation_from_recommendation: null, recommendation_id: "r3", strategyType: "conservative" },
    { outcome: "accepted", deviation_from_recommendation: 2000, recommendation_id: "r4", strategyType: "standard" },
    { outcome: "countered", deviation_from_recommendation: null, recommendation_id: "r5", strategyType: "standard" },
  ]
  const ins = computeStrategyInsights(rows, 90)
  check("sample size = 5", ins.sampleSize === 5)
  // decisive = accepted(3) + rejected(1) = 4 → winRate 3/4 = 0.75
  check("overall win rate = 0.75 (3 accepted / 4 decisive)", ins.winRate === 0.75)
  // accepted deviations [4000,6000,2000] → avg 4000
  check("avg accepted deviation = 4000", ins.avgAcceptedDeviation === 4000)
  check("outcome counts tallied", ins.outcomeCounts.accepted === 3 && ins.outcomeCounts.rejected === 1 && ins.outcomeCounts.countered === 1)
  // aggressive: 2/2 accepted → winRate 1.0, sorts first
  check("aggressive sorts first with 100% win rate", ins.byStrategyType[0].type === "aggressive" && ins.byStrategyType[0].winRate === 1)
  check("conservative win rate = 0 (0 accepted / 1 rejected)", ins.byStrategyType.find((s) => s.type === "conservative")?.winRate === 0)
  check("prompt context names a winning strategy", /aggressive/.test(ins.promptContext) && /acceptance rate/.test(ins.promptContext))

  // strategy_outcomes.notes — written by every closer, read by nothing until w26.
  const noted = computeStrategyInsights([
    { outcome: "rejected", deviation_from_recommendation: null, recommendation_id: "n1", strategyType: "standard", notes: "Seller took a cash offer $10k lower — speed beat price here." },
    { outcome: "accepted", deviation_from_recommendation: 1000, recommendation_id: "n2", strategyType: "standard", notes: "Auto-closed on offer accepted" },
    { outcome: "accepted", deviation_from_recommendation: 1000, recommendation_id: "n3", strategyType: "standard", notes: "Seller took a cash offer $10k lower — speed beat price here." },
    { outcome: "countered", deviation_from_recommendation: null, recommendation_id: "n4", strategyType: "standard", notes: "   " },
    { outcome: "withdrawn", deviation_from_recommendation: null, recommendation_id: "n5", strategyType: "standard" },
  ], 90)
  check("human note surfaces", noted.recentNotes.length === 1 && /speed beat price/.test(noted.recentNotes[0]))
  check("auto-close template is NOT a human note", !noted.recentNotes.some((n) => /Auto-closed/.test(n)))
  check("duplicate notes collapse to one", noted.recentNotes.length === 1)
  check("blank + absent notes are not counted", noted.notesRecorded === 3)
  // POSITIVE CONTROL: the filter must still let an auto-close row COUNT (it carries a
  // note) while keeping it out of the human list — a filter that dropped both would
  // report the same empty list on a corpus that has real notes.
  check("auto-close row still counts toward notesRecorded", noted.notesRecorded > noted.recentNotes.length)
  check("no notes at all → empty list AND zero denominator", ins.recentNotes.length === 0 && ins.notesRecorded === 0)

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live aggregation]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__insightsim_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: lst } = await svc.from("listings").select("id, brokerage_id").not("brokerage_id", "is", null).limit(1).single()
    if (!lst) { console.log("  ⏭  Skipped — need a listing."); report(); return }
    const brokerageId = (lst as any).brokerage_id
    const { data: con } = await svc.from("contacts").select("id").eq("brokerage_id", brokerageId).limit(1).single()
    if (!con) { console.log("  ⏭  Skipped — need a contact."); report(); return }

    // Two aggressive recommendations that both got accepted (deviation 3k, 5k).
    const recIds: string[] = []
    for (let i = 0; i < 2; i++) {
      const { data: rec } = await svc.from("strategy_recommendations").insert({
        brokerage_id: brokerageId, contact_id: (con as any).id, listing_id: (lst as any).id,
        recommended_price: 500000, status: "accepted", ai_narrative: `${TAG} rec ${i}`,
        ai_analysis: { strategy_type: "aggressive" },
      }).select("id").single()
      recIds.push((rec as any).id)
      cleanup.push({ table: "strategy_recommendations", id: (rec as any).id })
      const { data: oc } = await svc.from("strategy_outcomes").insert({
        brokerage_id: brokerageId, recommendation_id: (rec as any).id, offer_id: null,
        outcome: "accepted", final_price: 500000 + (i === 0 ? 3000 : 5000),
        deviation_from_recommendation: i === 0 ? 3000 : 5000, notes: `${TAG} outcome ${i}`,
      }).select("id").single()
      cleanup.push({ table: "strategy_outcomes", id: (oc as any).id })
    }

    const insights = await generateStrategyInsights({ brokerageId, windowDays: 90 }, svc)
    check("live: sample includes the 2 seeded outcomes", insights.sampleSize >= 2)
    check("live: aggressive strategy present in breakdown", insights.byStrategyType.some((s) => s.type === "aggressive"))
    check("live: prompt context is non-empty + outcome-grounded", insights.promptContext.length > 0 && /prior offer outcome/i.test(insights.promptContext))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("strategy_outcomes").select("id", { count: "exact", head: true }).like("notes", `${TAG}%`)
    check("cleanup verified — 0 seeded outcomes remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
