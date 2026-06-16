#!/usr/bin/env tsx
/**
 * scripts/stalled-deferrals-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves OVER-DEFERRAL accountability: when the same manager is deferred-to repeatedly on the same
 * contact with no action, detectStalledDeferrals flags it so the deferred-to manager gets an "act or
 * release" nudge. Turns visible coordination into accountability.
 *
 * Layer 1 (shell, pure): the detector matrix. Layer 2 (live, creds-gated): seed 3 deferral signals
 * to one manager/contact → run → assert a deferral_stall_nudge is raised; re-run idempotent. Cleaned up.
 *
 * Run: npx tsx scripts/stalled-deferrals-simulator.ts   (npm run test:deferral-nudge)
 */
import { detectStalledDeferrals } from "../lib/kernel/stalled-deferrals"

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
  console.log(" ✅ Over-deferral verified — repeated yield-without-action flagged; under-threshold/noise ignored.")
  console.log(" DEFERRAL_NUDGE_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Over-deferral accountability simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · detectStalledDeferrals]")
  const d = (n: number, mgr = "ai_isa", c = "c1") => Array.from({ length: n }, () => ({ to_manager: mgr, contact_id: c }))
  check("3 deferrals to same (mgr,contact) → stalled", detectStalledDeferrals(d(3)).length === 1)
  check("2 deferrals → under threshold, not stalled", detectStalledDeferrals(d(2)).length === 0)
  check("stalled entry carries the count", detectStalledDeferrals(d(4))[0].count === 4)
  check("different contacts counted separately", detectStalledDeferrals([...d(3, "ai_isa", "c1"), ...d(2, "ai_isa", "c2")]).length === 1)
  check("null manager/contact ignored", detectStalledDeferrals([{ to_manager: null, contact_id: "c1" }, { to_manager: "ai_isa", contact_id: null }]).length === 0)
  check("custom threshold honored", detectStalledDeferrals(d(2), { threshold: 2 }).length === 1)
  check("empty → none", detectStalledDeferrals([]).length === 0)

  console.log("\n[Layer 2 · live: repeated deferrals raise a nudge, idempotently]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { runStalledDeferralNudges } = await import("../lib/kernel/stalled-deferrals-runner")
  const { publishManagerSignal } = await import("../lib/kernel/manager-signals")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const contactId = uuid()

  try {
    await svc.from("contacts").insert({ id: contactId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "Limbo", contact_type: "buyer" })
    for (let i = 0; i < 3; i++) {
      await publishManagerSignal({ brokerageId, fromManager: "campaign_orchestrator", toManager: "ai_isa", signalType: "first_touch_deferred", message: "deferred", entityType: "contact", entityId: contactId, contactId }, svc)
    }
    const r1 = await runStalledDeferralNudges(brokerageId, svc)
    check("a stalled pair was nudged", r1.nudged >= 1, JSON.stringify(r1))
    const { count: nudge } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("entity_id", contactId).eq("signal_type", "deferral_stall_nudge")
    check("a deferral_stall_nudge signal was raised", (nudge ?? 0) >= 1)
    const r2 = await runStalledDeferralNudges(brokerageId, svc)
    check("re-run is idempotent (no duplicate nudge)", r2.nudged === 0)
  } finally {
    await svc.from("manager_signals").delete().eq("entity_id", contactId).then(() => {}, () => {})
    await svc.from("notifications").delete().eq("entity_id", contactId).then(() => {}, () => {})
    await svc.from("contacts").delete().eq("id", contactId).then(() => {}, () => {})
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("entity_id", contactId)
    check("cleanup: signals removed", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
