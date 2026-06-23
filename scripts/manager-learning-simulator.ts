#!/usr/bin/env tsx
/**
 * scripts/manager-learning-simulator.ts  (npm run test:manager-learning)
 *
 * Proves the MANAGER LEARNING LOOP — outcomes feed back into future behavior (a graded team becomes
 * a self-improving one). When a brokerage keeps LOSING deals on financing, the loop writes
 * financing_risk_sensitivity=high, and the Deal-Save Huddle then tightens its lender/earnest-money
 * threshold so the NEXT deal gets earlier financing intervention. THE LOOP CLOSES end to end.
 *
 *  - PURE layer (always): the adjustment derivation (honest — silent below a minimum sample) and the
 *    consumption (the financing threshold tightens routing).
 *  - LIVE layer (creds-gated, self-cleaning): seeds lost-on-financing deals, runs the learning loop,
 *    asserts financing_risk_sensitivity=high is written to brokerage_settings, then runs the
 *    Deal-Save Huddle on a BORDERLINE financing deal (score 80) and asserts it NOW convenes (it
 *    would NOT without the learned signal). Deletes every tagged row (cleanup == 0).
 */
import { randomUUID } from "node:crypto"
import {
  deriveLearnedAdjustments, MIN_LOST_SAMPLE, type OutcomeStats,
} from "../lib/managers/learning-loop"
import { routeFailingComponents, isFailingComponent } from "../lib/kernel/deal-save-huddle"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

const noStrategy = { total: 0, accepted: 0, rejected: 0, countered: 0, avgDeviation: 0 }
const stats = (over: Partial<OutcomeStats>): OutcomeStats => ({ lostByCategory: {}, lostTotal: 0, strategy: noStrategy, ...over })

function pureLayer(): void {
  console.log("\n[derivation · pure — honest, no fabrication on a small sample]")
  const high = deriveLearnedAdjustments(stats({ lostByCategory: { financing: 3, inspection: 1 }, lostTotal: 4 }))
  check("≥30% of ≥4 lost deals on financing ⇒ financing_risk_sensitivity=high",
    high.some((a) => a.manager === "deal_coordinator" && a.key === "financing_risk_sensitivity" && a.value === "high"))
  check(`below MIN_LOST_SAMPLE (${MIN_LOST_SAMPLE}) ⇒ derives nothing`,
    deriveLearnedAdjustments(stats({ lostByCategory: { financing: 2 }, lostTotal: 2 })).length === 0)
  check("financing share under 30% ⇒ no financing adjustment",
    !deriveLearnedAdjustments(stats({ lostByCategory: { financing: 1, inspection: 4 }, lostTotal: 5 })).some((a) => a.key === "financing_risk_sensitivity"))

  const aggressive = deriveLearnedAdjustments(stats({ strategy: { total: 10, accepted: 2, rejected: 5, countered: 3, avgDeviation: 0.06 } }))
  check("high rejection + aggressive deviation ⇒ offer_posture=conservative",
    aggressive.some((a) => a.manager === "shopping_agent" && a.key === "offer_posture" && a.value === "conservative"))
  const winning = deriveLearnedAdjustments(stats({ strategy: { total: 10, accepted: 7, rejected: 1, countered: 2, avgDeviation: 0.01 } }))
  check("≥60% accepted ⇒ offer_posture=data_supported", winning.some((a) => a.key === "offer_posture" && a.value === "data_supported"))
  check("strategy sample < 5 ⇒ no offer adjustment",
    deriveLearnedAdjustments(stats({ strategy: { total: 3, accepted: 0, rejected: 3, countered: 0, avgDeviation: 0.1 } })).length === 0)

  console.log("\n[consumption · pure — the learned signal tightens the financing bar]")
  const lender80 = [{ category: "LENDER", score: 80, issues: [] as string[] }]
  check("LENDER@80 does NOT fail at the normal threshold", !isFailingComponent(lender80[0]))
  check("LENDER@80 FAILS under high financing sensitivity", isFailingComponent(lender80[0], { financingSensitivityHigh: true }))
  check("TITLE@80 is unaffected by financing sensitivity (not a financing component)",
    !isFailingComponent({ category: "TITLE", score: 80, issues: [] }, { financingSensitivityHigh: true }))
  check("routing: borderline financing deal convenes nobody normally", routeFailingComponents(lender80).length === 0)
  check("routing: SAME deal convenes Finance once the loop tightened the bar",
    routeFailingComponents(lender80, { financingSensitivityHigh: true }).some((b) => b.manager === "finance_manager"))
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[manager learning · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the loop")
    return
  }
  console.log("\n[manager learning · live — lost deals → learn → huddle tightens → self-clean]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runManagerLearning, getLearnedAdjustment } = await import("../lib/managers/learning-loop")
  const { runDealSaveHuddle } = await import("../lib/kernel/deal-save-huddle")
  const svc = createServiceClient()

  const tag = `ml-sim-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const newDealId = randomUUID()
  const newDealId2 = randomUUID()
  const lostIds = Array.from({ length: 5 }, () => randomUUID())

  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} (learning test)` })
    // 4 of 5 lost deals died on financing → 80% share, well over threshold.
    const lostAt = new Date(Date.now() - 10 * 86_400_000).toISOString()
    await svc.from("transactions").insert(lostIds.map((id, i) => ({
      id, brokerage_id: brokerageId, deal_name: `${tag} lost ${i}`, status: "lost",
      lost_at: lostAt, lost_category: i < 4 ? "financing" : "inspection",
    })))

    const r = await runManagerLearning(brokerageId, {}, svc)
    check("learning loop derived the financing adjustment", r.adjustments.some((a) => a.key === "financing_risk_sensitivity" && a.value === "high"))
    check("adjustment was written to brokerage_settings", r.written)
    check("getLearnedAdjustment reads back 'high'", (await getLearnedAdjustment(brokerageId, "financing_risk_sensitivity", svc)) === "high")

    // THE LOOP CLOSING — a NEW deal with a BORDERLINE lender component (80, no issues) that would
    // NOT convene the huddle normally now DOES, because this brokerage learned to watch financing.
    await svc.from("transactions").insert({ id: newDealId, brokerage_id: brokerageId, deal_name: `${tag} next deal`, status: "active" })
    const huddle = await runDealSaveHuddle({
      transactionId: newDealId, brokerageId, riskLevel: "critical",
      components: [{ category: "LENDER", score: 80, issues: [] }],
      dealName: `${tag} next deal`,
    }, svc)
    check("the learned signal made the huddle convene on a borderline financing deal", huddle.convened)
    check("Finance was delegated earlier (loop closed: past losses → future behavior)", huddle.delegatedTo.includes("finance_manager"))

    // HUMAN OFF-SWITCH — the broker vetoes the learned behavior; it disappears at the single read
    // chokepoint, so a fresh borderline deal NO LONGER convenes the huddle.
    const { setLearnedAdjustmentVeto, listLearnedAdjustments } = await import("../lib/managers/learning-loop")
    await setLearnedAdjustmentVeto(brokerageId, "financing_risk_sensitivity", true, svc)
    check("veto makes getLearnedAdjustment return null (off-switch at the chokepoint)",
      (await getLearnedAdjustment(brokerageId, "financing_risk_sensitivity", svc)) === null)
    const list = await listLearnedAdjustments(brokerageId, svc)
    check("listLearnedAdjustments surfaces the adjustment with its veto state (broker visibility)",
      list.some((a) => a.key === "financing_risk_sensitivity" && a.vetoed && a.manager === "deal_coordinator"))
    await svc.from("transactions").insert({ id: newDealId2, brokerage_id: brokerageId, deal_name: `${tag} vetoed deal`, status: "active" })
    const vetoedHuddle = await runDealSaveHuddle({
      transactionId: newDealId2, brokerageId, riskLevel: "critical",
      components: [{ category: "LENDER", score: 80, issues: [] }], dealName: `${tag} vetoed deal`,
    }, svc)
    check("with the adjustment vetoed, the SAME borderline deal no longer convenes the huddle", !vetoedHuddle.convened)
    await setLearnedAdjustmentVeto(brokerageId, "financing_risk_sensitivity", false, svc) // restore
  } finally {
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId)
    await svc.from("transaction_tasks").delete().in("transaction_id", [newDealId, newDealId2])
    await svc.from("transactions").delete().eq("brokerage_id", brokerageId)
    await svc.from("brokerage_settings").delete().eq("brokerage_id", brokerageId)
    await svc.from("brokerages").delete().eq("id", brokerageId)
    const { count } = await svc.from("transactions").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
    check("cleanup complete — zero tagged rows remain", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ MANAGER_LEARNING_FAIL"); process.exit(1) }
  console.log(" ✅ MANAGER_LEARNING_PASS — outcomes tune future behavior; the loop closes end to end")
}

main().catch((e) => { console.error(e); process.exit(1) })
