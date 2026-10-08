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
  // RE-ANCHORED (wave 98, lane 98B — CLAUDE.md §2: assert the RULE, not a waypoint). The count was
  // pinned at 14 and went false the moment a reaper was added; the rule is "every named domain is
  // registered exactly once".
  check("every domain is registered exactly once", new Set(REAPER_NET.map((e) => e.domain)).size === REAPER_NET.length && REAPER_NET.length > 0)
  const domains = REAPER_NET.map((e) => e.domain)
  for (const d of ["stale_video_workflows", "stale_workflow_runs", "stranded_offers", "closing_overdue", "lifetime_touchpoints", "commission_unrecorded", "commission_tracking_drift", "compliance_flags_stuck", "stuck_social_posts", "stuck_marketing_campaigns", "ad_action_unlaunched", "recruit_gone_cold", "cda_undelivered", "manager_handoffs", "unknown_action_outcomes"]) {
    check(`domain present: ${d}`, domains.includes(d))
  }
  check("every entry has a run thunk + protects copy", REAPER_NET.every((e) => typeof e.run === "function" && e.protects.length > 0))
  check("every manager is a real registry key", REAPER_NET.every((e) => !!MANAGERS[e.manager]))

  console.log("\n[lanes partition cleanly — no double-firing]")
  const proactive = REAPER_NET.filter((e) => e.lane === "proactive")
  const signals = REAPER_NET.filter((e) => e.lane === "signals")
  // RE-ANCHORED (wave 98): the signals lane carries the bus-handoff reaper AND the unknown-action
  // settler (both need the 30-minute cadence); the rule is the lane each one is on.
  check("the bus handoff reaper rides the signals lane", signals.some((e) => e.domain === "manager_handoffs"))
  check("the unknown-action settler rides the signals lane (30-min cadence, no new cron)", signals.some((e) => e.domain === "unknown_action_outcomes"))
  // Wave 108C: the OS health supervisor rides its own "health" lane (the manager-signals cron runs it
  // over EVERY tenant — the signals lane only visits tenants with open bus traffic).
  const health = REAPER_NET.filter((e) => e.lane === "health")
  check("the OS health supervisor rides the health lane, owned by cron_manager", health.some((e) => e.domain === "os_health" && e.manager === "cron_manager"))
  check("the health lane carries only the supervisor (no reaper double-fires through it)", health.every((e) => e.domain === "os_health"))
  check("every other reaper is proactive", REAPER_NET.every((e) => e.lane === "proactive" || ["manager_handoffs", "unknown_action_outcomes", "os_health"].includes(e.domain)))
  check("lanes are disjoint (every entry in exactly one lane)", proactive.length + signals.length + health.length === REAPER_NET.length)

  console.log("\n[coverage map is honest]")
  const cov = reaperCoverage()
  // Derived from the live roster rather than pinned (m618: MANAGERS went 14 -> 13
  // when "marketing_agent" was retired — a hardcoded waypoint here would have gone
  // stale silently exactly the way CLAUDE.md §2 warns against).
  const totalManagerCount = Object.keys(MANAGERS).length
  check("totalManagers = the live roster size", cov.totalManagers === totalManagerCount)
  check("covered managers include deal_coordinator (2 domains)", cov.coveredManagers.includes("deal_coordinator"))
  // The RULE, not a waypoint (CLAUDE.md §2): the leak, the status-drift and the
  // amount-drift reapers (wave 104A) are each registered under finance_manager.
  // The literal `=== 2` pinned the wave-37 count and failed the moment 104A added
  // the amount sibling — a count that moves is the finding, not the failure.
  const financeDomains = REAPER_NET.filter((e) => e.manager === "finance_manager").map((e) => e.domain)
  check("finance_manager covers the money reapers (leak + tracking-drift + amount-drift)",
    ["commission_unrecorded", "commission_tracking_drift", "commission_amount_drift"].every((d) => financeDomains.includes(d)))
  // m618: "marketing_agent" retired — its stuck_social_posts domain is now
  // campaign_orchestrator's (already in this list).
  check("covered incl finance + compliance + marketing + ads + recruiting", ["asset_manager", "campaign_orchestrator", "sphere_of_influence", "data_steward", "finance_manager", "compliance_officer", "ads_manager", "recruiting_manager"].every((m) => cov.coveredManagers.includes(m as any)))
  check("retired marketing_agent is not a coverable manager", !("marketing_agent" in MANAGERS))
  check("predictor-backed incl shopping + listing", ["shopping_agent", "listing_concierge"].every((m) => cov.predictorBackedManagers.includes(m as any)))
  check("predictor-backed are NOT double-counted as dedicated", cov.predictorBackedManagers.every((m) => !cov.coveredManagers.includes(m)))
  check("effective coverage = dedicated ∪ predictor-backed", cov.effectiveCoveredManagers.length === new Set([...cov.coveredManagers, ...cov.predictorBackedManagers]).size)
  check("effective + uncovered = the whole live roster (honest, no overlap)", cov.effectiveCoveredManagers.length + cov.uncoveredManagers.length === totalManagerCount)
  // m618: MANAGERS went 14 -> 13 ("marketing_agent" retired) — derive the "all but
  // cron_manager" expectation from the live roster rather than re-pinning the number.
  // Wave 108C — cron_manager is now COVERED: the owner made it the operational-health coordinator and
  // its per-tenant health supervisor (domain os_health, lane health) is a registered net entry. The
  // RULE is "every manager is covered by a dedicated reaper or a predictor chain"; the set of uncovered
  // managers is asserted EMPTY by name below, so any manager losing coverage fails here.
  check("effective coverage is the whole live roster", cov.effectiveCoveredManagers.length === totalManagerCount)
  // TOMBSTONE (wave 108C): the pin "exactly one uncovered manager, and it is cron_manager
  // (platform-scoped by design)" stood here. It was a WAYPOINT — true only until the owner ruled the
  // Cron Manager the operational-health coordinator (wave 108). Platform-wide loop health stays with
  // lib/platform/os-sentinel.ts; the per-TENANT health supervisor is lib/kernel/os-health.ts, registered
  // in REAPER_NET (domain os_health). The rule that survives: no manager is uncovered.
  check(`no manager is uncovered (named set is empty: [${cov.uncoveredManagers.join(", ")}])`, cov.uncoveredManagers.length === 0)
  // POSITIVE CONTROL: the coverage map still reports a manager with no entry as uncovered.
  check("POSITIVE CONTROL: a manager key absent from the net reads as uncovered", !managersUnderReaperCoverage().includes("no_such_manager" as any))
  check("uncovered managers are genuinely unregistered", cov.uncoveredManagers.every((m) => !managersUnderReaperCoverage().includes(m)))
  check("coverage domains list = the registry", cov.domains.length === REAPER_NET.length)

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
  console.log(` ✅ REAPER_NET_PASS — ${REAPER_NET.length} reapers, lanes disjoint, coverage honest, ledger round-trips`)
}
main()
