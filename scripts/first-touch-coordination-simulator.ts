#!/usr/bin/env tsx
/**
 * scripts/first-touch-coordination-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE BATON HAND-OFF: the Campaign Orchestrator's welcome drip and the AI ISA
 * speed-to-lead engine no longer both greet a brand-new contact. They share ONE ledger
 * (contacts.first_touched_at / first_touch_channel); whichever manager reaches the contact
 * first claims it, and the other stands down — so no two same-channel hellos within minutes.
 *
 * Layer 1 (pure, always runs): the decideFirstTouch decision matrix.
 * Layer 2 (live, SUPABASE_SERVICE_ROLE_KEY-gated): seeds a REAL contact already first-touched
 *   on email + a CONTACT_CAPTURED welcome sequence whose step-1 is an email, then runs the
 *   REAL step-executor and asserts it DEFERS (skipped, advanced, manager-signal published,
 *   NO second email dispatched). The skip path returns before any channel dispatch, so this is
 *   a true end-to-end proof with ZERO egress. Seeds reverse-deleted (cleanup == 0). No mocks.
 *
 * Run: npx tsx scripts/first-touch-coordination-simulator.ts   (npm run test:first-touch-coord)
 */
import { decideFirstTouch } from "../lib/campaign-sequences/first-touch-coordination"

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
  console.log(" ✅ First-touch coordination verified — the welcome drip & speed-to-lead share one baton.")
  console.log(" FIRST_TOUCH_COORD_PASS")
}

const CAPTURED = "contact_captured" // KernelEvent.CONTACT_CAPTURED value

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" First-touch coordination simulator")
  console.log("══════════════════════════════════════════════════")

  // ── Layer 1: pure decision matrix ───────────────────────────────────────────
  console.log("\n[Layer 1 · decideFirstTouch matrix]")
  check("no first touch on record → send_and_claim",
    decideFirstTouch({ isFirstStep: true, sequenceTriggerEvent: CAPTURED, stepChannel: "email", firstTouchedAt: null, firstTouchChannel: null }) === "send_and_claim")
  check("same channel already touched → skip_duplicate",
    decideFirstTouch({ isFirstStep: true, sequenceTriggerEvent: CAPTURED, stepChannel: "email", firstTouchedAt: "2026-06-13T00:00:00Z", firstTouchChannel: "email" }) === "skip_duplicate")
  check("different channel already touched → send (genuine 2nd channel)",
    decideFirstTouch({ isFirstStep: true, sequenceTriggerEvent: CAPTURED, stepChannel: "email", firstTouchedAt: "2026-06-13T00:00:00Z", firstTouchChannel: "ai_call" }) === "send")
  check("not the first step → send (no coordination)",
    decideFirstTouch({ isFirstStep: false, sequenceTriggerEvent: CAPTURED, stepChannel: "email", firstTouchedAt: "2026-06-13T00:00:00Z", firstTouchChannel: "email" }) === "send")
  check("non-welcome trigger (offer_accepted) day-0 → send",
    decideFirstTouch({ isFirstStep: true, sequenceTriggerEvent: "offer_accepted", stepChannel: "email", firstTouchedAt: "2026-06-13T00:00:00Z", firstTouchChannel: "email" }) === "send")
  check("non-outreach channel (wait) → send",
    decideFirstTouch({ isFirstStep: true, sequenceTriggerEvent: CAPTURED, stepChannel: "wait", firstTouchedAt: null, firstTouchChannel: null }) === "send")
  check("sms welcome, already sms-touched → skip_duplicate",
    decideFirstTouch({ isFirstStep: true, sequenceTriggerEvent: CAPTURED, stepChannel: "sms", firstTouchedAt: "2026-06-13T00:00:00Z", firstTouchChannel: "sms" }) === "skip_duplicate")

  // ── Layer 2: live end-to-end (zero egress — skip path returns before dispatch) ──
  console.log("\n[Layer 2 · live step-executor defers instead of double-emailing]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { executeSequenceStep } = await import("../lib/campaign-sequences/step-executor")
  const supabase = createServiceClient()

  const { data: brokerage } = await supabase.from("brokerages").select("id").limit(1).maybeSingle()
  const { data: agent } = brokerage
    ? await supabase.from("agents").select("id, user_id").eq("brokerage_id", (brokerage as any).id).limit(1).maybeSingle()
    : { data: null }
  if (!brokerage || !agent) {
    console.log("  ⏭  Skipped — need a real brokerage + agent to scope the seed.")
    return report()
  }
  const brokerageId = (brokerage as any).id
  const agentId = (agent as any).id
  const createdBy = (agent as any).user_id ?? null
  const stamp = Date.now()

  // Seed: a contact ALREADY first-touched on email (speed-to-lead got there first).
  const { data: contact, error: cErr } = await supabase.from("contacts").insert({
    brokerage_id: brokerageId, agent_id: agentId,
    first_name: "ZZFirstTouch", last_name: "Buyer", email: `zz-ft-${stamp}@example.com`,
    contact_type: "buyer", source: "listing_landing_page",
    tcpa_consent: true, email_opt_out: false,
    first_touched_at: new Date().toISOString(), first_touch_channel: "email",
  }).select("id").single()
  if (cErr || !contact) { check("seed contact", false, cErr?.message); return report() }
  const contactId = (contact as any).id

  const { data: seq } = await supabase.from("campaign_sequences").insert({
    brokerage_id: brokerageId, name: `zz-ft-welcome-${stamp}`,
    sequence_type: "buyer_nurture", trigger_event: CAPTURED, is_active: true,
    compliance_gated: true, created_by: createdBy,
  }).select("id").single()
  const sequenceId = (seq as any)?.id
  const { data: step } = await supabase.from("campaign_sequence_steps").insert({
    sequence_id: sequenceId, step_number: 1, step_name: "Welcome email",
    channel: "email", delay_days: 0, subject: "Welcome", body: "Hi {{first_name}}", is_active: true,
  }).select("id").single()
  const { data: enr } = await supabase.from("sequence_enrollments").insert({
    sequence_id: sequenceId, contact_id: contactId, brokerage_id: brokerageId,
    status: "active", current_step: 0, next_step_at: new Date().toISOString(),
  }).select("id").single()
  const enrollmentId = (enr as any)?.id

  try {
    const result = await executeSequenceStep(enrollmentId)
    check("executor DEFERS the first touch (status skipped)", result.status === "skipped", `got ${result.status}`)

    const { data: execRows } = await supabase
      .from("sequence_step_executions").select("status, blocked_reason").eq("enrollment_id", enrollmentId)
    const skipRow = (execRows ?? []).find((r: any) => r.status === "skipped")
    check("a skipped execution row was logged with the coordination reason",
      !!skipRow && /coordinated/i.test((skipRow as any)?.blocked_reason ?? ""))

    // The decisive assertion: NO email was dispatched (no sent step-run, no sent execution).
    const sentExec = (execRows ?? []).find((r: any) => r.status === "sent")
    check("NO second welcome email was sent (no 'sent' execution row)", !sentExec)
    const { count: sentRuns } = await supabase
      .from("workflow_step_runs").select("id", { count: "exact", head: true })
      .eq("enrollment_id", enrollmentId).eq("status", "sent")
    check("NO dispatched workflow_step_run", (sentRuns ?? 0) === 0)

    // The hand-off is visible on the inter-manager bus (Command Center "managers talking").
    const { count: signalCount } = await supabase
      .from("manager_signals").select("id", { count: "exact", head: true })
      .eq("entity_id", contactId).eq("signal_type", "first_touch_deferred")
      .eq("from_manager", "campaign_orchestrator").eq("to_manager", "ai_isa")
    check("deferral published on the inter-manager bus", (signalCount ?? 0) > 0)

    // Enrollment advanced past the deferred step (the drip resumes at the day-2 SMS).
    const { data: after } = await supabase
      .from("sequence_enrollments").select("current_step").eq("id", enrollmentId).single()
    check("enrollment advanced past the deferred step", (after as any)?.current_step === 1)
  } finally {
    await supabase.from("manager_signals").delete().eq("entity_id", contactId)
    await supabase.from("workflow_step_runs").delete().eq("enrollment_id", enrollmentId)
    await supabase.from("sequence_step_executions").delete().eq("enrollment_id", enrollmentId)
    await supabase.from("sequence_enrollments").delete().eq("id", enrollmentId)
    await supabase.from("campaign_sequence_steps").delete().eq("sequence_id", sequenceId)
    await supabase.from("campaign_sequences").delete().eq("id", sequenceId)
    await supabase.from("contacts").delete().eq("id", contactId)
    const { count } = await supabase.from("contacts").select("id", { count: "exact", head: true }).eq("id", contactId)
    check("cleanup: seed removed (count == 0)", (count ?? 0) === 0)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
