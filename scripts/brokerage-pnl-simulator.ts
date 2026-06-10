#!/usr/bin/env tsx
/**
 * scripts/brokerage-pnl-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BROKERAGE OWNER'S REPORT (P&L) harness.
 *
 * Layer 1 (pure): rollupSplits (company dollar vs agent payouts) + blendedRoi
 *   (null when no cost basis).
 * Layer 2 (live, gated): seed closed transactions + commission splits + a recruiting
 *   ROI row + a referral partner, run generateBrokeragePnl, assert GCI / company dollar
 *   / per-agent production / recruiting ROI / referral value, then clean up.
 *
 * Run: npx tsx scripts/brokerage-pnl-simulator.ts  (npm run test:brokerage-pnl)
 */
import { rollupSplits, blendedRoi, generateBrokeragePnl } from "../lib/intelligence/brokerage-pnl"

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
  console.log(" ✅ Brokerage Owner's Report verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Brokerage Owner's Report (P&L) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure rollups]")
  const rolled = rollupSplits([
    { brokerage_amount: 4000, agent_amount: 8000 },
    { brokerage_amount: 2000, agent_amount: 6000 },
    { brokerage_amount: null, agent_amount: null },
  ])
  check("rollupSplits: company dollar = 6000", rolled.brokerageNet === 6000)
  check("rollupSplits: agent payouts = 14000", rolled.agentPayouts === 14000)
  check("blendedRoi: (30000-10000)/10000 = 200%", blendedRoi(10000, 30000) === 200)
  check("blendedRoi: null when no cost basis", blendedRoi(0, 5000) === null)
  check("blendedRoi: negative when underwater", blendedRoi(10000, 4000) === -60)

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
  const TAG = `__pnlsim_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, brokerage_id").not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentId = (agent as any).id
    const { data: con } = await svc.from("contacts").select("id").eq("brokerage_id", brokerageId).limit(1).single()
    const contactId = (con as any)?.id ?? null

    // Two closed deals this year: GCI 12000 + 8000 = 20000.
    const txnIds: string[] = []
    for (const amt of [12000, 8000]) {
      const { data: t } = await svc.from("transactions").insert({
        brokerage_id: brokerageId, agent_id: agentId, contact_id: contactId,
        deal_name: `${TAG} deal ${amt}`, deal_type: "buyer", status: "closed", stage: "CLOSED",
        property_address: `${TAG} ${amt} Ave`, commission_amount: amt, close_date: new Date().toISOString().slice(0, 10),
      }).select("id").single()
      txnIds.push((t as any).id)
      cleanup.push({ table: "transactions", id: (t as any).id })
      // Split: 30% company dollar.
      const { data: s } = await svc.from("commission_splits").insert({
        brokerage_id: brokerageId, agent_id: agentId, transaction_id: (t as any).id,
        brokerage_amount: amt * 0.3, agent_amount: amt * 0.7, status: "paid",
      }).select("id").single()
      cleanup.push({ table: "commission_splits", id: (s as any).id })
    }

    // Recruiting ROI: cost 5000, lifetime net 20000 → ROI 300%.
    const { data: roi } = await svc.from("recruiting_roi").insert({
      brokerage_id: brokerageId, recruited_agent_id: agentId,
      total_recruiting_cost: 5000, lifetime_brokerage_net: 20000, roi_pct: 300,
    }).select("id").single()
    cleanup.push({ table: "recruiting_roi", id: (roi as any).id })

    // Referral partner with value generated.
    const { data: partner } = await svc.from("referral_partners").insert({
      brokerage_id: brokerageId, agent_id: agentId, partner_name: `${TAG} Partner`,
      partner_type: "mortgage_broker", total_value_generated: 9000, active: true,
    }).select("id").single()
    cleanup.push({ table: "referral_partners", id: (partner as any).id })

    const pnl = await generateBrokeragePnl({ brokerageId }, svc)
    check("revenue: GCI includes the 20000 seeded", pnl.revenue.gci >= 20000)
    check("revenue: closings counted (>= 2)", pnl.revenue.closings >= 2)
    check("revenue: company dollar includes 6000 (30% of 20000)", pnl.revenue.brokerageNet >= 6000)
    check("revenue: agent payouts include 14000", pnl.revenue.agentPayouts >= 14000)
    check("byAgent: seeded agent present with production", pnl.byAgent.some((a) => a.agentId === agentId && a.gci >= 20000))
    check("recruiting: cost + lifetime net rolled up", pnl.recruiting.totalRecruitingCost >= 5000 && pnl.recruiting.lifetimeBrokerageNet >= 20000)
    check("recruiting: blended ROI computed (>= reasonable)", pnl.recruiting.blendedRoiPct !== null)
    check("referrals: partner value generated includes 9000", pnl.referrals.partnerValueGenerated >= 9000)
    check("referrals: at least one active partner", pnl.referrals.activePartners >= 1)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("transactions").select("id", { count: "exact", head: true }).like("property_address", `${TAG}%`)
    check("cleanup verified — 0 seeded transactions remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
