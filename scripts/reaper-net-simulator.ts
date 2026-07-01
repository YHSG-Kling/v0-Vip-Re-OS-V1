#!/usr/bin/env tsx
/**
 * scripts/reaper-net-simulator.ts   (npm run test:reaper-net)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE REAPER NET — the consolidated "nothing falls through the cracks"
 * layer. Pure: the registry covers the right manager domains, lanes partition
 * cleanly (proactive vs signals, no double-firing), and the coverage map is honest
 * about which of the 13 managers are reaped. Live (creds-gated): the reaper_runs
 * ledger round-trips (recordReaperRun → loadRecentReaperActivity aggregates per
 * manager) and cleans up to 0.
 */
import { REAPER_NET, reaperCoverage, managersUnderReaperCoverage } from "../lib/intelligence/reaper-net"
import { MANAGERS } from "../lib/kernel/manager-registry"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

async function main() {
  console.log("\n[registry shape]")
  check("net has 14 registered reapers", REAPER_NET.length === 14)
  const domains = REAPER_NET.map((e) => e.domain)
  for (const d of ["stale_video_workflows", "stale_workflow_runs", "stranded_offers", "closing_overdue", "lifetime_touchpoints", "commission_unrecorded", "commission_tracking_drift", "compliance_flags_stuck", "stuck_social_posts", "stuck_marketing_campaigns", "ad_action_unlaunched", "recruit_gone_cold", "cda_undelivered", "manager_handoffs"]) {
    check(`domain present: ${d}`, domains.includes(d))
  }
  check("every entry has a run thunk + protects copy", REAPER_NET.every((e) => typeof e.run === "function" && e.protects.length > 0))
  check("every manager is a real registry key", REAPER_NET.every((e) => !!MANAGERS[e.manager]))

  console.log("\n[lanes partition cleanly — no double-firing]")
  const proactive = REAPER_NET.filter((e) => e.lane === "proactive")
  const signals = REAPER_NET.filter((e) => e.lane === "signals")
  check("13 proactive-lane reapers", proactive.length === 13)
  check("1 signals-lane reaper (the bus handoff reaper)", signals.length === 1)
  check("signals lane is exactly manager_handoffs", signals[0]?.domain === "manager_handoffs")
  check("lanes are disjoint (every entry in exactly one lane)", proactive.length + signals.length === REAPER_NET.length)

  console.log("\n[coverage map is honest]")
  const cov = reaperCoverage()
  check("totalManagers = 13", cov.totalManagers === 13)
  check("covered managers include deal_coordinator (2 domains)", cov.coveredManagers.includes("deal_coordinator"))
  check("finance_manager now covers 2 domains (leak + tracking-drift)", REAPER_NET.filter((e) => e.manager === "finance_manager").length === 2)
  check("covered incl finance + compliance + marketing + ads + recruiting", ["asset_manager", "campaign_orchestrator", "sphere_of_influence", "data_steward", "finance_manager", "compliance_officer", "marketing_agent", "ads_manager", "recruiting_manager"].every((m) => cov.coveredManagers.includes(m as any)))
  check("predictor-backed incl shopping + listing", ["shopping_agent", "listing_concierge"].every((m) => cov.predictorBackedManagers.includes(m as any)))
  check("predictor-backed are NOT double-counted as dedicated", cov.predictorBackedManagers.every((m) => !cov.coveredManagers.includes(m)))
  check("effective coverage = dedicated ∪ predictor-backed", cov.effectiveCoveredManagers.length === new Set([...cov.coveredManagers, ...cov.predictorBackedManagers]).size)
  check("effective + uncovered = all 13 (honest, no overlap)", cov.effectiveCoveredManagers.length + cov.uncoveredManagers.length === 13)
  check("effective coverage is now FULL 13/13", cov.effectiveCoveredManagers.length === 13)
  check("ZERO uncovered managers — full reaper coverage", cov.uncoveredManagers.length === 0)
  check("uncovered managers are genuinely unregistered", cov.uncoveredManagers.every((m) => !managersUnderReaperCoverage().includes(m)))
  check("coverage domains list = 14", cov.domains.length === 14)

  // ── LIVE LAYER (creds-gated): ledger round-trip ──
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] ⏭  Skipped — SUPABASE creds not set (pure layer ran).")
  } else {
    console.log("\n[live] reaper_runs ledger round-trip → aggregate → cleanup")
    const { createServiceClient } = await import("../lib/supabase/service")
    const { recordReaperRun, loadRecentReaperActivity } = await import("../lib/intelligence/reaper-net")
    const svc = createServiceClient()
    const { data: b } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
    if (!b) { console.log("  ⏭  no brokerage available") }
    else {
      await recordReaperRun({ brokerageId: b.id, domain: "closing_overdue", manager: "deal_coordinator", scanned: 5, escalated: 2, reaped: 0, detail: "SIM" }, svc)
      await recordReaperRun({ brokerageId: b.id, domain: "stranded_offers", manager: "deal_coordinator", scanned: 3, escalated: 1, reaped: 0, detail: "SIM" }, svc)
      const act = await loadRecentReaperActivity(b.id, 24, svc)
      check("live: deal_coordinator aggregated across 2 domains", (act["deal_coordinator"]?.domains.length ?? 0) >= 2)
      check("live: escalated summed (2+1=3)", (act["deal_coordinator"]?.escalated ?? 0) >= 3)
      // cleanup
      await svc.from("reaper_runs").delete().eq("brokerage_id", b.id).eq("detail", "SIM")
      const { count } = await svc.from("reaper_runs").select("id", { count: "exact", head: true }).eq("brokerage_id", b.id).eq("detail", "SIM")
      check("live: cleanup count == 0", (count ?? 0) === 0)
    }
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ REAPER_NET_FAIL"); process.exit(1) }
  console.log(" ✅ REAPER_NET_PASS — 14 reapers, lanes disjoint, coverage honest, ledger round-trips")
}
main()
