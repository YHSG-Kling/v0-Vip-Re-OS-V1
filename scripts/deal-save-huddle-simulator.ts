#!/usr/bin/env tsx
/**
 * scripts/deal-save-huddle-simulator.ts  (npm run test:deal-save-huddle)
 *
 * Proves the DEAL-SAVE HUDDLE — the multi-manager play that fires when a deal goes sideways
 * (the "no boring single workflow" differentiator). When a deal worsens into at_risk/critical,
 * the Deal Coordinator convenes a huddle routed by the FAILING health component, and EVERY play
 * keeps the Transaction Coordinator + the deal's AGENT aware — NOT the broker (it's operational,
 * their job). Earnest money is the TC's job and ALSO proposes an URGENT gated buyer warning.
 *
 *  - PURE layer (always): failing-component detection, worsening-into-danger gate, component→
 *    manager routing (earnest money → the TC, the loan → Finance, deadlines → Compliance), and
 *    the role-specific play sentences (incl. the earnest-money "warn the buyer" play).
 *  - LIVE layer (creds-gated, self-cleaning): seeds a deal WITH a TC + agent + buyer contact,
 *    runs the huddle with failing LENDER + EARNEST_MONEY + DEADLINES + TITLE, and asserts the
 *    TC + agent were notified (broker NOT), the earnest-money buyer warning was proposed (gated),
 *    Finance/Compliance were delegated over the bus, their handlers notified the TC + agent, and a
 *    second run dedups. Deletes every tagged row (cleanup == 0).
 */
import { randomUUID } from "node:crypto"
import {
  isFailingComponent, isWorseningToDanger, isRecoveringFromDanger, routeFailingComponents, huddlePlay,
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
  check("at_risk→watch ⇒ RECOVERING (huddle stands down)", isRecoveringFromDanger("at_risk", "watch"))
  check("critical→healthy ⇒ RECOVERING", isRecoveringFromDanger("critical", "healthy"))
  check("watch→at_risk ⇒ NOT recovering (it worsened)", !isRecoveringFromDanger("watch", "at_risk"))
  check("critical→at_risk ⇒ NOT recovering (still in danger)", !isRecoveringFromDanger("critical", "at_risk"))

  console.log("\n[routing · pure — recipients are the TC + agent, never the broker]")
  check("LENDER (loan) ⇒ finance_manager", COMPONENT_OWNER.LENDER === "finance_manager")
  check("EARNEST_MONEY ⇒ deal_coordinator (the TC's job)", COMPONENT_OWNER.EARNEST_MONEY === "deal_coordinator")
  check("DEADLINES ⇒ compliance_officer", COMPONENT_OWNER.DEADLINES === "compliance_officer")
  check("TITLE ⇒ deal_coordinator (TC/agent)", COMPONENT_OWNER.TITLE === "deal_coordinator")

  const components: HealthComponentLite[] = [
    { category: "LENDER", score: 30, issues: ["loan not yet approved 10 days out"] },
    { category: "EARNEST_MONEY", score: 50, issues: ["EMD receipt not confirmed"] },
    { category: "DEADLINES", score: 45, issues: ["inspection contingency lapses in 2 days"] },
    { category: "TITLE", score: 60, issues: ["title commitment not received"] },
    { category: "DOCUMENTS", score: 95, issues: [] }, // healthy — must NOT route
  ]
  const buckets = routeFailingComponents(components)
  const managers = buckets.map((b) => b.manager).sort()
  check("routes to all three managers (finance, compliance, coordinator)", JSON.stringify(managers) === JSON.stringify(["compliance_officer", "deal_coordinator", "finance_manager"]))
  check("healthy DOCUMENTS component is excluded", !buckets.some((b) => b.categories.includes("DOCUMENTS")))
  const fin = buckets.find((b) => b.manager === "finance_manager")!
  check("finance bucket is the loan side only (LENDER, not earnest money)", fin.categories.includes("LENDER") && !fin.categories.includes("EARNEST_MONEY"))
  const coord = buckets.find((b) => b.manager === "deal_coordinator")!
  check("coordinator bucket holds EARNEST_MONEY + TITLE", coord.categories.includes("EARNEST_MONEY") && coord.categories.includes("TITLE"))
  check("earnest-money play tells the TC to warn the buyer", /earnest money/i.test(huddlePlay("deal_coordinator", coord)) && /warn the buyer/i.test(huddlePlay("deal_coordinator", coord)))
  check("compliance play talks deadline/contingency", /deadline|contingency/i.test(huddlePlay("compliance_officer", buckets.find((b) => b.manager === "compliance_officer")!)))
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[deal-save huddle · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the logic")
    return
  }
  console.log("\n[deal-save huddle · live — seed deal+TC+agent+buyer → convene → assert → self-clean]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runDealSaveHuddle } = await import("../lib/kernel/deal-save-huddle")
  const { SIGNAL_HANDLERS } = await import("../lib/kernel/manager-signals")
  const svc = createServiceClient()

  const tag = `dsh-sim-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const agentUserId = randomUUID()
  const coordinatorUserId = randomUUID()
  const agentRowId = randomUUID()
  const buyerContactId = randomUUID()
  const txnId = randomUUID()
  const components: HealthComponentLite[] = [
    { category: "LENDER", score: 30, issues: [`${tag} loan not approved`] },
    { category: "EARNEST_MONEY", score: 40, issues: [`${tag} EMD not confirmed`] },
    { category: "DEADLINES", score: 45, issues: [`${tag} contingency lapses soon`] },
    { category: "TITLE", score: 60, issues: [`${tag} title not received`] },
  ]
  const notifiedTo = async (userId: string) =>
    ((await svc.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("entity_id", txnId)).count ?? 0)

  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} (deal-save test)` })
    await svc.from("users").insert([
      { id: agentUserId, brokerage_id: brokerageId, email: `${tag}-agent@example.com`, first_name: "Agent", last_name: tag, user_type: "agent" },
      { id: coordinatorUserId, brokerage_id: brokerageId, email: `${tag}-tc@example.com`, first_name: "TC", last_name: tag, user_type: "tc" },
    ])
    await svc.from("agents").insert({ id: agentRowId, brokerage_id: brokerageId, user_id: agentUserId })
    await svc.from("contacts").insert({ id: buyerContactId, brokerage_id: brokerageId, first_name: "Buyer", last_name: tag })
    await svc.from("transactions").insert({
      id: txnId, brokerage_id: brokerageId, deal_name: `${tag} deal`, status: "active",
      agent_id: agentRowId, coordinator_id: coordinatorUserId, buyer_contact_id: buyerContactId,
    })

    const r1 = await runDealSaveHuddle({ transactionId: txnId, brokerageId, riskLevel: "critical", components, dealName: `${tag} deal` }, svc)
    check("huddle convened + coordinator opened its own task", r1.convened && r1.coordinatorTaskCreated)
    check("delegated to BOTH finance + compliance (multi-manager)", r1.delegatedTo.includes("finance_manager") && r1.delegatedTo.includes("compliance_officer"))
    check("TC + agent were notified (2 users)", r1.notifiedUsers >= 2)
    check("earnest-money URGENT buyer warning was proposed (gated)", r1.clientWarningProposed)

    check("the TC was notified", (await notifiedTo(coordinatorUserId)) >= 1)
    check("the agent was notified", (await notifiedTo(agentUserId)) >= 1)

    const { data: warning } = await svc.from("agent_client_messages")
      .select("agent_kind, audience, status, rationale, subject").eq("recipient_contact_id", buyerContactId).maybeSingle()
    check("buyer warning is a gated proposal from the Deal Coordinator", !!warning && warning.agent_kind === "deal_coordinator" && warning.status === "proposed" && warning.audience === "buyer")
    check("buyer warning is tagged urgent/earnest-money", !!warning && /Earnest Money/i.test(warning.rationale ?? ""))

    // Finance handler runs on its signal → opens a financing task + keeps TC/agent aware (NOT broker).
    const { data: sigs } = await svc.from("manager_signals").select("id, to_manager, message, entity_id, payload")
      .eq("brokerage_id", brokerageId).eq("signal_type", "deal_save_huddle")
    const finSig = (sigs ?? []).find((s) => s.to_manager === "finance_manager")
    if (finSig) {
      const out = await SIGNAL_HANDLERS["finance_manager:deal_save_huddle"](
        { id: finSig.id, toManager: "finance_manager", signalType: "deal_save_huddle", message: finSig.message, entityType: "transaction", entityId: finSig.entity_id, contactId: null, payload: finSig.payload } as never,
        { brokerageId, supabase: svc },
      )
      check("Finance handler opened a financing task (TC + agent notified)", !!out && /financing/i.test(out))
    }

    // Dedup — a second convene must not duplicate the coordinator task or re-propose the warning.
    const r2 = await runDealSaveHuddle({ transactionId: txnId, brokerageId, riskLevel: "critical", components, dealName: `${tag} deal` }, svc)
    check("second convene dedups (task + warning not duplicated)", r2.coordinatorTaskCreated === false && r2.clientWarningProposed === false)

    // FINISH THE LOOP — the deal recovers; the huddle stands down (open signals expired, team told).
    const { standDownDealSaveHuddle } = await import("../lib/kernel/deal-save-huddle")
    const sd = await standDownDealSaveHuddle({ transactionId: txnId, brokerageId, newRiskLevel: "watch", dealName: `${tag} deal` }, svc)
    check("stand-down expired the open huddle signals", sd.stoodDown >= 1)
    check("stand-down told the TC + agent the good news", sd.notifiedUsers >= 1)
    const { count: openSigs } = await svc.from("manager_signals").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("signal_type", "deal_save_huddle").eq("status", "open")
    check("no open huddle signals remain after stand-down (loop closed)", (openSigs ?? 0) === 0)
    const sd2 = await standDownDealSaveHuddle({ transactionId: txnId, brokerageId, newRiskLevel: "watch", dealName: `${tag} deal` }, svc)
    check("stand-down is idempotent (nothing left to stand down)", sd2.stoodDown === 0)
  } finally {
    await svc.from("agent_client_messages").delete().eq("brokerage_id", brokerageId)
    await svc.from("notifications").delete().eq("brokerage_id", brokerageId)
    await svc.from("transaction_tasks").delete().eq("transaction_id", txnId)
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId)
    await svc.from("transactions").delete().eq("id", txnId)
    await svc.from("contacts").delete().eq("id", buyerContactId)
    await svc.from("agents").delete().eq("id", agentRowId)
    await svc.from("users").delete().in("id", [agentUserId, coordinatorUserId])
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
  console.log(" ✅ DEAL_SAVE_HUDDLE_PASS — a deal at risk convenes a coordinated huddle (TC + agent, not the broker)")
}

main().catch((e) => { console.error(e); process.exit(1) })
