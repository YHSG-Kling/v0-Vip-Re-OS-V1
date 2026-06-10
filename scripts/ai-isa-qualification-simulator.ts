#!/usr/bin/env tsx
/**
 * scripts/ai-isa-qualification-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AI ISA manager — regression for the qualify → assign → convert intake valve.
 *
 * Business process (canonical): the AI ISA owns a lead from promotion until it is
 * QUALIFIED (lead_stage='qualified' + consent); assignment then converts the lead
 * to a contact owned by the assigned agent (tier-routed; solo → the solo agent).
 *
 *   Layer 1 — the pure qualification core (no DB, no AI):
 *     • signalScore / signalTemperature — the conversation tool's rolling state
 *       (the phantom qualification_signal write that starved this chain is the
 *       exact bug class this locks out).
 *     • deriveQualificationSignals — intent/urgency/engagement detection + the
 *       readinessForAgent handoff rule (requires a PERSISTED lead_score >= 50).
 *     • qualificationScoreFor — signals → ai_isa_qualifications.qualification_score.
 *     • engine2GatePasses — assignment only after qualification + consent.
 *
 *   Layer 2 — live DB round-trip (env-gated, full cleanup): seeds an
 *     isa_qualifying lead, applies the tool's write shape, asserts the
 *     lead_temperature check accepts hot|warm|cold and REJECTS off-vocabulary,
 *     writes the qualification record, runs the lifecycle transitions, and
 *     asserts Engine 2's gate passes. Deletes every row including on failure.
 *
 * Run:  npx tsx scripts/ai-isa-qualification-simulator.ts  (npm run test:isa-qualification)
 */
import {
  signalScore,
  signalTemperature,
  deriveQualificationSignals,
  qualificationScoreFor,
  engine2GatePasses,
} from "../lib/ai-isa/qualification-core"
import { buildIsaOvernightSection, isaPriorityActions } from "../lib/intelligence/isa-overnight"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — pure qualification core
// ─────────────────────────────────────────────────────────────────────────────

function testRollingSignal() {
  console.log("\n[Layer 1 · conversation signal → rolling lead state]")
  check("hot → score 90", signalScore("hot") === 90)
  check("warm → score 60", signalScore("warm") === 60)
  check("cold → score 30", signalScore("cold") === 30)
  check("unqualified → score 10", signalScore("unqualified") === 10)
  check("hot/warm/cold map to themselves (constraint-legal)",
    signalTemperature("hot") === "hot" && signalTemperature("warm") === "warm" && signalTemperature("cold") === "cold")
  check("unqualified → temperature NULL (leads check allows hot|warm|cold only)",
    signalTemperature("unqualified") === null)
}

function testSignalDerivation() {
  console.log("\n[Layer 1 · message analysis → qualification signals]")
  const ready = deriveQualificationSignals({
    messageText: "I'm ready to schedule a showing ASAP",
    conversationCount: 3, timeline: null, leadScore: 90,
  })
  check("intent + urgency + engagement + score ≥50 → ready for agent",
    ready.confirmedIntent && ready.urgency === "high" && ready.engagementLevel === "high" && ready.readinessForAgent)

  // THE bug this chain had: score never persisted (phantom column) → never ready.
  const starved = deriveQualificationSignals({
    messageText: "I'm ready to schedule a showing ASAP",
    conversationCount: 3, timeline: null, leadScore: 0,
  })
  check("same conversation but UNPERSISTED score → NOT ready (the starved-chain case)",
    !starved.readinessForAgent)

  const noIntent = deriveQualificationSignals({
    messageText: "please stop emailing me", conversationCount: 4, timeline: null, leadScore: 90,
  })
  check("no intent keywords → not ready", !noIntent.confirmedIntent && !noIntent.readinessForAgent)

  const timelineUrgency = deriveQualificationSignals({
    messageText: "interested in the area", conversationCount: 1, timeline: "immediate", leadScore: 60,
  })
  check("lead.timeline='immediate' raises urgency to high", timelineUrgency.urgency === "high")

  const silent = deriveQualificationSignals({
    messageText: "", conversationCount: 0, timeline: null, leadScore: 90,
  })
  check("zero conversations → low engagement, not ready",
    silent.engagementLevel === "low" && !silent.readinessForAgent)
}

function testScoreAndGate() {
  console.log("\n[Layer 1 · qualification score + Engine 2 gate]")
  const base = { conversationCount: 3, engagementLevel: "high" as const }
  check("ready → 85", qualificationScoreFor({ ...base, confirmedIntent: true, urgency: "high", readinessForAgent: true }) === 85)
  check("intent only → 60", qualificationScoreFor({ ...base, confirmedIntent: true, urgency: "medium", readinessForAgent: false }) === 60)
  check("urgency only → 45", qualificationScoreFor({ ...base, confirmedIntent: false, urgency: "high", readinessForAgent: false }) === 45)
  check("neither → 25", qualificationScoreFor({ ...base, confirmedIntent: false, urgency: "medium", readinessForAgent: false }) === 25)

  check("gate: qualified + consented → assignable", engine2GatePasses("qualified", "consented"))
  check("gate: qualified + unconsented → BLOCKED", !engine2GatePasses("qualified", "unconsented"))
  check("gate: new + consented → BLOCKED (ISA hasn't qualified)", !engine2GatePasses("new", "consented"))
  check("gate: null state → BLOCKED", !engine2GatePasses(null, null))
}

function testIsaOvernightBriefing() {
  console.log("\n[Layer 1 · ISA overnight briefing section — handoffs lead the agent's morning]")
  const t0 = "2026-06-10T02:00:00Z", t1 = "2026-06-10T05:00:00Z"
  const section = buildIsaOvernightSection({
    handoffs: [
      { lead_id: "L2", contact_id: "C2", lead_name: "Late Larry", claimed: false, assignment_method: "round_robin", assigned_at: t1 },
      { lead_id: "L1", contact_id: "C1", lead_name: "Early Erin", claimed: false, assignment_method: "round_robin", assigned_at: t0 },
      { lead_id: "L3", contact_id: "C3", lead_name: "Claimed Cara", claimed: true, assignment_method: "manual", assigned_at: t0 },
    ],
    escalations: [{ lead_id: "L9", message: "Wants a human", urgency: "critical" }],
    hotIsaLeadCount: 2,
  })
  check("counts: 3 handoffs / 2 unclaimed / 1 escalation / 2 hot", section.handoffs_total === 3 && section.handoffs_unclaimed === 2 && section.escalations === 1 && section.hot_isa_leads === 2)
  check("oldest unclaimed handoff leads (longest-waiting first)", section.unclaimed[0].lead_id === "L1")
  check("claimed handoffs excluded from actionable list", !section.unclaimed.some((u) => u.lead_id === "L3"))
  check("summary line covers handoffs + escalations + hot conversations",
    section.summary_line.includes("3 leads overnight") && section.summary_line.includes("2 awaiting") &&
    section.summary_line.includes("1 ISA escalation") && section.summary_line.includes("2 hot conversations"))

  const actions = isaPriorityActions(section, [{ lead_id: "L9", message: "Wants a human", urgency: "critical" }])
  // Canonical process: qualification converted the lead — the CTA opens the CONTACT.
  check("unclaimed handoffs become HIGH priorities opening the CONVERTED CONTACT",
    actions[0].priority === "high" && actions[0].action_type === "open_contact" && actions[0].entity_id === "C1")
  check("conversion-in-flight handoff falls back to the lead",
    isaPriorityActions(buildIsaOvernightSection({
      handoffs: [{ lead_id: "LX", contact_id: null, lead_name: "Mid Flight", claimed: false, assignment_method: null, assigned_at: t0 }],
      escalations: [], hotIsaLeadCount: 0,
    }), [])[0].action_type === "view_lead")
  check("critical escalation is HIGH priority", actions.some((a) => a.action.includes("escalation") && a.priority === "high"))

  const empty = buildIsaOvernightSection({ handoffs: [], escalations: [], hotIsaLeadCount: 0 })
  check("quiet night → empty section, no noise", empty.summary_line === "" && isaPriorityActions(empty, []).length === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — live DB round-trip (real schema + constraints, full cleanup)
// ─────────────────────────────────────────────────────────────────────────────

async function testLiveChain() {
  console.log("\n[Layer 2 · live qualify → gate round-trip]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer still ran).")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const RUN = `__isaqual_${Date.now()}__`
  const email = `${RUN}@example.com`
  let leadId: string | null = null
  let qualId: string | null = null

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage in DB."); return }
    const brokerageId = (brk as { id: string }).id

    const { data: lead, error: lErr } = await svc.from("leads").insert({
      brokerage_id: brokerageId, first_name: "Isa", last_name: "Sim", email,
      lead_stage: "new", lifecycle_state: "isa_qualifying", ai_isa_owner: true, lead_score: 0,
    }).select("id").single()
    check("seed isa_qualifying lead", !lErr && !!lead, lErr?.message)
    if (!lead) throw new Error("lead seed failed")
    leadId = (lead as any).id

    // The conversation tool's FIXED write shape (rolling temperature + score).
    const { error: uErr } = await svc.from("leads")
      .update({ lead_temperature: signalTemperature("hot"), lead_score: signalScore("hot"), updated_at: new Date().toISOString() })
      .eq("id", leadId).eq("brokerage_id", brokerageId)
    check("mark_qualification write persists (lead_temperature + lead_score)", !uErr, uErr?.message)

    // Off-vocabulary temperature must be REJECTED by the live check.
    const { error: badErr } = await svc.from("leads").update({ lead_temperature: "unqualified" }).eq("id", leadId)
    check("live check rejects off-vocabulary temperature", !!badErr)

    // Qualification record + the official transitions, then the assignment gate.
    const signals = deriveQualificationSignals({
      messageText: "ready to schedule asap", conversationCount: 3, timeline: null, leadScore: signalScore("hot"),
    })
    check("derived signals are handoff-ready", signals.readinessForAgent)
    const { data: qual, error: qErr } = await svc.from("ai_isa_qualifications").insert({
      lead_id: leadId, brokerage_id: brokerageId,
      qualification_score: qualificationScoreFor(signals),
      stage: "qualified", qualification_result: "qualified",
      qualification_signals: signals as unknown as Record<string, unknown>,
    }).select("id").single()
    check("qualification record persists", !qErr && !!qual, qErr?.message)
    qualId = (qual as any)?.id ?? null

    await svc.from("leads").update({ lifecycle_state: "consented" }).eq("id", leadId)
    await svc.from("leads").update({ lead_stage: "qualified", ai_isa_owner: false }).eq("id", leadId)
    const { data: after } = await svc.from("leads").select("lead_stage, lifecycle_state, lead_score, lead_temperature").eq("id", leadId).single()
    check("Engine 2 gate passes after qualification + consent",
      engine2GatePasses((after as any)?.lead_stage, (after as any)?.lifecycle_state))
    check("rolling state intact end-to-end",
      (after as any)?.lead_score === 90 && (after as any)?.lead_temperature === "hot")
  } catch (err) {
    check("live ISA chain completed", false, err instanceof Error ? err.message : String(err))
  } finally {
    if (qualId) await svc.from("ai_isa_qualifications").delete().eq("id", qualId)
    if (leadId) await svc.from("leads").delete().eq("id", leadId)
    const { count } = await svc.from("leads").select("id", { count: "exact", head: true }).eq("email", email)
    check("cleanup: zero test rows left", (count ?? 0) === 0)
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" AI ISA qualification simulator (qualify → assign gate — the funnel intake valve)")
  console.log("══════════════════════════════════════════════════")
  testRollingSignal()
  testSignalDerivation()
  testScoreAndGate()
  testIsaOvernightBriefing()
  await testLiveChain()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ AI ISA qualification chain verified (test rows cleaned up)")
}

main()
