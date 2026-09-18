#!/usr/bin/env tsx
/**
 * scripts/seller-appt-conversion-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CORRECTED seller-lead conversion flow: conversion happens on
 * POSITIVE INTENT (a positive ISA conversation / a CMA request) — DECOUPLED from
 * the listing APPOINTMENT, which is a separate, later milestone.
 *
 *   (A) positive-intent / CMA-request seller LEAD → convertSellerLeadOnIntent
 *         → converts lead→contact (canonical handoff), agent notified,
 *           ai_isa_owner=false (ISA dormant), the CMA proposed,
 *           and NO listing.appointment_set / NO listing-appt-prep run.
 *   (B) the SAME contact later books an appointment via bookSellerListingAppointment
 *         → listing.appointment_set fires + the flagship chain runs ONCE on the
 *           existing contact, with NO second conversion / NO second welcome.
 *   (C) a converted-no-appointment contact past the stale threshold →
 *         detectStaleContacts returns it (re-engage eligible); idempotent reruns.
 *       Then a lead under representation → refused; reverse-delete + cleanup==0.
 *
 * Layer 1 (pure, no I/O):
 *   - motivationToContactType maps a seller motivation to contact_type='seller'.
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY): real orchestration, the
 *   chain's money-leaves injected (NO D-ID / AVM / CMA spend), real DB.
 *
 * Run:  npx tsx scripts/seller-appt-conversion-simulator.ts   (npm run test:seller-appt-conversion)
 */

// ── test-only shim ──────────────────────────────────────────────────────────
// The chain's direct-mail leaves import `server-only`, which throws outside a
// Server Component. Neutralize it in the require cache BEFORE importing anything
// that transitively pulls it.
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }
// ─────────────────────────────────────────────────────────────────────────────

import { motivationToContactType } from "../lib/contact-promotion/contact-creator"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ───────────────────────────────────────────────────────────────────────────
// Layer 1 — PURE: the converter persists the ISA's seller intent as contact_type.
// Dual buyer/seller ('both') intent is preserved (must not regress).
// ───────────────────────────────────────────────────────────────────────────
function testPure() {
  console.log("\n[Layer 1 · pure — seller intent → contact_type]")
  check("a 'seller' motivation maps to contact_type='seller'",
    motivationToContactType("seller_motivated") === "seller", String(motivationToContactType("seller_motivated")))
  // Re-pinned 2026-08-31: the old expectation ('investor' stays a contact_type)
  // was a §2 waypoint — m593 executed the owner ruling "investor is a persona
  // and not a contact type", so the side is BUYER and the investing rides
  // contact_persona='investor' (m589, set by the creator via
  // resolveContactPersona). Still asserts the original defect can't return:
  // never mis-bucketed as seller.
  check("an 'investor' motivation maps to 'buyer' (persona carries the investing; never mis-bucketed as seller)",
    motivationToContactType("investor") === "buyer", String(motivationToContactType("investor")))
  check("a 'both' motivation maps to 'buyer' (dual buyer/seller preserved; persona='both' set by creator)",
    motivationToContactType("both") === "buyer", String(motivationToContactType("both")))
  check("a null motivation maps to null (caller falls back to lead_type)",
    motivationToContactType(null) === null)
}

// ───────────────────────────────────────────────────────────────────────────
// Layer 2 — LIVE.
// ───────────────────────────────────────────────────────────────────────────
async function testLive() {
  console.log("\n[Layer 2 · live — intent conversion DECOUPLED from appointment]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("  ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { convertSellerLeadOnIntent } = await import("../lib/ai-isa/convert-seller-lead-on-intent")
  const { bookSellerListingAppointment } = await import("../lib/ai-isa/book-seller-appointment")
  const { detectStaleContacts } = await import("../lib/ai-isa/stale-contact-detector")
  const { setListingApptPrepExecutors } = await import("../lib/workflow-orchestrator/chains/listing-appt-prep")
  const svc = createServiceClient()

  const TAG = `__sintent_${Date.now()}__`
  const cleanup: Array<{ table: string; column: string; value: string }> = []
  let leadId: string | null = null
  let contactId: string | null = null
  let repLeadId: string | null = null

  let cmaCalls = 0, presCalls = 0, videoCalls = 0
  setListingApptPrepExecutors({
    generateCMA: async () => { cmaCalls++; return { success: true, id: `${TAG}-cma`, valuation: 540000, pricingStrategy: "market" } },
    generatePresentation: async () => {
      presCalls++
      return { success: true, presentationId: `${TAG}-pres`, chapters: [{ title: "Pricing" }, { title: "Marketing" }], content: "fake presentation" }
    },
    generateChapterVideos: async () => {
      videoCalls++
      return { success: true, videoIds: [`${TAG}-v1`, `${TAG}-v2`], chapterTitles: ["Pricing", "Marketing"] }
    },
  })

  try {
    const { data: agent } = await svc
      .from("agents")
      .select("id, user_id, brokerage_id")
      .not("user_id", "is", null)
      .not("brokerage_id", "is", null)
      .eq("is_active", true)
      .limit(1)
      .single()
    if (!agent) { console.log("  ⏭  Skipped — need an active agent with user_id + brokerage_id."); return }
    const brokerageId = (agent as any).brokerage_id as string
    const agentId = (agent as any).id as string

    // ── Seed a seller LEAD showing positive intent (CMA request). It is in the
    //    isa_qualifying phase — convertSellerLeadOnIntent drives the canonical
    //    handoff (consent → qualified → assigned → contact).
    const propertyData = { address: `${TAG} 12 Cypress Ln`, city: "Tampa", state: "FL", zip: "33602", bedrooms: 4, bathrooms: 3, sqft: 2400, propertyType: "single_family" }
    const { data: lead, error: lErr } = await svc.from("leads").insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      first_name: TAG,
      last_name: "SellerLead",
      email: `${TAG}@example.com`,
      lead_type: "seller",
      motivation_type: "seller_motivated",
      lifecycle_state: "isa_qualifying",
      is_active: true,
      ai_isa_owner: true,
      email_verified: true,
      address: propertyData.address,
      city: propertyData.city,
      state: propertyData.state,
    }).select("id").single()
    check("seed positive-intent seller lead", !lErr && !!lead, lErr?.message)
    if (!lead) throw new Error("lead seed failed")
    leadId = (lead as any).id as string
    cleanup.push({ table: "lead_sla_tracking", column: "lead_id", value: leadId })
    cleanup.push({ table: "ai_isa_activities", column: "lead_id", value: leadId })
    cleanup.push({ table: "assignment_log", column: "lead_id", value: leadId })
    cleanup.push({ table: "ai_isa_qualifications", column: "lead_id", value: leadId })

    // ════════════════════════════════════════════════════════════════════════
    // (A) CONVERT ON INTENT — CMA request. NO appointment, NO chain.
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n  ── (A) positive-intent / CMA-request → convertSellerLeadOnIntent ──")
    const a = await convertSellerLeadOnIntent({ brokerageId, leadId, reason: "cma_request", propertyData })
    check("(A) convertSellerLeadOnIntent succeeded", a.success, a.error)
    contactId = a.contactId ?? null

    if (contactId) {
      cleanup.push({ table: "agent_intro_videos", column: "contact_id", value: contactId })
      cleanup.push({ table: "transparency_updates", column: "contact_id", value: contactId })
      cleanup.push({ table: "activities", column: "contact_id", value: contactId })
      cleanup.push({ table: "cma_reports", column: "contact_id", value: contactId })
      cleanup.push({ table: "workflow_runs", column: "contact_id", value: contactId })
      cleanup.push({ table: "ai_isa_activities", column: "contact_id", value: contactId })
      cleanup.push({ table: "notifications", column: "contact_id", value: contactId })
      cleanup.push({ table: "lifecycle_events", column: "entity_id", value: contactId })
      cleanup.push({ table: "calendar_events", column: "entity_id", value: contactId })
      cleanup.push({ table: "contacts", column: "id", value: contactId })
    }
    cleanup.push({ table: "lifecycle_events", column: "entity_id", value: leadId })
    cleanup.push({ table: "leads", column: "id", value: leadId })

    // (A) converts lead → contact
    check("(A) lead converted to a contact (contactId returned)", !!contactId, "no contactId")
    const { data: contactRow } = contactId
      ? await svc.from("contacts").select("id, contact_type, agent_id").eq("id", contactId).maybeSingle()
      : { data: null }
    check("(A) contact landed as a SELLER with the agent assigned",
      (contactRow as any)?.contact_type === "seller" && (contactRow as any)?.agent_id === agentId,
      `${(contactRow as any)?.contact_type}/${(contactRow as any)?.agent_id}`)

    // (A) ISA dormant: lead deactivated + ai_isa_owner=false
    const { data: leadAfterA } = await svc.from("leads").select("is_active, ai_isa_owner, contact_id").eq("id", leadId).maybeSingle()
    check("(A) ISA went DORMANT (ai_isa_owner=false, lead deactivated, linked)",
      (leadAfterA as any)?.ai_isa_owner === false && (leadAfterA as any)?.is_active === false && (leadAfterA as any)?.contact_id === contactId)

    // (A) agent notified of a new contact
    check("(A) agent was notified of the new contact", a.agentNotified === true, String(a.agentNotified))
    const { count: notifCount } = await svc.from("notifications")
      .select("id", { count: "exact", head: true }).eq("contact_id", contactId!).eq("type", "seller_intent_converted")
    check("(A) exactly one 'new contact to reach out to' notification", (notifCount ?? 0) === 1, `got ${notifCount}`)

    // (A) the CMA the lead asked for was proposed
    check("(A) the requested CMA was proposed (cma_reports row)", !!a.cmaReportId, "no cmaReportId")
    const { data: cmaRow } = a.cmaReportId
      ? await svc.from("cma_reports").select("id, contact_id, agent_id, status").eq("id", a.cmaReportId).maybeSingle()
      : { data: null }
    check("(A) the proposed CMA is on this contact (status draft = proposed)",
      (cmaRow as any)?.contact_id === contactId && (cmaRow as any)?.status === "draft", JSON.stringify(cmaRow))

    // (A) NO appointment fired, NO listing-appt-prep chain ran
    const { count: apptCountA } = await svc.from("calendar_events")
      .select("id", { count: "exact", head: true }).eq("entity_id", contactId!).eq("event_type", "isa_appointment")
    check("(A) NO listing appointment was scheduled on intent-conversion", (apptCountA ?? 0) === 0, `got ${apptCountA}`)
    const { count: chainCountA } = await svc.from("workflow_runs")
      .select("id", { count: "exact", head: true }).eq("contact_id", contactId!).eq("chain_key", "listing-appt-prep")
    check("(A) NO listing-appt-prep chain ran on intent-conversion", (chainCountA ?? 0) === 0, `got ${chainCountA}`)
    check("(A) NO money-leaves invoked on intent-conversion", cmaCalls === 0 && presCalls === 0 && videoCalls === 0,
      `cma=${cmaCalls} pres=${presCalls} vid=${videoCalls}`)

    // (A) idempotent rerun — same contact, no second notification / CMA
    const aRerun = await convertSellerLeadOnIntent({ brokerageId, leadId, reason: "cma_request", propertyData })
    check("(A) rerun returns SAME contact, alreadyConverted=true",
      aRerun.success && aRerun.contactId === contactId && aRerun.alreadyConverted === true, JSON.stringify(aRerun))
    const { count: notifCount2 } = await svc.from("notifications")
      .select("id", { count: "exact", head: true }).eq("contact_id", contactId!).eq("type", "seller_intent_converted")
    check("(A) rerun did NOT double-notify", (notifCount2 ?? 0) === 1, `got ${notifCount2}`)

    // ════════════════════════════════════════════════════════════════════════
    // (C) DORMANT → RE-ENGAGE — the converted-no-appt contact is stale-eligible.
    //     (Run before booking the appointment, while it has no appt + no activity.)
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n  ── (C) converted-no-appt contact → detectStaleContacts ──")
    // Fresh contacts land with last_contacted_at=null → immediately stale-eligible.
    const stale = await detectStaleContacts(brokerageId)
    const found = stale.some((s) => s.id === contactId)
    check("(C) the converted-no-appt contact is RE-ENGAGE eligible (detectStaleContacts)", found,
      `stale ids did not include the contact (n=${stale.length})`)
    const stale2 = await detectStaleContacts(brokerageId)
    check("(C) detection is idempotent (still eligible on rerun)", stale2.some((s) => s.id === contactId))

    // ════════════════════════════════════════════════════════════════════════
    // (B) SAME contact later books an appointment — chain runs ONCE, no re-convert.
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n  ── (B) SAME contact books appointment → listing.appointment_set + chain ──")
    const startAt = new Date(Date.now() + 6 * 86_400_000)
    const endAt = new Date(startAt.getTime() + 60 * 60_000)
    const b = await bookSellerListingAppointment({
      brokerageId, leadId, agentId, startAt, endAt, timezoneName: "America/New_York", location: propertyData.address, propertyData,
    })
    check("(B) bookSellerListingAppointment succeeded", b.success, b.error)
    check("(B) booked on the EXISTING contact (no second conversion)",
      b.contactId === contactId && b.alreadyConverted === true, `${b.contactId} already=${b.alreadyConverted}`)
    if (b.calendarEventId) cleanup.push({ table: "calendar_events", column: "id", value: b.calendarEventId })

    const { data: cal } = await svc.from("calendar_events")
      .select("id, entity_type, entity_id, event_type").eq("id", b.calendarEventId ?? "").maybeSingle()
    check("(B) ISA appointment row exists on the contact",
      (cal as any)?.entity_type === "contact" && (cal as any)?.entity_id === contactId && (cal as any)?.event_type === "isa_appointment",
      JSON.stringify(cal))

    check("(B) listing-appt-prep chain run started", !!b.chainRunId, "no chainRunId")
    const { data: runs } = await svc.from("workflow_runs")
      .select("id, trigger_event").eq("contact_id", contactId!).eq("chain_key", "listing-appt-prep")
    const runList = (runs ?? []) as Array<{ trigger_event: string }>
    check("(B) exactly ONE listing-appt-prep run (trigger listing.appointment_set)",
      runList.length === 1 && runList[0].trigger_event === "listing.appointment_set",
      `count=${runList.length} trigger=${runList[0]?.trigger_event}`)
    check("(B) money-leaves each ran exactly once (no real spend)",
      cmaCalls === 1 && presCalls === 1 && videoCalls === 1, `cma=${cmaCalls} pres=${presCalls} vid=${videoCalls}`)

    // (B) no second welcome — exactly one contact, one intro-video ledger key
    const { count: contactCount } = await svc.from("contacts")
      .select("id", { count: "exact", head: true }).eq("notes", `Promoted from lead ${leadId}`)
    check("(B) still exactly ONE contact for this lead (no double-convert)", (contactCount ?? 0) === 1, `got ${contactCount}`)

    // (B) idempotent rerun — no double chain run, no extra money-leaf calls
    const cmaBefore = cmaCalls, vidBefore = videoCalls
    const b2 = await bookSellerListingAppointment({
      brokerageId, leadId, agentId, startAt, endAt, timezoneName: "America/New_York", location: propertyData.address, propertyData,
    })
    check("(B) rerun still the same contact", b2.success && b2.contactId === contactId)
    const { count: runCount } = await svc.from("workflow_runs")
      .select("id", { count: "exact", head: true }).eq("contact_id", contactId!).eq("chain_key", "listing-appt-prep")
    check("(B) still exactly ONE chain run (deduped)", (runCount ?? 0) === 1, `got ${runCount}`)
    check("(B) rerun did NOT re-invoke the money leaves", cmaCalls === cmaBefore && videoCalls === vidBefore, `cma ${cmaCalls} vid ${videoCalls}`)

    // ════════════════════════════════════════════════════════════════════════
    // (REFUSE) A lead under representation is REFUSED.
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n  ── (refuse) lead under representation ──")
    const { data: repLead } = await svc.from("leads").insert({
      brokerage_id: brokerageId, agent_id: agentId, first_name: `${TAG}rep`, last_name: "RepSeller",
      email: `${TAG}rep@example.com`, lead_type: "seller", lifecycle_state: "representation", is_active: true, ai_isa_owner: true,
    }).select("id").single()
    repLeadId = (repLead as any)?.id as string | undefined ?? null
    if (repLeadId) {
      cleanup.push({ table: "lifecycle_events", column: "entity_id", value: repLeadId })
      cleanup.push({ table: "calendar_events", column: "entity_id", value: repLeadId })
      cleanup.push({ table: "ai_isa_activities", column: "lead_id", value: repLeadId })
      cleanup.push({ table: "leads", column: "id", value: repLeadId })
      const rr = await bookSellerListingAppointment({
        brokerageId, leadId: repLeadId, agentId, startAt, endAt, timezoneName: "America/New_York", location: "x", propertyData,
      })
      check("(refuse) lead under representation is REFUSED (no booking)",
        rr.success === false && /representation/i.test(rr.error ?? ""), rr.error)
      const { count: repContacts } = await svc.from("contacts")
        .select("id", { count: "exact", head: true }).eq("notes", `Promoted from lead ${repLeadId}`)
      check("(refuse) refused lead created NO contact", (repContacts ?? 0) === 0, `got ${repContacts}`)
    }
  } finally {
    setListingApptPrepExecutors(null)

    for (let i = cleanup.length - 1; i >= 0; i--) {
      const { table, column, value } = cleanup[i]
      try { await svc.from(table).delete().eq(column, value) } catch { /* noop */ }
    }
    let remaining = 0
    for (const { table, column, value } of cleanup) {
      const { count } = await svc.from(table).select("id", { count: "exact", head: true }).eq(column, value)
      remaining += count ?? 0
    }
    check("cleanup verified — 0 seeded rows remain", remaining === 0, `remaining=${remaining}`)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Seller Intent → Conversion (DECOUPLED from appointment) simulator")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ SELLER_INTENT_CONVERSION verified — convert-on-intent (CMA proposed, ISA dormant, agent notified) decoupled from the appointment milestone; re-engage covered; idempotent + honest-guarded")
}
main().catch((e) => { console.error(e); process.exit(1) })
