#!/usr/bin/env tsx
/**
 * scripts/coordination-kind-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the manager-coordination feed renders the NEGOTIATION: classifyCoordination buckets each
 * inter-manager signal_type into deferral / handoff / escalation / alert / update so the Command
 * Center shows "the team working together" instead of a flat log. Pure + shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/coordination-kind-simulator.ts   (npm run test:coordination-kind)
 */
import { classifyCoordination } from "../lib/kernel/coordination-kind"

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
  console.log(" ✅ Coordination kind verified — deferral/handoff/escalation/alert distinguished.")
  console.log(" COORDINATION_KIND_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Coordination kind classifier simulator")
  console.log("══════════════════════════════════════════════════\n")

  // Deferral — a manager yielded a channel (the "negotiation" the user wants visible).
  check("first_touch_deferred → deferral", classifyCoordination("first_touch_deferred") === "deferral")
  // Handoff — work/asset routed between managers.
  check("first_touch_claimed → handoff", classifyCoordination("first_touch_claimed") === "handoff")
  check("video_ready → handoff", classifyCoordination("video_ready") === "handoff")
  check("stale_preapproval_reengage → handoff", classifyCoordination("stale_preapproval_reengage") === "handoff")
  // Escalation — needs attention now.
  check("fire_drill_opened → escalation", classifyCoordination("fire_drill_opened") === "escalation")
  check("agent_overloaded → escalation", classifyCoordination("agent_overloaded") === "escalation")
  check("bidding_war_convened → escalation", classifyCoordination("bidding_war_convened") === "escalation")
  // Alert — compliance/quality flag.
  check("video_compliance_failed → alert", classifyCoordination("video_compliance_failed") === "alert")
  check("regulatory_change_detected → alert", classifyCoordination("regulatory_change_detected") === "alert")
  // Default.
  check("unknown signal → update", classifyCoordination("something_new") === "update")
  check("null/empty → update (never throws)", classifyCoordination(null) === "update" && classifyCoordination("") === "update")

  report()
}

main()
