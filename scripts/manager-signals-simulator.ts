#!/usr/bin/env tsx
/**
 * scripts/manager-signals-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * INTER-MANAGER BUS harness — managers talking to one another, proven end-to-end.
 *
 * Layer 1 (pure): validSignalRoute (both ends must be real managers, no self-talk) +
 *   callCooldownActive (the voice-results learn loop: recent call / appointment / cold
 *   outcome keep a contact off the next dial list).
 * Layer 2 (live, gated): the full conversation —
 *   · AI ISA books an appointment on a dial call (ai_isa_calls row) →
 *   · publishIsaCallOutcomes PUBLISHES `isa_call_appointment` to the right concierge
 *     (buyer contact → Shopping Agent), deduped on re-publish →
 *   · consumeManagerSignals: the concierge CONSUMES it by proposing a prep follow-up
 *     into the client-message gate (proposed, NOT sent) and marks the signal consumed
 *     with the action taken →
 *   · loadRecentManagerTalk shows the conversation (from → to, ✓ action).
 * Self-cleans every row.
 *
 * Run: npx tsx scripts/manager-signals-simulator.ts  (npm run test:manager-signals)
 */
import { validSignalRoute, publishManagerSignal, consumeManagerSignals, loadRecentManagerTalk } from "../lib/kernel/manager-signals"
import { callCooldownActive, publishIsaCallOutcomes, CALL_COOLDOWN_DAYS } from "../lib/ai-isa/voice-dial-batch"

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
  console.log(" ✅ Inter-manager bus verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Inter-manager bus (managers talking) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure]")
  check("route: ai_isa → shopping_agent is valid", validSignalRoute("ai_isa", "shopping_agent"))
  check("route: self-talk is invalid", !validSignalRoute("ai_isa", "ai_isa"))
  check("route: unknown manager is invalid", !validSignalRoute("ai_isa", "nonexistent"))
  const now = Date.now()
  const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString()
  check("cooldown: a 3-day-old call suppresses re-dial", callCooldownActive([{ appointment_set: false, lead_quality_score: 60, created_at: daysAgo(3) }], now))
  check("cooldown: an appointment within 30d suppresses (they're with the agent)", callCooldownActive([{ appointment_set: true, lead_quality_score: 80, created_at: daysAgo(20) }], now))
  check("cooldown: a cold outcome (<30 quality) suppresses for 30d", callCooldownActive([{ appointment_set: false, lead_quality_score: 10, created_at: daysAgo(25) }], now))
  check(`cooldown: a decent-quality call older than ${CALL_COOLDOWN_DAYS}d does NOT suppress`, !callCooldownActive([{ appointment_set: false, lead_quality_score: 60, created_at: daysAgo(20) }], now))
  check("cooldown: no history → callable", !callCooldownActive([], now))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live conversation]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__bussim_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: con } = await svc.from("contacts").insert({
      brokerage_id: (await svc.from("brokerages").select("id").limit(1).single()).data!.id,
      first_name: "Bus", last_name: TAG, contact_type: "buyer",
    }).select("id, brokerage_id").single()
    cleanup.push({ table: "contacts", id: (con as any).id })
    const brokerageId = (con as any).brokerage_id
    const contactId = (con as any).id

    // AI ISA books an appointment on a dial call.
    const { data: call } = await svc.from("ai_isa_calls").insert({
      brokerage_id: brokerageId, contact_id: contactId, appointment_set: true,
      appointment_datetime: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      script_used: `${TAG} dial`, ai_response_summary: "appointment booked",
    }).select("id").single()
    cleanup.push({ table: "ai_isa_calls", id: (call as any).id })

    // PUBLISH: the outcome lands on the bus, addressed to the Shopping Agent (buyer).
    const p1 = await publishIsaCallOutcomes(brokerageId, svc)
    check("publish: the appointment outcome was published", p1.published >= 1)
    const { data: sig } = await svc.from("manager_signals")
      .select("id, from_manager, to_manager, signal_type, status, contact_id")
      .eq("entity_id", (call as any).id).maybeSingle()
    if (sig) cleanup.push({ table: "manager_signals", id: (sig as any).id })
    check("publish: routed ai_isa → shopping_agent (buyer contact)", (sig as any)?.from_manager === "ai_isa" && (sig as any)?.to_manager === "shopping_agent")
    check("publish: signal is open (awaiting the concierge)", (sig as any)?.status === "open")

    // Re-publish is deduped (one open signal per outcome).
    const p2 = await publishIsaCallOutcomes(brokerageId, svc)
    check("publish: re-publish deduped (0 new)", p2.published === 0)

    // CONSUME: the Shopping Agent acts — proposes the prep follow-up into the gate.
    const c1 = await consumeManagerSignals({ brokerageId, toManager: "shopping_agent" }, svc)
    check("consume: the concierge consumed the signal", c1.consumed >= 1)
    const { data: sigAfter } = await svc.from("manager_signals").select("status, consumed_action").eq("id", (sig as any).id).single()
    check("consume: marked consumed WITH the action taken", (sigAfter as any).status === "consumed" && !!(sigAfter as any).consumed_action)
    const { data: gateMsg } = await svc.from("agent_client_messages")
      .select("id, agent_kind, status, audience").eq("recipient_contact_id", contactId)
      .eq("agent_kind", "shopping_agent").order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (gateMsg) cleanup.push({ table: "agent_client_messages", id: (gateMsg as any).id })
    check("consume: the action is a GOVERNED gate proposal (proposed, not sent)", (gateMsg as any)?.status === "proposed" && (gateMsg as any)?.audience === "buyer")
    // The real-time gate firing may have alerted the responsible agent — clean it up.
    if (gateMsg) {
      const { data: rtNotif } = await svc.from("notifications").select("id").eq("entity_id", (gateMsg as any).id).eq("type", "approval_needed").maybeSingle()
      if (rtNotif) cleanup.push({ table: "notifications", id: (rtNotif as any).id })
    }

    // ── Conversation 2: deal_closed → Sphere proposes the lifetime welcome ──
    const dc = await publishManagerSignal({
      brokerageId, fromManager: "deal_coordinator", toManager: "sphere_of_influence",
      signalType: "deal_closed", message: `${TAG} deal closed`, entityType: "transaction",
      entityId: (call as any).id /* any uuid for dedupe key */, contactId,
    }, svc)
    check("deal_closed: published to the Sphere", dc.ok === true)
    if (dc.signalId) cleanup.push({ table: "manager_signals", id: dc.signalId })
    const c2 = await consumeManagerSignals({ brokerageId, toManager: "sphere_of_influence" }, svc)
    check("deal_closed: the Sphere consumed it", c2.consumed >= 1)
    const { data: welcome } = await svc.from("agent_client_messages")
      .select("id, agent_kind, status").eq("recipient_contact_id", contactId)
      .eq("agent_kind", "sphere_of_influence").order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (welcome) cleanup.push({ table: "agent_client_messages", id: (welcome as any).id })
    check("deal_closed: lifetime welcome PROPOSED into the gate (not sent)", (welcome as any)?.status === "proposed")
    if (welcome) {
      const { data: rtN } = await svc.from("notifications").select("id").eq("entity_id", (welcome as any).id).eq("type", "approval_needed").maybeSingle()
      if (rtN) cleanup.push({ table: "notifications", id: (rtN as any).id })
    }

    // ── Conversation 3: recruit_activated → Deal Coordinator onboards the NEW AGENT ──
    // (the rule: a recruit becomes an ACTIVE agent before any contacts — this handler
    // only assigns learning + welcomes; zero contact involvement.)
    const { data: agentRow } = await svc.from("agents").select("id, user_id").not("user_id", "is", null).eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    if (agentRow) {
      const ra = await publishManagerSignal({
        brokerageId, fromManager: "recruiting_manager", toManager: "deal_coordinator",
        signalType: "recruit_activated", message: `${TAG} recruit activated`, entityType: "recruit",
        entityId: contactId /* uuid for dedupe key */, payload: { agent_id: (agentRow as any).id, user_id: (agentRow as any).user_id },
      }, svc)
      check("recruit_activated: published to the Deal Coordinator", ra.ok === true)
      if (ra.signalId) cleanup.push({ table: "manager_signals", id: ra.signalId })
      const c3 = await consumeManagerSignals({ brokerageId, toManager: "deal_coordinator" }, svc)
      check("recruit_activated: the Deal Coordinator consumed it (onboarding support)", c3.consumed >= 1)
      const { data: welcomeNotif } = await svc.from("notifications")
        .select("id, type").eq("user_id", (agentRow as any).user_id).eq("type", "agent_onboarding")
        .order("created_at", { ascending: false }).limit(1).maybeSingle()
      if (welcomeNotif) cleanup.push({ table: "notifications", id: (welcomeNotif as any).id })
      check("recruit_activated: the new agent got the onboarding welcome (no contacts involved)", !!welcomeNotif)
      // clean any learning assignments the handler created for this signal
      const { data: las } = await svc.from("learning_assignments").select("id").eq("agent_user_id", (agentRow as any).user_id).eq("signal_source", "recruit_activated")
      for (const la of (las ?? []) as Array<{ id: string }>) cleanup.push({ table: "learning_assignments", id: la.id })
    }

    // TALK FEED: the conversation is visible.
    const talk = await loadRecentManagerTalk(brokerageId, 20, svc)
    const line = talk.find((t) => t.fromLabel === "AI ISA" && t.toLabel === "Shopping Agent")
    check("talk feed: the conversation shows from → to with the ✓ action", !!line && line.status === "consumed" && !!line.consumedAction)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("last_name", `${TAG}%`)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
