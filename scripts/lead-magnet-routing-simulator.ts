#!/usr/bin/env tsx
/**
 * scripts/lead-magnet-routing-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the LEAD-MAGNET → KERNEL → MANAGER handoff (capture becomes a routed lead, not a row):
 *   · the kernel stamps the new contact's INTENT from the magnet so the portal view + education match
 *     (buyer guide → contact_type 'buyer'; seller guide → 'seller'),
 *   · and hands the lead to the right manager on the bus (buyer → Shopping Agent; seller → Listing
 *     Concierge), while a home-value request keeps its stronger precise-CMA handoff.
 * Also re-proves the capture bug fix (the form read used a non-existent `metadata` column → every
 * submission failed; now reads magnet_type).
 *
 * Layer 1 (pure): classifyMagnetIntent across every magnet type.
 * Layer 2 (live, creds-gated): seed a buyer_guide form, capture a submission, assert the new contact is
 * contact_type='buyer' + a lead_magnet_handoff signal to shopping_agent; a seller_guide → listing_concierge.
 * Reverse-delete; cleanup count == 0.
 *
 * Run: npx tsx scripts/lead-magnet-routing-simulator.ts   (npm run test:lead-magnet-routing)
 */
import { classifyMagnetIntent } from "../lib/marketing/lead-magnet-intent"
import { classifyCoordination } from "../lib/kernel/coordination-kind"
import { signalSpec } from "../lib/kernel/signal-registry"

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
  console.log(" ✅ Lead-magnet routing verified — capture stamps intent + hands the lead to the right manager.")
  console.log(" LEAD_MAGNET_ROUTING_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Lead-magnet → manager routing simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · classifyMagnetIntent]")
  check("home_valuation → seller / listing_concierge / isHomeValue", (() => { const r = classifyMagnetIntent("home_valuation"); return r.intent === "seller" && r.manager === "listing_concierge" && r.contactType === "seller" && r.isHomeValue })())
  check("buyer_guide → buyer / shopping_agent", (() => { const r = classifyMagnetIntent("buyer_guide"); return r.intent === "buyer" && r.manager === "shopping_agent" && r.contactType === "buyer" && !r.isHomeValue })())
  check("listing_alert + open_house → buyer / shopping_agent", classifyMagnetIntent("listing_alert").manager === "shopping_agent" && classifyMagnetIntent("open_house").intent === "buyer")
  check("seller_guide + market_report → seller / listing_concierge", classifyMagnetIntent("seller_guide").manager === "listing_concierge" && classifyMagnetIntent("market_report").contactType === "seller")
  check("generic_form → unknown (no routing, no stamp)", (() => { const r = classifyMagnetIntent("generic_form"); return r.intent === "unknown" && r.manager === null && r.contactType === null })())
  const spec = signalSpec("lead_magnet_handoff")
  check("lead_magnet_handoff catalogued (feed_only) + kind matches classifier", !!spec && spec.disposition === "feed_only" && spec.kind === classifyCoordination("lead_magnet_handoff"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  console.log("\n[Layer 2 · live capture → intent stamp + manager handoff]")
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { captureFormSubmission } = await import("../lib/kernel/lead-magnets")
  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⏭  Skipped — need a brokerage."); return report() }
  const brokerageId = (brk as any).id
  const { data: agent } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
  const agentId = (agent as any)?.id ?? null

  const cleanup: Array<{ table: string; id: string }> = []
  const contactIds: string[] = []

  async function runCase(magnetType: string, expectManager: string, expectType: string) {
    const { data: form } = await svc.from("lead_capture_forms").insert({
      brokerage_id: brokerageId, agent_id: agentId, name: `ZZ ${magnetType} ${Date.now()}`,
      slug: `zz-${magnetType}-${Date.now()}`, magnet_type: magnetType, is_active: true,
      fields: [{ name: "email", label: "Email", type: "email", required: true }],
    }).select("id").single()
    const formId = (form as any).id
    cleanup.push({ table: "lead_capture_forms", id: formId })

    const email = `zz-lmr-${magnetType}-${Date.now()}@example.com`
    const res: any = await captureFormSubmission({
      formId, brokerageId, source: `lead_magnet:${magnetType}`,
      submissionData: { email, first_name: "ZZ", last_name: "Router" },
    } as any)
    check(`[${magnetType}] capture succeeded (metadata-column bug fixed)`, res.success === true, JSON.stringify(res.error ?? res))
    const contactId = res.contactId
    if (contactId) { contactIds.push(contactId); cleanup.push({ table: "form_submissions", id: res.submissionId ?? "" }) }

    const { data: c } = await svc.from("contacts").select("contact_type").eq("id", contactId).maybeSingle()
    check(`[${magnetType}] new contact stamped contact_type='${expectType}'`, (c as any)?.contact_type === expectType, JSON.stringify(c))

    const { data: sig } = await svc.from("manager_signals")
      .select("to_manager, signal_type").eq("brokerage_id", brokerageId).eq("entity_id", contactId).eq("signal_type", "lead_magnet_handoff").maybeSingle()
    check(`[${magnetType}] handed off to ${expectManager}`, (sig as any)?.to_manager === expectManager, JSON.stringify(sig))

    // ASSIGNMENT: a NEW lead from this agent's magnet is owned by that agent (contacts.agent_id).
    check(`[${magnetType}] new lead assigned to the magnet's agent`, (c as any) && (await svc.from("contacts").select("agent_id").eq("id", contactId).maybeSingle()).data?.agent_id === agentId)
    return formId
  }

  try {
    const buyerFormId = await runCase("buyer_guide", "shopping_agent", "buyer")
    await runCase("seller_guide", "listing_concierge", "seller")

    // ── Assignment edge cases: claim an UNOWNED contact; never steal an OWNED one ──
    const claimEmail = `zz-claim-${Date.now()}@example.com`
    const { data: unowned } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "ZZ", last_name: `Unowned-${Date.now()}`, email: claimEmail, contact_type: "buyer",
    }).select("id, agent_id").single()
    contactIds.push((unowned as any).id)
    check("seed: the existing contact starts UNOWNED (agent_id null)", (unowned as any).agent_id == null)
    await captureFormSubmission({ formId: buyerFormId, brokerageId, source: "lead_magnet:buyer_guide", submissionData: { email: claimEmail, first_name: "ZZ", last_name: "Unowned" } } as any)
    const { data: claimed } = await svc.from("contacts").select("agent_id").eq("id", (unowned as any).id).maybeSingle()
    check("UNOWNED existing contact is CLAIMED by the magnet's agent", (claimed as any)?.agent_id === agentId, JSON.stringify(claimed))

    // No-steal: an existing contact already owned by a DIFFERENT agent is left untouched.
    const { data: otherAgent } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).neq("id", agentId).limit(1).maybeSingle()
    if (otherAgent) {
      const ownedEmail = `zz-owned-${Date.now()}@example.com`
      const { data: owned } = await svc.from("contacts").insert({
        brokerage_id: brokerageId, agent_id: (otherAgent as any).id, first_name: "ZZ", last_name: `Owned-${Date.now()}`, email: ownedEmail, contact_type: "buyer",
      }).select("id").single()
      contactIds.push((owned as any).id)
      await captureFormSubmission({ formId: buyerFormId, brokerageId, source: "lead_magnet:buyer_guide", submissionData: { email: ownedEmail } } as any)
      const { data: stillOwned } = await svc.from("contacts").select("agent_id").eq("id", (owned as any).id).maybeSingle()
      check("OWNED existing contact is NOT stolen (keeps original agent)", (stillOwned as any)?.agent_id === (otherAgent as any).id)
    } else {
      console.log("  ⏭  no-steal sub-check skipped (only one agent in brokerage)")
    }
  } finally {
    for (const cid of contactIds) {
      await svc.from("manager_signals").delete().eq("entity_id", cid).then(() => {}, () => {})
      await svc.from("agent_client_messages").delete().eq("recipient_contact_id", cid).then(() => {}, () => {})
      await svc.from("sequence_enrollments").delete().eq("contact_id", cid).then(() => {}, () => {})
      await svc.from("lifecycle_events").delete().eq("entity_id", cid).then(() => {}, () => {})
      await svc.from("form_submissions").delete().eq("contact_id", cid).then(() => {}, () => {})
      await svc.from("notifications").delete().eq("entity_id", cid).then(() => {}, () => {})
    }
    for (const c of [...cleanup].reverse()) if (c.id) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    for (const cid of contactIds) await svc.from("contacts").delete().eq("id", cid).then(() => {}, () => {})
    let leftover = 0
    for (const cid of contactIds) { const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("entity_id", cid); leftover += count ?? 0 }
    check("cleanup: handoff signals removed (count == 0)", leftover === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
