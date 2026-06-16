#!/usr/bin/env tsx
/**
 * scripts/channel-preference-gate-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CHANNEL PREFERENCE gate — consent answers "is it legal?"; this answers
 * "does the contact WANT this channel?". AI-ISA speed-to-lead already honored
 * preferred_channel; the manager/agent send path (approveClientMessage) did not, so a
 * manager could fire an SMS at an email-only contact. Now a mismatched direct send is
 * BLOCKED at the same provable chokepoint as consent, naming the rail to re-propose on.
 *
 * Layer 1 (pure): honorsChannelPreference matrix — match allows, mismatch blocks,
 *   portal/social/no-preference never block (honest: no fabricated enforcement).
 * Layer 2 (live, provider-free): seed a real contact with preferred_channel='email' +
 *   FULL SMS consent → propose an SMS via proposeClientMessage → approve → assert it
 *   FAILS with a "prefers email" reason (the block fires BEFORE any SMS provider call),
 *   while a portal message to the SAME contact is delivered (portal bypasses preference).
 *   All seeds cleaned up. No mocks, no real sends.
 *
 * Run: npx tsx scripts/channel-preference-gate-simulator.ts   (npm run test:channel-preference)
 */
import { honorsChannelPreference } from "../lib/compliance/contact-channel-gate"

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
  console.log(" ✅ Channel preference gate verified — wanted channel honored, mismatch blocked, portal/social/none pass.")
  console.log(" CHANNEL_PREFERENCE_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Channel preference gate simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · honorsChannelPreference matrix]")
  // Match → allowed.
  check("preferred email + email send → allowed", honorsChannelPreference("email", "email").allowed)
  check("preferred sms + sms send → allowed", honorsChannelPreference("sms", "sms").allowed)
  check("preferred phone + voice_drop send → allowed", honorsChannelPreference("phone", "voice_drop").allowed)
  // Mismatch → blocked, reason names the preferred rail.
  const m1 = honorsChannelPreference("email", "sms")
  check("preferred email + sms send → BLOCKED", !m1.allowed && /prefers email/i.test(m1.reason ?? ""))
  check("preferred sms + email send → BLOCKED", !honorsChannelPreference("sms", "email").allowed)
  check("preferred phone + email send → BLOCKED (names phone/voice)", /phone\/voice/i.test(honorsChannelPreference("phone", "email").reason ?? ""))
  // Honest non-blocks.
  check("no preference → never blocks", honorsChannelPreference(null, "sms").allowed && honorsChannelPreference("", "email").allowed)
  check("portal always honored regardless of preference", honorsChannelPreference("email", "portal").allowed && honorsChannelPreference("sms", "portal_push").allowed)
  check("unmappable preference (direct_mail/social) → never blocks", honorsChannelPreference("direct_mail", "sms").allowed && honorsChannelPreference("facebook", "email").allowed)
  check("preference matching is case/alias tolerant (text→sms, call→voice)", honorsChannelPreference("TEXT", "sms").allowed && honorsChannelPreference("call", "voice_drop").allowed)

  console.log("\n[Layer 2 · live: a manager SMS to an email-only contact is blocked before any provider]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (pure layer ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { proposeClientMessage, approveClientMessage } = await import("../lib/agents/agent-client-messages")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()

  const contactId = uuid()
  const approver = uuid()
  try {
    // Email-only contact, but with FULL SMS consent — so only PREFERENCE (not consent) can block the SMS.
    await svc.from("contacts").insert({
      id: contactId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "EmailOnly",
      contact_type: "buyer", email: "zz.preftest@example.com", phone: "+15555550123",
      preferred_channel: "email", tcpa_consent: true, dnc_status: false, sms_opt_out: false, email_opt_out: false,
    })

    // Propose an SMS → approve → must FAIL on the preference gate (no provider invoked).
    const smsProp = await proposeClientMessage({ brokerageId, agentKind: "shopping_agent", entityType: "contact", entityId: contactId, recipientContactId: contactId, audience: "buyer", body: "Quick text update on your search.", channel: "sms" }, svc)
    check("sms proposal created", smsProp.ok && !!smsProp.id)
    const smsRes = await approveClientMessage(smsProp.id!, approver, undefined, svc)
    check("approving the SMS to an email-only contact FAILS (preference block)", smsRes.status === "failed", JSON.stringify(smsRes.result))
    const { data: smsRow } = await svc.from("agent_client_messages").select("status, send_error").eq("id", smsProp.id!).maybeSingle()
    check("block reason names the preferred rail (email)", /prefers email/i.test((smsRow as any)?.send_error ?? ""), (smsRow as any)?.send_error)

    // A PORTAL message to the same contact bypasses preference → delivered.
    const portalProp = await proposeClientMessage({ brokerageId, agentKind: "shopping_agent", entityType: "contact", entityId: contactId, recipientContactId: contactId, audience: "buyer", subject: "Search update", body: "Three new homes matched your saved search.", channel: "portal" }, svc)
    const portalRes = await approveClientMessage(portalProp.id!, approver, undefined, svc)
    check("portal message to the same contact is delivered (preference n/a)", portalRes.status === "sent", JSON.stringify(portalRes.result))
  } finally {
    await svc.from("transparency_updates").delete().eq("contact_id", contactId).then(() => {}, () => {})
    await svc.from("agent_client_messages").delete().eq("recipient_contact_id", contactId).then(() => {}, () => {})
    await svc.from("contacts").delete().eq("id", contactId).then(() => {}, () => {})
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("id", contactId)
    check("cleanup: seeded contact removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
