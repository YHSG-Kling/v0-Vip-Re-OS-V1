#!/usr/bin/env tsx
/**
 * scripts/agent-scorecard-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AGENT SCORECARD harness (agent-management capstone).
 *
 * Layer 1 (pure): completionPct (null when nothing assigned) + avgOrNull.
 * Layer 2 (live, gated): seed a closed deal + an active deal (health) + a couple of
 *   learning assignments + a recruiting ROI row for one agent, read back through
 *   generateAgentScorecards, assert the production / deal-health / education / recruiting
 *   columns for that agent, then clean up.
 *
 * Run: npx tsx scripts/agent-scorecard-simulator.ts  (npm run test:agent-scorecard)
 */
import { completionPct, avgOrNull, generateAgentScorecards } from "../lib/intelligence/agent-scorecard"

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
  console.log(" ✅ Agent Scorecard verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Agent Scorecard simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure]")
  check("completionPct: 1 of 4 → 25%", completionPct(4, 1) === 25)
  check("completionPct: null when nothing assigned", completionPct(0, 0) === null)
  check("avgOrNull: [80,90,100] → 90", avgOrNull([80, 90, 100]) === 90)
  check("avgOrNull: null when empty", avgOrNull([]) === null)

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
  const TAG = `__scoresim_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("brokerage_id", "is", null).not("user_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent with a user."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentId = (agent as any).id
    const userId = (agent as any).user_id
    const { data: con } = await svc.from("contacts").select("id").eq("brokerage_id", brokerageId).limit(1).single()
    const contactId = (con as any)?.id ?? null

    // Closed deal (GCI 15000) + active deal (health 80).
    const { data: closed } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, agent_id: agentId, contact_id: contactId, deal_name: `${TAG} closed`,
      deal_type: "buyer", status: "closed", stage: "CLOSED", property_address: `${TAG} closed Ave`,
      commission_amount: 15000, close_date: new Date().toISOString().slice(0, 10),
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (closed as any).id })
    const { data: active } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, agent_id: agentId, contact_id: contactId, deal_name: `${TAG} active`,
      deal_type: "buyer", status: "active", stage: "UNDER_CONTRACT", property_address: `${TAG} active Ave`,
      health_score: 80,
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (active as any).id })

    // Education: 1 of 2 completed (one assignment per module — uq_la_agent_module).
    for (const st of ["completed", "open"]) {
      const { data: mod } = await svc.from("learning_modules").insert({
        brokerage_id: brokerageId, title: `${TAG} mod ${st}`, status: "published", stage_tags: [], audience_personas: [],
      }).select("id").single()
      cleanup.push({ table: "learning_modules", id: (mod as any).id })
      const { data: la } = await svc.from("learning_assignments").insert({
        brokerage_id: brokerageId, module_id: (mod as any).id, agent_user_id: userId, status: st, signal_source: "test",
      }).select("id").single()
      cleanup.push({ table: "learning_assignments", id: (la as any).id })
    }

    // Recruiting ROI for this agent.
    const { data: roi } = await svc.from("recruiting_roi").insert({
      brokerage_id: brokerageId, recruited_agent_id: agentId, total_recruiting_cost: 4000,
      lifetime_brokerage_net: 16000, roi_pct: 300,
    }).select("id").single()
    cleanup.push({ table: "recruiting_roi", id: (roi as any).id })

    const cards = await generateAgentScorecards({ brokerageId }, svc)
    const card = cards.find((c) => c.agentId === agentId)
    check("scorecard: the seeded agent is present", !!card)
    check("production: YTD GCI includes 15000", (card?.ytdGci ?? 0) >= 15000)
    check("production: at least 1 closing", (card?.closings ?? 0) >= 1)
    check("health: active deal counted + avg health present", (card?.activeDeals ?? 0) >= 1 && card?.avgHealthScore != null)
    check("education: assigned >= 2, completed >= 1", (card?.lessonsAssigned ?? 0) >= 2 && (card?.lessonsCompleted ?? 0) >= 1)
    check("education: completion % computed", card?.educationCompletionPct != null)
    check("recruiting: ROI surfaced (300%) + lifetime net 16000", card?.recruitingRoiPct === 300 && card?.recruitingLifetimeNet === 16000)
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
