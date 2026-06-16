#!/usr/bin/env tsx
/**
 * scripts/health-lifecycle-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves HEALTH-TRIGGERED LIFECYCLE PLAYS: a relationship decaying to at-risk/dormant hands the
 * MATCHED manager the right re-engagement (slipping past client → Sphere win-back; stalling buyer →
 * Shopping Agent; quiet seller → Listing Concierge), urgency escalating when dormant. Healthy/cooling
 * need no play. Pure + shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/health-lifecycle-simulator.ts   (npm run test:health-lifecycle)
 */
import { lifecyclePlayForHealth } from "../lib/intelligence/health-lifecycle-play"

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
  console.log(" ✅ Health lifecycle plays verified — decaying relationships routed to the right manager.")
  console.log(" HEALTH_LIFECYCLE_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Health-triggered lifecycle plays simulator")
  console.log("══════════════════════════════════════════════════\n")

  // Healthy / cooling → no special play (the cadence has it).
  check("thriving → no play", lifecyclePlayForHealth("thriving", "buyer").play === null)
  check("cooling → no play (cadence covers)", lifecyclePlayForHealth("cooling", "seller").play === null)

  // At-risk routes to the manager matched to WHO they are.
  check("at-risk past client → Sphere win-back", (() => { const p = lifecyclePlayForHealth("at_risk", "past_client"); return p.manager === "sphere_of_influence" && /sphere_winback/.test(p.play ?? "") })())
  check("at-risk buyer → Shopping Agent", (() => { const p = lifecyclePlayForHealth("at_risk", "buyer"); return p.manager === "shopping_agent" && /buyer_reengage/.test(p.play ?? "") })())
  check("at-risk seller → Listing Concierge", (() => { const p = lifecyclePlayForHealth("at_risk", "seller"); return p.manager === "listing_concierge" && /seller_reengage/.test(p.play ?? "") })())
  check("at-risk unknown/lead → AI ISA", lifecyclePlayForHealth("at_risk", null).manager === "ai_isa")

  // Dormant escalates urgency + marks a last-attempt play.
  const dormant = lifecyclePlayForHealth("dormant", "buyer")
  check("dormant → urgency 'now' + last_attempt play", dormant.urgency === "now" && /last_attempt/.test(dormant.play ?? ""))
  check("at-risk urgency is 'soon'", lifecyclePlayForHealth("at_risk", "buyer").urgency === "soon")

  report()
}

main()
