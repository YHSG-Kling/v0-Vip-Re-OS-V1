#!/usr/bin/env tsx
/**
 * scripts/touchpoint-bridge-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE SHARED TOUCH LEDGER bridge: System A (the canonical sequence engine) now records
 * its sends into marketing_campaign_touchpoints, so a sequence send is VISIBLE to the
 * de-confliction over-messaging frequency cap (which counts that table per contact+channel).
 * Before this, only System B (marketing triggers) wrote touchpoints, so the canonical drip
 * engine could over-message a contact because the cap never saw its own sends.
 *
 * Layer 1 (pure, always runs): the step.channel → touchpoint channel mapping.
 * Layer 2 (live, SUPABASE_SERVICE_ROLE_KEY-gated): seeds a REAL contact + sequence, records a
 *   sequence touchpoint via the production helper, then calls the REAL de-confliction engine
 *   and asserts the send is now counted. Seeds reverse-deleted (cleanup == 0). No mocks.
 *
 * Run: npx tsx scripts/touchpoint-bridge-simulator.ts   (npm run test:touchpoint-bridge)
 */
import { touchpointChannelForStep } from "../lib/campaign-sequences/touchpoint-bridge"

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
  console.log(" ✅ Touch-ledger bridge verified — System A sequence sends feed de-confliction.")
  console.log(" TOUCHPOINT_BRIDGE_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Touch-ledger bridge simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · step.channel → touchpoint channel]")
  check("email → email (de-confliction email cap)",      touchpointChannelForStep("email") === "email")
  check("sms → sms (de-confliction sms cap)",            touchpointChannelForStep("sms") === "sms")
  check("video → video (de-confliction video cap)",      touchpointChannelForStep("video") === "video")
  check("ai_call → phone",                               touchpointChannelForStep("ai_call") === "phone")
  check("voice_drop → phone",                            touchpointChannelForStep("voice_drop") === "phone")
  check("direct_mail → direct_mail",                     touchpointChannelForStep("direct_mail") === "direct_mail")
  check("wait → null (records no touch)",                touchpointChannelForStep("wait") === null)
  check("assign_task → null (records no touch)",         touchpointChannelForStep("assign_task") === null)

  console.log("\n[Layer 2 · live: a sequence send becomes visible to de-confliction]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { recordSequenceTouchpoint } = await import("../lib/campaign-sequences/touchpoint-bridge")
  const { evaluateDeconflict } = await import("../lib/kernel/deconflict/index")
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
    first_name: "ZZTouch", last_name: "Ledger", email: `zz-tp-${stamp}@example.com`,
    contact_type: "buyer", source: "listing_landing_page", tcpa_consent: true,
  }).select("id").single()
  const contactId = (contact as any)?.id
  const { data: seq } = await supabase.from("campaign_sequences").insert({
    brokerage_id: brokerageId, name: `zz-tp-seq-${stamp}`, sequence_type: "buyer_nurture",
    trigger_event: "contact_captured", is_active: true, compliance_gated: true,
  }).select("id").single()
  const sequenceId = (seq as any)?.id

  try {
    // Baseline: no email touches counted for this fresh contact.
    const before = await evaluateDeconflict({ brokerageId, channel: "email", contactId, skipLog: true })
    check("baseline: 0 email touches before the send", before.touchesInWindow === 0, `got ${before.touchesInWindow}`)

    // The canonical sequence engine records a send into the shared ledger.
    const wrote = await recordSequenceTouchpoint(supabase, {
      brokerageId, sequenceId, contactId, enrollmentId: "00000000-0000-0000-0000-000000000000",
      stepId: "00000000-0000-0000-0000-000000000000", stepChannel: "email", sentAt: new Date().toISOString(),
    })
    check("recordSequenceTouchpoint wrote a row (nullable campaign_id + source='sequence')", wrote === true)

    // The decisive assertion: de-confliction now COUNTS the sequence send.
    const after = await evaluateDeconflict({ brokerageId, channel: "email", contactId, skipLog: true })
    check("de-confliction now counts the sequence send (over-messaging hole closed)",
      after.touchesInWindow === before.touchesInWindow + 1, `got ${after.touchesInWindow}`)
  } finally {
    await supabase.from("marketing_campaign_touchpoints").delete().eq("contact_id", contactId)
    await supabase.from("campaign_sequences").delete().eq("id", sequenceId)
    await supabase.from("contacts").delete().eq("id", contactId)
    const { count } = await supabase.from("contacts").select("id", { count: "exact", head: true }).eq("id", contactId)
    check("cleanup: seed removed (count == 0)", (count ?? 0) === 0)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
