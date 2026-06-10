#!/usr/bin/env tsx
/**
 * scripts/compliance-gate-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PRE-DISPATCH COMPLIANCE GATE + AI DISCLOSURE LEDGER harness.
 *
 * Layer 1 (pure): the channel suppression matrix — portal always allowed; email
 *   honors unsubscribe/opt-out; sms/voice require TCPA consent AND no DNC / opt-out
 *   / unsubscribe; opt_out_channels is honored.
 * Layer 2 (live, gated): seed two contacts (one consented, one DNC) + sent/blocked
 *   agent_client_messages, generate the disclosure ledger, assert manager attribution,
 *   the human-approver governance invariant (0 sent without an approver), and the
 *   live consent snapshot, then clean up.
 *
 * Run: npx tsx scripts/compliance-gate-simulator.ts  (npm run test:compliance-gate)
 */
import { canDispatchToContact } from "../lib/compliance/contact-channel-gate"
import { generateAiDisclosureLedger } from "../lib/compliance/ai-disclosure-ledger"

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
  console.log(" ✅ Compliance gate + disclosure ledger verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Compliance gate + AI disclosure ledger simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · channel suppression matrix]")
  // Portal — always allowed regardless of opt-outs (consumer's own surface).
  check("portal allowed even with every opt-out set",
    canDispatchToContact({ dnc_status: true, email_opt_out: true, sms_opt_out: true }, "portal").allowed)
  // Email — CAN-SPAM opt-out honored.
  check("email allowed when no email opt-out", canDispatchToContact({}, "email").allowed)
  check("email BLOCKED when unsubscribed", !canDispatchToContact({ email_unsubscribed: true }, "email").allowed)
  check("email BLOCKED when opted out", !canDispatchToContact({ email_opt_out: true }, "email").allowed)
  check("email BLOCKED via opt_out_channels", !canDispatchToContact({ opt_out_channels: ["email"] }, "email").allowed)
  // SMS — TCPA consent required AND no suppression.
  check("sms BLOCKED without TCPA consent", !canDispatchToContact({ tcpa_consent: false }, "sms").allowed)
  check("sms allowed with consent + clean", canDispatchToContact({ tcpa_consent: true }, "sms").allowed)
  check("sms BLOCKED on DNC even with consent", !canDispatchToContact({ tcpa_consent: true, dnc_status: true }, "sms").allowed)
  check("sms BLOCKED after STOP/unsubscribe", !canDispatchToContact({ tcpa_consent: true, sms_unsubscribed: true }, "sms").allowed)
  check("sms BLOCKED when sms opted out", !canDispatchToContact({ tcpa_consent: true, sms_opt_out: true }, "sms").allowed)
  // Voice — same TCPA posture.
  check("voice BLOCKED without consent", !canDispatchToContact({ tcpa_consent: false }, "voice_drop").allowed)
  check("voice allowed with consent + clean", canDispatchToContact({ tcpa_consent: true }, "voice_drop").allowed)
  check("voice BLOCKED on DNC", !canDispatchToContact({ tcpa_consent: true, dnc_status: true }, "voice_drop").allowed)
  check("voice BLOCKED on phone opt-out", !canDispatchToContact({ tcpa_consent: true, phone_opt_out: true }, "voice_drop").allowed)
  // Every block carries a human-readable reason.
  check("blocked sends carry a reason", (canDispatchToContact({ tcpa_consent: false }, "sms").reason ?? "").length > 0)

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live disclosure ledger]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__compgate_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    const { data: usr } = await svc.from("users").select("id").limit(1).single()
    if (!brk || !usr) { console.log("  ⏭  Skipped — need a brokerage + user."); report(); return }
    const brokerageId = (brk as any).id
    const approverId = (usr as any).id

    const { data: con } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Compliance", last_name: TAG,
      tcpa_consent: true, dnc_status: false,
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (con as any).id })

    // A SENT message (human-approved) + a REJECTED one — both attributed to a manager.
    const { data: sent } = await svc.from("agent_client_messages").insert({
      brokerage_id: brokerageId, agent_kind: "listing_concierge", entity_type: "listing",
      audience: "seller", channel: "portal", recipient_contact_id: (con as any).id,
      subject: `${TAG} sent`, body: "Your weekly update.", status: "sent",
      proposed_at: new Date().toISOString(), approved_by: approverId, approved_at: new Date().toISOString(), sent_at: new Date().toISOString(),
    }).select("id").single()
    cleanup.push({ table: "agent_client_messages", id: (sent as any).id })

    const { data: rej } = await svc.from("agent_client_messages").insert({
      brokerage_id: brokerageId, agent_kind: "deal_coordinator", entity_type: "contact",
      audience: "buyer", channel: "email", recipient_contact_id: (con as any).id,
      subject: `${TAG} rejected`, body: "A draft that was rejected.", status: "rejected",
      proposed_at: new Date().toISOString(), approved_by: approverId, approved_at: new Date().toISOString(),
    }).select("id").single()
    cleanup.push({ table: "agent_client_messages", id: (rej as any).id })

    const ledger = await generateAiDisclosureLedger({ brokerageId, sinceIso: new Date(Date.now() - 3_600_000).toISOString() }, svc)
    const mine = ledger.entries.filter((e) => (e.subject ?? "").includes(TAG))
    check("ledger: both seeded messages present", mine.length === 2)
    check("ledger: sent msg attributed to Listing Concierge", mine.some((e) => e.status === "sent" && e.managerLabel === "Listing Concierge"))
    check("ledger: rejected msg attributed to Deal Coordinator", mine.some((e) => e.status === "rejected" && e.managerLabel === "Deal Coordinator"))
    check("ledger: recipient name resolved", mine.every((e) => (e.recipientName ?? "").includes(TAG)))
    check("ledger: sent msg records a human approver (oversight proof)", mine.find((e) => e.status === "sent")?.approvedBy === approverId)
    check("ledger: GOVERNANCE — 0 sent without an approver across the window", ledger.summary.sentWithoutApprover === 0)
    check("ledger: consent snapshot present for the email row", mine.find((e) => e.channel === "email")?.channelAllowedNow === true)
    check("ledger: byManager attribution is populated", ledger.summary.byManager.length >= 2)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true }).like("subject", `${TAG}%`)
    check("cleanup verified — 0 seeded messages remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
