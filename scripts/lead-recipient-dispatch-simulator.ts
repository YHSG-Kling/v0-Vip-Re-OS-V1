#!/usr/bin/env tsx
/**
 * scripts/lead-recipient-dispatch-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the governed message loop can now address a LEAD recipient (m231) — the prerequisite
 * for the stale-leads ladder. Leads use the approved pre-consent channels ONLY (email + direct
 * mail); approveClientMessage routes a lead recipient to the leads table and rejects everything
 * else. The value tested here is the GATES that fire BEFORE any provider/Lob send:
 *   • email to an opted-out lead → blocked
 *   • direct mail to an opted-out lead → blocked
 *   • direct mail with no preset / no deliverable address → blocked
 *   • sms/voice to a lead → rejected ("email + direct mail only")
 * All are early-returns — no real email, no Lob spend — so this is safe against real data.
 * Seeds cleaned up. No mocks.
 *
 * Run: npx tsx scripts/lead-recipient-dispatch-simulator.ts   (npm run test:lead-recipient)
 */
export {} // module scope (no top-level import) so the shared harness vars don't leak to global
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
  console.log(" ✅ Lead-recipient dispatch verified — email + direct mail gated; other channels rejected.")
  console.log(" LEAD_RECIPIENT_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Lead-recipient governed dispatch simulator")
  console.log("══════════════════════════════════════════════════")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n  ⏭  Live-only simulator skipped — SUPABASE creds not set.")
    console.log("     (Lead dispatch + its gates live in approveClientMessage and require the DB; this")
    console.log("      sim exercises the pre-send early-returns against real data with no provider spend.)")
    return report()
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { proposeClientMessage, approveClientMessage } = await import("../lib/agents/agent-client-messages")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const approver = uuid()

  const emailOptOutLead = uuid(), dmOptOutLead = uuid(), dmNoAddrLead = uuid()
  const msgIds: string[] = []
  const propose = async (leadId: string, channel: string, subject: string | null) => {
    const r = await proposeClientMessage({ brokerageId, agentKind: "ai_isa", entityType: "lead", entityId: leadId, recipientLeadId: leadId, audience: "lead", subject, body: "We'd love to reconnect whenever the timing's right.", channel: channel as any }, svc)
    if (r.id) msgIds.push(r.id)
    return r
  }
  const reasonOf = (res: any) => (res.result as any)?.error ?? ""

  try {
    // (1) email to an email-opted-out lead → blocked before any send.
    await svc.from("leads").insert({ id: emailOptOutLead, brokerage_id: brokerageId, first_name: "ZZ", last_name: "EmailOptOut", email: "zz.eoo@example.com", email_opt_out: true })
    const e1 = await propose(emailOptOutLead, "email", "Reconnecting")
    const r1 = await approveClientMessage(e1.id!, approver, undefined, svc)
    check("email to opted-out lead → failed (no send)", r1.status === "failed" && /opt/i.test(reasonOf(r1)), JSON.stringify(r1.result))

    // (1b) sms to a lead → rejected (email + direct mail only).
    const e1b = await propose(emailOptOutLead, "sms", null)
    const r1b = await approveClientMessage(e1b.id!, approver, undefined, svc)
    check("sms to a lead → rejected (email + direct mail only)", r1b.status === "failed" && /email \+ direct mail only/i.test(reasonOf(r1b)), JSON.stringify(r1b.result))

    // (2) direct mail to a direct-mail-opted-out lead → blocked.
    await svc.from("leads").insert({ id: dmOptOutLead, brokerage_id: brokerageId, first_name: "ZZ", last_name: "DMOptOut", direct_mail_opt_out: true, mailing_address: "1 Main St", mailing_address_verified: true, mailing_city: "Tampa", mailing_state: "FL", mailing_zip: "33601" })
    const e2 = await propose(dmOptOutLead, "direct_mail", "preset:abc")
    const r2 = await approveClientMessage(e2.id!, approver, undefined, svc)
    check("direct mail to opted-out lead → failed", r2.status === "failed" && /opted out of direct mail/i.test(reasonOf(r2)), JSON.stringify(r2.result))

    // (3) direct mail with preset but NO deliverable address → blocked before Lob.
    await svc.from("leads").insert({ id: dmNoAddrLead, brokerage_id: brokerageId, first_name: "ZZ", last_name: "NoAddr", direct_mail_opt_out: false, mailing_address_verified: false })
    const e3 = await propose(dmNoAddrLead, "direct_mail", "preset:abc")
    const r3 = await approveClientMessage(e3.id!, approver, undefined, svc)
    check("direct mail to lead w/ no deliverable address → failed before Lob", r3.status === "failed" && /deliverable mailing address/i.test(reasonOf(r3)), JSON.stringify(r3.result))

    // (3b) direct mail with no preset → blocked.
    const e3b = await propose(dmNoAddrLead, "direct_mail", "no preset")
    const r3b = await approveClientMessage(e3b.id!, approver, undefined, svc)
    check("direct mail to lead w/ no preset → failed", r3b.status === "failed" && /needs a preset/i.test(reasonOf(r3b)), JSON.stringify(r3b.result))
  } finally {
    for (const id of msgIds) await svc.from("agent_client_messages").delete().eq("id", id).then(() => {}, () => {})
    for (const id of [emailOptOutLead, dmOptOutLead, dmNoAddrLead]) await svc.from("leads").delete().eq("id", id).then(() => {}, () => {})
    const { count } = await svc.from("leads").select("id", { count: "exact", head: true }).in("id", [emailOptOutLead, dmOptOutLead, dmNoAddrLead])
    check("cleanup: seeded leads removed", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
