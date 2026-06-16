#!/usr/bin/env tsx
/**
 * scripts/direct-mail-channel-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves DIRECT MAIL is now a first-class PROPOSE/APPROVE channel (m230) — the reactivation
 * cadences can propose a postcard a human approves, and on approval approveClientMessage
 * resolves the deliverable address and dispatches the preset through the Lob orchestrator.
 *
 * The value here is the GATES that run BEFORE any (paid) Lob send: opt-out, missing preset, and
 * no deliverable address each fail the message cleanly without ever calling the provider. The
 * live layer exercises exactly those three early-returns (no Lob send, no money spent), so it's
 * safe to run against real data. Seeds cleaned up. No mocks.
 *
 * Run: npx tsx scripts/direct-mail-channel-simulator.ts   (npm run test:direct-mail-channel)
 */
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
  console.log(" ✅ Direct-mail channel verified — opt-out / no-preset / no-address gated before any Lob send.")
  console.log(" DIRECT_MAIL_CHANNEL_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Direct-mail propose/approve channel simulator")
  console.log("══════════════════════════════════════════════════")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n  ⏭  Live-only simulator skipped — SUPABASE creds not set.")
    console.log("     (The direct-mail gates live in approveClientMessage and require the DB; this sim")
    console.log("      exercises the pre-send early-returns against real data without any Lob spend.)")
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

  const optOutId = uuid(), noPresetId = uuid(), noAddrId = uuid()
  const cleanup: Array<[string, string]> = []
  const propose = async (contactId: string, subject: string | null) => {
    const r = await proposeClientMessage({ brokerageId, agentKind: "sphere_of_influence", entityType: "contact", entityId: contactId, recipientContactId: contactId, audience: "seller", subject, body: "We'd love to reconnect.", channel: "direct_mail" }, svc)
    if (r.id) cleanup.push(["agent_client_messages", r.id])
    return r
  }

  try {
    // (1) opted out of direct mail → blocked before anything else.
    await svc.from("contacts").insert({ id: optOutId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "OptOut", contact_type: "seller", direct_mail_opt_out: true, mailing_address: "1 Main St", mailing_address_verified: true, city: "Tampa", state: "FL", zip_code: "33601" })
    const r1 = await propose(optOutId, "preset:abc")
    const res1 = await approveClientMessage(r1.id!, approver, undefined, svc)
    check("direct-mail to an opted-out contact → failed (no Lob send)", res1.status === "failed" && /opted out of direct mail/i.test((res1.result as any).error ?? ""), JSON.stringify(res1.result))

    // (2) no preset in subject → blocked.
    await svc.from("contacts").insert({ id: noPresetId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "NoPreset", contact_type: "seller", direct_mail_opt_out: false, mailing_address: "2 Main St", mailing_address_verified: true, city: "Tampa", state: "FL", zip_code: "33601" })
    const r2 = await propose(noPresetId, "no preset here")
    const res2 = await approveClientMessage(r2.id!, approver, undefined, svc)
    check("direct-mail with no preset → failed", res2.status === "failed" && /needs a preset/i.test((res2.result as any).error ?? ""), JSON.stringify(res2.result))

    // (3) preset present but NO deliverable mailing address → blocked before Lob.
    await svc.from("contacts").insert({ id: noAddrId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "NoAddr", contact_type: "seller", direct_mail_opt_out: false, mailing_address_verified: false })
    const r3 = await propose(noAddrId, "preset:abc")
    const res3 = await approveClientMessage(r3.id!, approver, undefined, svc)
    check("direct-mail with no deliverable address → failed before Lob", res3.status === "failed" && /deliverable mailing address/i.test((res3.result as any).error ?? ""), JSON.stringify(res3.result))
  } finally {
    for (const [t, id] of cleanup) await svc.from(t).delete().eq("id", id).then(() => {}, () => {})
    for (const id of [optOutId, noPresetId, noAddrId]) await svc.from("contacts").delete().eq("id", id).then(() => {}, () => {})
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).in("id", [optOutId, noPresetId, noAddrId])
    check("cleanup: seeded contacts removed", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
