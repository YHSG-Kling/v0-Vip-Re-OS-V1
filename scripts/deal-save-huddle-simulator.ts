#!/usr/bin/env tsx
/**
 * scripts/deal-save-huddle-simulator.ts  (npm run test:deal-save-huddle)
 *
 * Proves the DEAL-SAVE HUDDLE — the multi-manager play that fires when a deal goes sideways
 * (the "no boring single workflow" differentiator). When a deal worsens into at_risk/critical,
 * the Deal Coordinator convenes a huddle routed by the FAILING health component: Finance works
 * the money side, Compliance owns the deadline/contingency exposure, the coordinator drives its
 * own docs/title bucket — visible on the managers-talking bus, internal drive-to-done only.
 *
 *  - PURE layer (always): failing-component detection, worsening-into-danger gate, component→
 *    manager routing, and the role-specific play sentences.
 *  - LIVE layer (creds-gated, self-cleaning): seeds a deal, runs the huddle with failing LENDER +
 *    DEADLINES + TITLE components, asserts the coordinator opened its own task, delegated to
 *    Finance + Compliance over the bus, the Finance handler opened a financing task, and a second
 *    run dedups. Deletes every tagged row (cleanup == 0).
 */
import { randomUUID } from "node:crypto"
import {
  isFailingComponent, isWorseningToDanger, routeFailingComponents, huddlePlay,
  COMPONENT_OWNER, type HealthComponentLite,
} from "../lib/kernel/deal-save-huddle"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

function pureLayer(): void {
  console.log("\n[failing-component + worsening gate · pure]")
  check("low score ⇒ failing", isFailingComponent({ category: "LENDER", score: 40, issues: [] }))
  check("issues present ⇒ failing even if score ok", isFailingComponent({ category: "TITLE", score: 90, issues: ["title defect"] }))
  check("healthy + no issues ⇒ not failing", !isFailingComponent({ category: "DOCUMENTS", score: 95, issues: [] }))
  check("watch→at_risk ⇒ worsening (huddle fires)", isWorseningToDanger("watch", "at_risk"))
  check("healthy→critical ⇒ worsening", isWorseningToDanger("healthy", "critical"))
  check("critical→at_risk (improving) ⇒ NOT worsening", !isWorseningToDanger("critical", "at_risk"))
  check("at_risk→watch (recovered) ⇒ NOT worsening", !isWorseningToDanger("at_risk", "watch"))
  check("first score into watch ⇒ NOT danger", !isWorseningToDanger(null, "watch"))

  console.log("\n[routing · pure — failing component → owning manager]")
  check("LENDER ⇒ finance_manager", COMPONENT_OWNER.LENDER === "finance_manager")
  check("DEADLINES ⇒ compliance_officer", COMPONENT_OWNER.DEADLINES === "compliance_officer")
  check("TITLE ⇒ deal_coordinator", COMPONENT_OWNER.TITLE === "deal_coordinator")

  const components: HealthComponentLite[] = [
    { category: "LENDER", score: 30, issues: ["loan not yet approved 10 days out"] },
    { category: "EARNEST_MONEY", score: 50, issues: [] },
    { category: "DEADLINES", score: 45, issues: ["inspection contingency lapses in 2 days"] },
    { category: "TITLE", score: 60, issues: ["title commitment not received"] },
    { category: "DOCUMENTS", score: 95, issues: [] }, // healthy — must NOT route
  ]
  const buckets = routeFailingComponents(components)
  const managers = buckets.map((b) => b.manager).sort()
  check("routes to all three managers (finance, compliance, coordinator)", JSON.stringify(managers) === JSON.stringify(["compliance_officer", "deal_coordinator", "finance_manager"]))
  check("healthy DOCUMENTS component is excluded from the huddle", !buckets.some((b) => b.categories.includes("DOCUMENTS")))
  const fin = buckets.find((b) => b.manager === "finance_manager")!
  check("finance bucket groups LENDER + EARNEST_MONEY", fin.categories.includes("LENDER") && fin.categories.includes("EARNEST_MONEY"))
  check("finance play talks financing/CTC", /financing|loan|clear-to-close/i.test(huddlePlay("finance_manager", fin)))
  check("compliance play talks deadline/contingency", /deadline|contingency/i.test(huddlePlay("compliance_officer", buckets.find((b) => b.manager === "compliance_officer")!)))
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[deal-save huddle · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the logic")
    return
  }
  console.log("\n[deal-save huddle · live — seed → convene → assert → self-clean]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runDealSaveHuddle } = await import("../lib/kernel/deal-save-huddle")
  const { SIGNAL_HANDLERS } = await import("../lib/kernel/manager-signals")
  const svc = createServiceClient()

  const tag = `dsh-sim-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const txnId = randomUUID()
  const components: HealthComponentLite[] = [
    { category: "LENDER", score: 30, issues: [`${tag} loan not approved`] },
    { category: "DEADLINES", score: 45, issues: [`${tag} contingency lapses soon`] },
    { category: "TITLE", score: 60, issues: [`${tag} title not received`] },
  ]

  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} (deal-save test)` })
    await svc.from("transactions").insert({ id: txnId, brokerage_id: brokerageId, deal_name: `${tag} deal`, status: "active" })

    const r1 = await runDealSaveHuddle({ transactionId: txnId, brokerageId, riskLevel: "critical", components, dealName: `${tag} deal` }, svc)
    check("huddle convened", r1.convened)
    check("coordinator opened its own drive-to-done task", r1.coordinatorTaskCreated)
    check("delegated to BOTH finance + compliance (multi-manager, not single workflow)",
      r1.delegatedTo.includes("finance_manager") && r1.delegatedTo.includes("compliance_officer"))

    const { count: coordTasks } = await svc.from("transaction_tasks").select("id", { count: "exact", head: true })
      .eq("transaction_id", txnId).ilike("title", "[Deal-Save Huddle]%")
    check("a coordinator huddle task exists", (coordTasks ?? 0) >= 1)

    const { data: sigs } = await svc.from("manager_signals").select("id, to_manager, signal_type, message, entity_id, payload")
      .eq("brokerage_id", brokerageId).eq("signal_type", "deal_save_huddle")
    check("two huddle signals on the bus (finance + compliance)", (sigs ?? []).length === 2)

    // Run the Finance handler on its signal → it opens a financing task.
    const finSig = (sigs ?? []).find((s) => s.to_manager === "finance_manager")
    if (finSig) {
      const out = await SIGNAL_HANDLERS["finance_manager:deal_save_huddle"](
        { id: finSig.id, toManager: "finance_manager", signalType: "deal_save_huddle", message: finSig.message, entityType: "transaction", entityId: finSig.entity_id, contactId: null, payload: finSig.payload } as never,
        { brokerageId, supabase: svc },
      )
      check("Finance handler opened a financing task", !!out && /financing/i.test(out))
      const { count: finTasks } = await svc.from("transaction_tasks").select("id", { count: "exact", head: true })
        .eq("transaction_id", txnId).ilike("title", "[Deal-Save Huddle · Finance]%")
      check("financing drive-to-done task persisted", (finTasks ?? 0) >= 1)
    }

    // Dedup — a second convene must not duplicate the coordinator task or re-open signals.
    const r2 = await runDealSaveHuddle({ transactionId: txnId, brokerageId, riskLevel: "critical", components, dealName: `${tag} deal` }, svc)
    check("second convene dedups the coordinator task", r2.coordinatorTaskCreated === false)
  } finally {
    await svc.from("transaction_tasks").delete().eq("transaction_id", txnId)
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId)
    await svc.from("transactions").delete().eq("id", txnId)
    await svc.from("brokerages").delete().eq("id", brokerageId)
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
    check("cleanup complete — zero tagged rows remain", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ DEAL_SAVE_HUDDLE_FAIL"); process.exit(1) }
  console.log(" ✅ DEAL_SAVE_HUDDLE_PASS — a deal at risk convenes a coordinated multi-manager huddle")
}

main().catch((e) => { console.error(e); process.exit(1) })
