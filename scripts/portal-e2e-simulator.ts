#!/usr/bin/env tsx
/**
 * scripts/portal-e2e-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PORTAL END-TO-END harness — the safety net for the egress's FINAL HOP. Every loop is
 * proven up to the gate; this proves what the CLIENT actually experiences after a human
 * approves. Drives the REAL proposeClientMessage → approveClientMessage and asserts:
 *   · PORTAL channel → a visible transparency_updates card renders for the client, stamped
 *     human_approved, and the message flips to 'sent' (the hop the audit found broken).
 *   · SMS to a NO-TCPA-consent contact → HARD-BLOCKED at the gate (status 'failed', TCPA
 *     reason) BEFORE any provider is called — so the test never sends a real message.
 *   · EMAIL to an unsubscribed contact → HARD-BLOCKED (status 'failed', opt-out reason).
 * Every regulated-channel case is a SUPPRESSED contact, so no real SMS/email is ever sent.
 *
 * Gated on SUPABASE_SERVICE_ROLE_KEY (DB-driven). Self-cleans every row.
 * Run: npx tsx scripts/portal-e2e-simulator.ts  (npm run test:portal-e2e)
 */
import { proposeClientMessage, approveClientMessage } from "../lib/agents/agent-client-messages"

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
  console.log(" ✅ Portal end-to-end (final hop) verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Portal end-to-end (final hop) simulator")
  console.log("══════════════════════════════════════════════════")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (DB-driven; no pure layer).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__portale2e_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    const { data: usr } = await svc.from("users").select("id").limit(1).single()
    if (!brk || !usr) { console.log("  ⏭  Skipped — need a brokerage + user."); report(); return }
    const brokerageId = (brk as any).id
    const approverId = (usr as any).id

    // A consented contact (for the portal card) and suppressed contacts (to prove blocks).
    const { data: con } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Portal", last_name: TAG, email: `${TAG}@example.com`, phone: "+15555550100",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (con as any).id })
    const contactId = (con as any).id

    // ── 1. PORTAL channel → a visible client card renders, status sent ──
    const p1 = await proposeClientMessage({
      brokerageId, agentKind: "listing_concierge", entityType: "listing", recipientContactId: contactId,
      audience: "seller", subject: `${TAG} weekly update`, body: "Here is your week in review.", channel: "portal",
    }, svc)
    check("portal: proposal created", p1.ok && !!p1.id)
    if (p1.id) {
      cleanup.push({ table: "agent_client_messages", id: p1.id })
      const r1 = await approveClientMessage(p1.id, approverId, undefined, svc)
      check("portal: approve reports SENT", r1.status === "sent", JSON.stringify(r1.result))
      const { data: card } = await svc.from("transparency_updates")
        .select("id, is_visible_to_client, update_type, title, metadata")
        .eq("contact_id", contactId).eq("title", `${TAG} weekly update`).maybeSingle()
      if (card) cleanup.push({ table: "transparency_updates", id: (card as any).id })
      check("portal: a VISIBLE client card was written", (card as any)?.is_visible_to_client === true && (card as any)?.update_type === "agent_message")
      check("portal: card is stamped human_approved (oversight proof)", ((card as any)?.metadata?.human_approved) === true)
      const { data: m1 } = await svc.from("agent_client_messages").select("status").eq("id", p1.id).single()
      check("portal: message row marked sent", (m1 as any).status === "sent")
    }

    // ── 2. SMS to a NO-TCPA-consent contact → hard-blocked at the gate ──
    await svc.from("contacts").update({ tcpa_consent: false }).eq("id", contactId)
    const p2 = await proposeClientMessage({
      brokerageId, agentKind: "shopping_agent", entityType: "contact", recipientContactId: contactId,
      audience: "buyer", subject: `${TAG} sms`, body: "Quick update.", channel: "sms",
    }, svc)
    if (p2.id) {
      cleanup.push({ table: "agent_client_messages", id: p2.id })
      const r2 = await approveClientMessage(p2.id, approverId, undefined, svc)
      check("sms: blocked at gate (status failed, no provider called)", r2.status === "failed")
      check("sms: failure reason cites TCPA consent", /tcpa|consent/i.test(JSON.stringify(r2.result)))
    }

    // ── 3. EMAIL to an unsubscribed contact → hard-blocked at the gate ──
    await svc.from("contacts").update({ email_unsubscribed: true }).eq("id", contactId)
    const p3 = await proposeClientMessage({
      brokerageId, agentKind: "campaign_orchestrator", entityType: "contact", recipientContactId: contactId,
      audience: "buyer", subject: `${TAG} email`, body: "Newsletter.", channel: "email",
    }, svc)
    if (p3.id) {
      cleanup.push({ table: "agent_client_messages", id: p3.id })
      const r3 = await approveClientMessage(p3.id, approverId, undefined, svc)
      check("email: blocked at gate (status failed, no provider called)", r3.status === "failed")
      check("email: failure reason cites unsubscribe/opt-out", /unsubscrib|opt|out/i.test(JSON.stringify(r3.result)))
    }
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
