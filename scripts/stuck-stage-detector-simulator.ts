#!/usr/bin/env tsx
/**
 * scripts/stuck-stage-detector-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the STUCK-STAGE DETECTOR — the quiet failure journey-conformance misses: a contact sitting
 * in a LEGAL stage too long with nothing in motion. It's routed to the manager who owns that stage by
 * dwell-vs-ceiling; a contact already being worked is never flagged.
 *
 * Layer 1 (shell, pure): the dwell decisions + stage ownership. Layer 2 (live, creds-gated): seed a
 * contact long past a stage ceiling with no open action → assert the bus surface to the owning
 * manager → idempotent → clean up.
 *
 * Run: npx tsx scripts/stuck-stage-detector-simulator.ts   (npm run test:stuck-stage-detector)
 */
import { detectStuckStage, ownerForStage, expectedDwellForStage } from "../lib/intelligence/stuck-stage-detector"

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
  console.log(" ✅ Stuck-stage detector verified — aging-in-stage caught + routed to the owning manager.")
  console.log(" STUCK_STAGE_DETECTOR_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Stuck-stage detector simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · dwell + ownership]")
  const within = detectStuckStage({ stage: "touring", daysInStage: 10, expectedMaxDays: 21, hasOpenAction: false })
  check("within the window → not stuck", !within.stuck && within.severity === "none")
  const watch = detectStuckStage({ stage: "touring", daysInStage: 22, expectedMaxDays: 21, hasOpenAction: false })
  check("at the ceiling, no action → stuck (watch)", watch.stuck && watch.severity === "watch")
  const overdue = detectStuckStage({ stage: "touring", daysInStage: 40, expectedMaxDays: 21, hasOpenAction: false })
  check("well past the ceiling → stuck (overdue)", overdue.stuck && overdue.severity === "overdue")
  const worked = detectStuckStage({ stage: "touring", daysInStage: 40, expectedMaxDays: 21, hasOpenAction: true })
  check("already being worked → NOT stuck (someone's on it)", !worked.stuck)

  check("buyer stage → shopping_agent", ownerForStage("buyer_active") === "shopping_agent")
  check("seller stage → listing_concierge", ownerForStage("listing_prep") === "listing_concierge")
  check("under contract → deal_coordinator", ownerForStage("under_contract") === "deal_coordinator")
  check("lead stage → ai_isa", ownerForStage("new") === "ai_isa")
  check("known stage has a dwell ceiling", expectedDwellForStage("financially_verified") === 30 && expectedDwellForStage("unknown_stage") === 30)

  console.log("\n[Layer 2 · live: a contact long past the ceiling → routed to the owner]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { detectAndPublishStuckStage } = await import("../lib/intelligence/stuck-stage-detector-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  let contactId: string | null = null
  try {
    // A contact in "touring" whose updated_at is 50 days ago, no future follow-up → stuck, owner shopping_agent.
    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "ZZStuck", last_name: `${Date.now()}`,
      email: `zz-stuck-${Date.now()}@example.com`, contact_type: "buyer",
      lifecycle_state: "touring", updated_at: new Date(Date.now() - 50 * 86_400_000).toISOString(),
    }).select("id").single()
    contactId = (c as any)?.id ?? null
    if (contactId) cleanup.push({ table: "contacts", id: contactId })

    const r = await detectAndPublishStuckStage({ brokerageId, contactId: contactId! }, svc)
    check("the stuck contact was detected + surfaced", r.published && r.stuck && r.stage === "touring", JSON.stringify(r))

    const { data: sig } = await svc.from("manager_signals")
      .select("to_manager, signal_type, payload").eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("signal_type", "stage_stalled").maybeSingle()
    check("surfaced to the owning manager (shopping_agent)", (sig as any)?.to_manager === "shopping_agent", JSON.stringify(sig))

    const again = await detectAndPublishStuckStage({ brokerageId, contactId: contactId! }, svc)
    check("re-detecting the same stage is idempotent", again.published === false)
  } finally {
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId).eq("contact_id", contactId ?? "none").eq("signal_type", "stage_stalled").then(() => {}, () => {})
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("contact_id", contactId ?? "none").eq("signal_type", "stage_stalled")
    check("cleanup: signals + seeds removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
