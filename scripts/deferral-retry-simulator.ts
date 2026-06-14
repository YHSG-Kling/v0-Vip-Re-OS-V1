#!/usr/bin/env tsx
/**
 * scripts/deferral-retry-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves DEFER, DON'T DROP: when the de-confliction frequency cap blocks a sequence send
 * (one more touch would over-message the contact), the step-executor RESCHEDULES the same step
 * instead of treating it as a failed send and advancing past it — so the touch is preserved and
 * retried once the over-touch window clears (bounded by MAX_DEFERS).
 *
 * Layer 1 (pure, always runs): the deferral decision policy + deferral detection.
 * Layer 2 (live, SUPABASE_SERVICE_ROLE_KEY-gated): seeds a contact already at the email cap
 *   (3 touchpoints / 14d) + a welcome sequence + enrollment, runs the REAL step-executor, and
 *   asserts the step was rescheduled (current_step unchanged, next_step_at pushed out, a skipped
 *   'over-touch deferral' row logged) — NOT advanced. The deconflict gate returns before any
 *   provider send, so this is zero-egress. Seeds reverse-deleted (cleanup == 0). No mocks.
 *
 * Run: npx tsx scripts/deferral-retry-simulator.ts   (npm run test:deferral-retry)
 */
import { decideDeferral, isDeconflictDeferral, MAX_DEFERS, DEFER_BACKOFF_MS } from "../lib/campaign-sequences/deferral-policy"

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
  console.log(" ✅ Deferral-retry verified — an over-touch defers the step, never drops the touch.")
  console.log(" DEFERRAL_RETRY_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Deferral-retry simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · deferral detection + decision]")
  check("deconflict_gate + non-sent → is a deferral",  isDeconflictDeferral("deconflict_gate", "error") === true)
  check("deconflict_gate + sent → NOT a deferral",     isDeconflictDeferral("deconflict_gate", "sent") === false)
  check("real provider failure → NOT a deferral",      isDeconflictDeferral("sendgrid", "error") === false)
  const now = Date.UTC(2026, 5, 14, 0, 0, 0)
  const d0 = decideDeferral(0, now)
  check("1st deferral → reschedule attempt 1",         d0.action === "reschedule" && d0.attempt === 1)
  check("reschedule backoff is ~24h out",              d0.nextStepAt === new Date(now + DEFER_BACKOFF_MS).toISOString())
  check(`(${MAX_DEFERS - 1})th deferral → still reschedule`, decideDeferral(MAX_DEFERS - 1, now).action === "reschedule")
  check(`${MAX_DEFERS}th deferral → give_up (advance)`, decideDeferral(MAX_DEFERS, now).action === "give_up")

  console.log("\n[Layer 2 · live: an over-touched contact defers, doesn't drop]")
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
    ? await supabase.from("agents").select("id").eq("brokerage_id", (brokerage as any).id).limit(1).maybeSingle()
    : { data: null }
  if (!brokerage || !agent) { console.log("  ⏭  Skipped — need a real brokerage + agent."); return report() }
  const brokerageId = (brokerage as any).id
  const stamp = Date.now()

  const { data: contact } = await supabase.from("contacts").insert({
    brokerage_id: brokerageId, agent_id: (agent as any).id,
    first_name: "ZZDefer", last_name: "Buyer", email: `zz-defer-${stamp}@example.com`,
    contact_type: "buyer", source: "listing_landing_page", tcpa_consent: true, email_opt_out: false,
  }).select("id").single()
  const contactId = (contact as any)?.id
  const { data: seq } = await supabase.from("campaign_sequences").insert({
    brokerage_id: brokerageId, name: `zz-defer-seq-${stamp}`, sequence_type: "buyer_nurture",
    trigger_event: "contact_captured", is_active: true, compliance_gated: true,
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

  // Push the contact to the email cap (default 3 / 14d) so the next send is an over-touch.
  const recent = new Date().toISOString()
  for (let i = 0; i < 3; i++) {
    await supabase.from("marketing_campaign_touchpoints").insert({
      brokerage_id: brokerageId, sequence_id: sequenceId, contact_id: contactId,
      channel: "email", status: "sent", sent_at: recent, source: "sequence",
    })
  }

  try {
    const result = await executeSequenceStep(enrollmentId)
    check("executor DEFERS (status skipped, not failed-advance)", result.status === "skipped", `got ${result.status}`)

    const { data: after } = await supabase
      .from("sequence_enrollments").select("current_step, next_step_at, step_outputs").eq("id", enrollmentId).single()
    check("step NOT advanced (current_step still 0 — touch preserved)", (after as any)?.current_step === 0, `got ${(after as any)?.current_step}`)
    const nextAt = new Date((after as any)?.next_step_at ?? 0).getTime()
    check("next_step_at rescheduled into the future (~24h)", nextAt > Date.now() + 60_000)
    check("defer counter recorded on the enrollment", ((after as any)?.step_outputs?.__defers?.step_1 ?? 0) === 1)

    const { data: execRows } = await supabase
      .from("sequence_step_executions").select("status, blocked_reason").eq("enrollment_id", enrollmentId)
    const deferRow = (execRows ?? []).find((r: any) => /over-touch deferral/i.test(r.blocked_reason ?? ""))
    check("a deferral row was logged with the over-touch reason", !!deferRow)
    check("NO 'sent' execution row (nothing was actually sent)", !(execRows ?? []).some((r: any) => r.status === "sent"))
  } finally {
    await supabase.from("marketing_campaign_touchpoints").delete().eq("contact_id", contactId)
    await supabase.from("sequence_step_executions").delete().eq("enrollment_id", enrollmentId)
    await supabase.from("workflow_step_runs").delete().eq("enrollment_id", enrollmentId)
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
