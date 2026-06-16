#!/usr/bin/env tsx
/**
 * scripts/second-opinion-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves CROSS-MANAGER SECOND OPINION: before a strategic play, the owning manager asks the
 * complementary manager to weigh in (re-list/price-drop → Shopping Agent's buyer-demand read; offer
 * → Deal Coordinator). Routine plays skip the huddle. Turns the coordination rails into better
 * decisions.
 *
 * Layer 1 (shell, pure): secondOpinionFor mapping. Layer 2 (live, creds-gated): a strategic play
 * raises a second_opinion_requested signal to the right manager, idempotently.
 *
 * Run: npx tsx scripts/second-opinion-simulator.ts   (npm run test:second-opinion)
 */
import { secondOpinionFor, SECOND_OPINION_PLAYS } from "../lib/kernel/second-opinion"

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
  console.log(" ✅ Second opinion verified — strategic plays huddle with the right manager; routine skips.")
  console.log(" SECOND_OPINION_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Cross-manager second opinion simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · secondOpinionFor]")
  check("re-list pitch → consult Shopping Agent (buyer demand)", secondOpinionFor("relist_recovery").consult === "shopping_agent")
  check("price drop → consult Shopping Agent", secondOpinionFor("price_drop").consult === "shopping_agent")
  check("offer strategy → consult Deal Coordinator", secondOpinionFor("offer_strategy").consult === "deal_coordinator")
  check("referral ask → consult Sphere", secondOpinionFor("sphere_referral_ask").consult === "sphere_of_influence")
  check("routine play → no second opinion", !secondOpinionFor("reactivation_email").needed && secondOpinionFor("reactivation_email").consult === null)
  check("null/empty → no second opinion (never throws)", !secondOpinionFor(null).needed && !secondOpinionFor("").needed)
  check("every listed play maps to a manager", SECOND_OPINION_PLAYS.every((p) => secondOpinionFor(p).consult !== null))

  console.log("\n[Layer 2 · live: a strategic play raises a huddle signal]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { requestSecondOpinion } = await import("../lib/kernel/second-opinion-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const contactId = uuid()
  try {
    const r1 = await requestSecondOpinion({ brokerageId, fromManager: "listing_concierge", playType: "relist_recovery", contactId }, svc)
    check("strategic play requested a second opinion to shopping_agent", r1.requested && r1.consult === "shopping_agent", JSON.stringify(r1))
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("contact_id", contactId).eq("signal_type", "second_opinion_requested").eq("to_manager", "shopping_agent")
    check("a second_opinion_requested signal exists to shopping_agent", (count ?? 0) >= 1)
    const r2 = await requestSecondOpinion({ brokerageId, fromManager: "listing_concierge", playType: "relist_recovery", contactId }, svc)
    check("re-request idempotent (no duplicate huddle)", r2.requested === false)
    const routine = await requestSecondOpinion({ brokerageId, fromManager: "ai_isa", playType: "reactivation_email", contactId }, svc)
    check("routine play raises nothing", routine.requested === false)
  } finally {
    await svc.from("manager_signals").delete().eq("contact_id", contactId).then(() => {}, () => {})
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("contact_id", contactId)
    check("cleanup: signals removed", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
