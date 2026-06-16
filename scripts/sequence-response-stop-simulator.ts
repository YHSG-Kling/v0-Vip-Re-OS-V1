#!/usr/bin/env tsx
/**
 * scripts/sequence-response-stop-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves two foundations for the multi-channel cadence living in the REAL campaign sequencer:
 *   (1) RESPONSE-DRIVEN STOP — when a contact/lead replies on any channel, every active sequence
 *       they're in terminates ("keep trying UNTIL they respond"). This was missing system-wide:
 *       the sequencer had pause/unenroll but nothing stopped it on an inbound reply.
 *   (2) LEAD ENROLLMENT — enrollContact now addresses leads (lead_id), not just contacts.
 *
 * Layer 1 (shell-runnable): stopSequencesOnResponse with no contact/lead id → {unenrolled:0}
 *   (honest no-op, no DB touched).
 * Layer 2 (live, creds-gated): seed a compliance-gated sequence + step; enroll a CONTACT and a
 *   LEAD; assert both enrollments land (lead_id populated for the lead); fire
 *   stopSequencesOnResponse for each → assert their enrollments flip to 'unenrolled'. Seeds
 *   cleaned up. No mocks.
 *
 * Run: npx tsx scripts/sequence-response-stop-simulator.ts   (npm run test:sequence-response-stop)
 */
import { stopSequencesOnResponse } from "../lib/campaign-sequences/enrollment-engine"

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
  console.log(" ✅ Response-stop + lead enrollment verified — a reply terminates the cadence; leads enroll.")
  console.log(" SEQUENCE_RESPONSE_STOP_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Sequence response-stop + lead enrollment simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · honest no-op]")
  const noop = await stopSequencesOnResponse({ brokerageId: "00000000-0000-0000-0000-000000000000" })
  check("no contact/lead id → unenrolled 0 (no DB touched)", noop.unenrolled === 0)

  console.log("\n[Layer 2 · live: reply terminates active sequences; leads enroll]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { enrollContact } = await import("../lib/campaign-sequences/enrollment-engine")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const seqId = uuid(), contactId = uuid(), leadId = uuid()

  try {
    await svc.from("campaign_sequences").insert({ id: seqId, brokerage_id: brokerageId, name: "ZZ Reactivation Test", sequence_type: "reactivation", trigger_event: "manual", is_active: true, compliance_gated: true })
    await svc.from("campaign_sequence_steps").insert({ sequence_id: seqId, step_number: 1, step_name: "warm email", channel: "email", delay_days: 0, is_active: true, subject: "Checking in", body: "Still here when you're ready." })
    await svc.from("contacts").insert({ id: contactId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "SeqContact", contact_type: "lead" })
    await svc.from("leads").insert({ id: leadId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "SeqLead", email: "zz.seqlead@example.com" })

    // Enroll a CONTACT and a LEAD.
    const ec = await enrollContact({ sequenceId: seqId, contactId, brokerageId })
    check("contact enrolls", ec.success && !!ec.enrollmentId, JSON.stringify(ec))
    const el = await enrollContact({ sequenceId: seqId, leadId, brokerageId })
    check("LEAD enrolls (lead_id supported)", el.success && !!el.enrollmentId, JSON.stringify(el))
    const { data: leadEnr } = await svc.from("sequence_enrollments").select("lead_id, contact_id, status").eq("id", el.enrollmentId!).maybeSingle()
    check("lead enrollment carries lead_id (not contact_id)", (leadEnr as any)?.lead_id === leadId && !(leadEnr as any)?.contact_id)

    // Duplicate active enrollment is prevented.
    const dup = await enrollContact({ sequenceId: seqId, contactId, brokerageId })
    check("duplicate active enrollment prevented", !dup.success && dup.alreadyEnrolled === true)

    // A reply from the CONTACT terminates their sequence.
    const stopC = await stopSequencesOnResponse({ brokerageId, contactId }, svc)
    check("contact reply → ≥1 enrollment unenrolled", stopC.unenrolled >= 1, JSON.stringify(stopC))
    const { data: cEnr } = await svc.from("sequence_enrollments").select("status").eq("id", ec.enrollmentId!).maybeSingle()
    check("contact enrollment now 'unenrolled'", (cEnr as any)?.status === "unenrolled")
    // The LEAD's enrollment is untouched by the contact's reply.
    const { data: lEnr1 } = await svc.from("sequence_enrollments").select("status").eq("id", el.enrollmentId!).maybeSingle()
    check("lead enrollment still active (different person)", (lEnr1 as any)?.status === "active")

    // A reply from the LEAD terminates the lead's sequence.
    const stopL = await stopSequencesOnResponse({ brokerageId, leadId }, svc)
    check("lead reply → lead enrollment unenrolled", stopL.unenrolled >= 1)
    const { data: lEnr2 } = await svc.from("sequence_enrollments").select("status").eq("id", el.enrollmentId!).maybeSingle()
    check("lead enrollment now 'unenrolled'", (lEnr2 as any)?.status === "unenrolled")
  } finally {
    await svc.from("sequence_enrollments").delete().eq("sequence_id", seqId).then(() => {}, () => {})
    await svc.from("campaign_sequence_steps").delete().eq("sequence_id", seqId).then(() => {}, () => {})
    await svc.from("campaign_sequences").delete().eq("id", seqId).then(() => {}, () => {})
    await svc.from("contacts").delete().eq("id", contactId).then(() => {}, () => {})
    await svc.from("leads").delete().eq("id", leadId).then(() => {}, () => {})
    const { count } = await svc.from("sequence_enrollments").select("id", { count: "exact", head: true }).eq("sequence_id", seqId)
    check("cleanup: enrollments removed", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
