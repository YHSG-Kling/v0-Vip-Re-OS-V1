#!/usr/bin/env tsx
/**
 * scripts/buyer-intent-conversion-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the BUYER-side intent-conversion ROUTER (mirror of the seller side):
 * a buyer LEAD converts on POSITIVE INTENT and EACH intent type routes to its
 * OWN right milestone. Also proves the SELLER appointment_request intent case.
 *
 *   Layer 1 (pure, no I/O):
 *     - buyerIntentToMilestone routing per reason (positive_reply / criteria_request
 *       / preapproval_request / showing_request).
 *     - the seller side now accepts an 'appointment_request' reason (routes to the
 *       listing-appointment milestone).
 *
 *   Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY):
 *     - positive_reply      → converts to a (buyer) contact, agent notified,
 *                             leads.ai_isa_owner=false (ISA dormant); NO milestone.
 *     - criteria_request    → converts + property_preferences captured +
 *                             buyer_stage=BUYER_SEARCH_CONFIGURED + NO showing.
 *     - preapproval_request → converts + buyer_financial_profiles row started
 *                             (verified=false — requested, not completed).
 *     - showing_request     → converts THEN a showing scheduled (BBA-gated) — and
 *                             the SAME contact is NOT double-converted across reasons.
 *     - a buyer under representation → REFUSED (no contact).
 *     - a SELLER appointment_request → convert + listing.appointment_set fires +
 *                             the listing-appt-prep chain runs ONCE (money-leaves stubbed).
 *     - reverse-delete + cleanup count==0.
 *
 * Run:  npx tsx scripts/buyer-intent-conversion-simulator.ts   (npm run test:buyer-intent-conversion)
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

import { buyerIntentToMilestone } from "../lib/ai-isa/buyer-intent-router"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ───────────────────────────────────────────────────────────────────────────
// Layer 1 — PURE: the intent → milestone routing table.
// ───────────────────────────────────────────────────────────────────────────
function testPure() {
  console.log("\n[Layer 1 · pure — buyerIntentToMilestone routing table]")

  const pos = buyerIntentToMilestone("positive_reply")
  check("positive_reply → convert only (no milestone)",
    !pos.advancesStage && !pos.schedulesShowing && !pos.capturesCriteria && !pos.startsPreapproval && pos.targetStage === null,
    JSON.stringify(pos))

  const crit = buyerIntentToMilestone("criteria_request")
  check("criteria_request → captures criteria + advances to BUYER_SEARCH_CONFIGURED, NO showing",
    crit.capturesCriteria && crit.advancesStage && !crit.schedulesShowing && !crit.startsPreapproval &&
    crit.targetStage === "BUYER_SEARCH_CONFIGURED" && crit.kernelEvent === "buyer_search_configured",
    JSON.stringify(crit))

  const pre = buyerIntentToMilestone("preapproval_request")
  check("preapproval_request → starts pre-approval, does NOT fake a stage jump",
    pre.startsPreapproval && !pre.advancesStage && !pre.capturesCriteria && !pre.schedulesShowing && pre.targetStage === null,
    JSON.stringify(pre))

  const show = buyerIntentToMilestone("showing_request")
  check("showing_request → schedules showing + advances to BUYER_TOURING",
    show.schedulesShowing && show.advancesStage && !show.capturesCriteria && !show.startsPreapproval &&
    show.targetStage === "BUYER_TOURING" && show.kernelEvent === "tour_planned",
    JSON.stringify(show))

  // Each reason routes DIFFERENTLY — the whole point (no one-size-fits-all).
  const stages = [pos, crit, pre, show].map((p) => `${p.advancesStage}/${p.capturesCriteria}/${p.startsPreapproval}/${p.schedulesShowing}`)
  check("every intent has a DISTINCT routing fingerprint (router, not switch-to-one)",
    new Set(stages).size === 4, stages.join(" | "))

  console.log("\n[Layer 1 · pure — seller side accepts appointment_request]")
  // Type-level proof: the seller reason union now includes appointment_request. A
  // value assignment that type-checks is the proof (tsc enforces it at build).
  const sellerReason: import("../lib/ai-isa/convert-seller-lead-on-intent").SellerIntentReason = "appointment_request"
  check("seller SellerIntentReason includes 'appointment_request'", sellerReason === "appointment_request")
}

// ───────────────────────────────────────────────────────────────────────────
// Layer 2 — LIVE.
// ───────────────────────────────────────────────────────────────────────────
async function testLive() {
  console.log("\n[Layer 2 · live — buyer intent router + seller appointment_request]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("  ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { convertBuyerLeadOnIntent } = await import("../lib/ai-isa/convert-buyer-lead-on-intent")
  const { convertSellerLeadOnIntent } = await import("../lib/ai-isa/convert-seller-lead-on-intent")
  const { setListingApptPrepExecutors } = await import("../lib/workflow-orchestrator/chains/listing-appt-prep")
  const svc = createServiceClient()

  const TAG = `__bintent_${Date.now()}__`
  const cleanup: Array<{ table: string; column: string; value: string }> = []

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

  // Helper: seed a buyer LEAD in isa_qualifying so convertBuyerLeadOnIntent drives
  // the canonical handoff (consent → qualified → Engine-2 assignment → contact).
  async function seedBuyerLead(brokerageId: string, agentId: string, suffix: string): Promise<string | null> {
    const { data, error } = await svc.from("leads").insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      first_name: TAG,
      last_name: `Buyer_${suffix}`,
      email: `${TAG}_${suffix}@example.com`,
      lead_type: "buyer",
      motivation_type: "buyer",
      lifecycle_state: "isa_qualifying",
      is_active: true,
      ai_isa_owner: true,
      email_verified: true,
    }).select("id").single()
    if (error || !data) { check(`seed buyer lead (${suffix})`, false, error?.message); return null }
    const id = (data as any).id as string
    cleanup.push({ table: "lead_sla_tracking", column: "lead_id", value: id })
    cleanup.push({ table: "ai_isa_activities", column: "lead_id", value: id })
    cleanup.push({ table: "assignment_log", column: "lead_id", value: id })
    cleanup.push({ table: "ai_isa_qualifications", column: "lead_id", value: id })
    cleanup.push({ table: "lifecycle_events", column: "entity_id", value: id })
    cleanup.push({ table: "leads", column: "id", value: id })
    return id
  }

  function registerContactCleanup(contactId: string) {
    cleanup.push({ table: "agent_intro_videos", column: "contact_id", value: contactId })
    cleanup.push({ table: "transparency_updates", column: "contact_id", value: contactId })
    cleanup.push({ table: "activities", column: "contact_id", value: contactId })
    cleanup.push({ table: "property_preferences", column: "contact_id", value: contactId })
    cleanup.push({ table: "buyer_financial_profiles", column: "contact_id", value: contactId })
    cleanup.push({ table: "showing_requests", column: "contact_id", value: contactId })
    cleanup.push({ table: "buyer_broker_agreements", column: "buyer_contact_id", value: contactId })
    cleanup.push({ table: "cma_reports", column: "contact_id", value: contactId })
    cleanup.push({ table: "workflow_runs", column: "contact_id", value: contactId })
    cleanup.push({ table: "ai_isa_activities", column: "contact_id", value: contactId })
    cleanup.push({ table: "notifications", column: "contact_id", value: contactId })
    cleanup.push({ table: "lifecycle_events", column: "entity_id", value: contactId })
    cleanup.push({ table: "calendar_events", column: "entity_id", value: contactId })
    cleanup.push({ table: "contacts", column: "id", value: contactId })
  }

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
    const agentUserId = (agent as any).user_id as string

    // ════════════════════════════════════════════════════════════════════════
    // (1) positive_reply → convert only, dormant, agent notified, no milestone.
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n  ── (1) positive_reply → convert only ──")
    const posLead = await seedBuyerLead(brokerageId, agentId, "pos")
    if (posLead) {
      const r = await convertBuyerLeadOnIntent({ brokerageId, leadId: posLead, reason: "positive_reply" })
      check("(1) convert succeeded", r.success, r.error)
      if (r.contactId) registerContactCleanup(r.contactId)
      check("(1) landed as a BUYER contact with the agent assigned", await isBuyerContact(svc, r.contactId, agentId), r.contactId ?? "no contact")
      check("(1) agent notified", r.agentNotified === true, String(r.agentNotified))
      const { data: la } = await svc.from("leads").select("ai_isa_owner, is_active, contact_id").eq("id", posLead).maybeSingle()
      check("(1) ISA DORMANT (ai_isa_owner=false, lead inactive, linked)",
        (la as any)?.ai_isa_owner === false && (la as any)?.is_active === false && (la as any)?.contact_id === r.contactId)
      check("(1) NO milestone (buyer_stage unchanged, no prefs/profile/showing)",
        r.buyerStage == null && !r.preferencesId && !r.financialProfileId && !r.showingRequestId,
        JSON.stringify({ s: r.buyerStage, p: r.preferencesId, f: r.financialProfileId, sh: r.showingRequestId }))
    }

    // ════════════════════════════════════════════════════════════════════════
    // (2) criteria_request → capture property_preferences + BUYER_SEARCH_CONFIGURED, NO showing.
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n  ── (2) criteria_request → saved search + stage advance ──")
    const critLead = await seedBuyerLead(brokerageId, agentId, "crit")
    if (critLead) {
      const r = await convertBuyerLeadOnIntent({
        brokerageId, leadId: critLead, reason: "criteria_request",
        criteria: { minPrice: 400000, maxPrice: 600000, minBeds: 3, cities: ["Tampa"], propertyTypes: ["single_family"] },
      })
      check("(2) convert succeeded", r.success, r.error)
      if (r.contactId) registerContactCleanup(r.contactId)
      check("(2) property_preferences captured", !!r.preferencesId, "no preferencesId")
      const { data: pref } = r.preferencesId
        ? await svc.from("property_preferences").select("contact_id, preferred_price_min, inferred_cities").eq("id", r.preferencesId).maybeSingle()
        : { data: null }
      check("(2) saved search is on this contact with the captured criteria",
        (pref as any)?.contact_id === r.contactId && Number((pref as any)?.preferred_price_min) === 400000 &&
        Array.isArray((pref as any)?.inferred_cities) && (pref as any)?.inferred_cities.includes("Tampa"),
        JSON.stringify(pref))
      check("(2) buyer_stage advanced to BUYER_SEARCH_CONFIGURED", r.buyerStage === "BUYER_SEARCH_CONFIGURED", String(r.buyerStage))
      const { data: c } = await svc.from("contacts").select("buyer_stage").eq("id", r.contactId!).maybeSingle()
      check("(2) contacts.buyer_stage persisted = BUYER_SEARCH_CONFIGURED", (c as any)?.buyer_stage === "BUYER_SEARCH_CONFIGURED", String((c as any)?.buyer_stage))
      check("(2) NO showing scheduled for a criteria intent", !r.showingRequestId, r.showingRequestId ?? "")
    }

    // ════════════════════════════════════════════════════════════════════════
    // (3) preapproval_request → buyer_financial_profiles started (verified=false).
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n  ── (3) preapproval_request → pre-approval started ──")
    const preLead = await seedBuyerLead(brokerageId, agentId, "pre")
    if (preLead) {
      const r = await convertBuyerLeadOnIntent({
        brokerageId, leadId: preLead, reason: "preapproval_request",
        preapproval: { financeType: "conventional", estimatedMonthlyBudget: 3200 },
      })
      check("(3) convert succeeded", r.success, r.error)
      if (r.contactId) registerContactCleanup(r.contactId)
      check("(3) buyer_financial_profiles row started", !!r.financialProfileId, "no financialProfileId")
      const { data: fp } = r.financialProfileId
        ? await svc.from("buyer_financial_profiles").select("contact_id, verified, finance_type, lender_referral_status").eq("id", r.financialProfileId).maybeSingle()
        : { data: null }
      check("(3) pre-approval started but NOT yet verified (honest — requested, not completed)",
        (fp as any)?.contact_id === r.contactId && (fp as any)?.verified === false && (fp as any)?.lender_referral_status === "requested",
        JSON.stringify(fp))
    }

    // ════════════════════════════════════════════════════════════════════════
    // (4) showing_request → convert THEN schedule a showing (BBA-gated); no double-convert.
    //     Convert first with positive_reply (creates the contact), seed an active BBA,
    //     then call again with showing_request — the SAME contact routes to a showing.
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n  ── (4) showing_request → BBA-gated showing on the SAME contact ──")
    const showLead = await seedBuyerLead(brokerageId, agentId, "show")
    if (showLead) {
      const conv = await convertBuyerLeadOnIntent({ brokerageId, leadId: showLead, reason: "positive_reply" })
      check("(4) initial convert succeeded", conv.success, conv.error)
      const contactId = conv.contactId
      if (contactId) registerContactCleanup(contactId)

      // BBA gate FIRST: with NO active BBA, the showing must be refused (still converts).
      const blocked = await convertBuyerLeadOnIntent({
        brokerageId, leadId: showLead, reason: "showing_request",
        propertyRef: { propertyAddress: `${TAG} 9 Bayshore Blvd`, propertyCity: "Tampa", propertyState: "FL", preferredDates: [{ date: futureDate(3), time: "11:00" }] },
      })
      check("(4) without a BBA the showing is REFUSED (NAR 2024) but the contact is unchanged/converted",
        blocked.success && blocked.contactId === contactId && blocked.alreadyConverted === true &&
        blocked.showingBlockedByBBA === true && !blocked.showingRequestId,
        JSON.stringify(blocked))

      // Seed an ACTIVE signed BBA, then the showing schedules.
      if (contactId) {
        const { error: bbaErr } = await svc.from("buyer_broker_agreements").insert({
          brokerage_id: brokerageId,
          buyer_contact_id: contactId,
          agent_id: agentId,
          agreement_type: "exclusive",
          commission_payer: "seller",
          property_type_scope: {},
          status: "active",
          signed_at: new Date().toISOString(),
          created_by: agentUserId,
        })
        check("(4) seed an active signed BBA", !bbaErr, bbaErr?.message)
      }

      const r = await convertBuyerLeadOnIntent({
        brokerageId, leadId: showLead, reason: "showing_request",
        propertyRef: { propertyAddress: `${TAG} 9 Bayshore Blvd`, propertyCity: "Tampa", propertyState: "FL", preferredDates: [{ date: futureDate(3), time: "11:00" }] },
      })
      check("(4) showing_request routed (same contact, no double-convert)",
        r.success && r.contactId === contactId && r.alreadyConverted === true, JSON.stringify(r))
      check("(4) a showing was scheduled (BBA-gated)", !!r.showingRequestId, "no showingRequestId")
      const { data: sh } = r.showingRequestId
        ? await svc.from("showing_requests").select("contact_id, status, property_address").eq("id", r.showingRequestId).maybeSingle()
        : { data: null }
      check("(4) showing row is on this contact, pending",
        (sh as any)?.contact_id === contactId && (sh as any)?.status === "pending", JSON.stringify(sh))
      check("(4) buyer_stage advanced to BUYER_TOURING", r.buyerStage === "BUYER_TOURING", String(r.buyerStage))

      // No double-convert across reasons — still exactly ONE contact for this lead.
      const { count: cCount } = await svc.from("contacts")
        .select("id", { count: "exact", head: true }).eq("notes", `Promoted from lead ${showLead}`)
      check("(4) still exactly ONE contact for this lead (no double-convert across reasons)", (cCount ?? 0) === 1, `got ${cCount}`)
    }

    // ════════════════════════════════════════════════════════════════════════
    // (REFUSE) A buyer LEAD under representation is REFUSED — no contact.
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n  ── (refuse) buyer lead under representation ──")
    const { data: repLead } = await svc.from("leads").insert({
      brokerage_id: brokerageId, agent_id: agentId, first_name: `${TAG}rep`, last_name: "RepBuyer",
      email: `${TAG}rep@example.com`, lead_type: "buyer", lifecycle_state: "representation", is_active: true, ai_isa_owner: true,
    }).select("id").single()
    const repLeadId = (repLead as any)?.id as string | undefined
    if (repLeadId) {
      cleanup.push({ table: "lifecycle_events", column: "entity_id", value: repLeadId })
      cleanup.push({ table: "ai_isa_activities", column: "lead_id", value: repLeadId })
      cleanup.push({ table: "leads", column: "id", value: repLeadId })
      const rr = await convertBuyerLeadOnIntent({ brokerageId, leadId: repLeadId, reason: "positive_reply" })
      check("(refuse) buyer under representation is REFUSED (no convert)",
        rr.success === false && /representation/i.test(rr.error ?? ""), rr.error)
      const { count: repContacts } = await svc.from("contacts")
        .select("id", { count: "exact", head: true }).eq("notes", `Promoted from lead ${repLeadId}`)
      check("(refuse) refused buyer created NO contact", (repContacts ?? 0) === 0, `got ${repContacts}`)
    }

    // ════════════════════════════════════════════════════════════════════════
    // (S) SELLER appointment_request → convert + listing.appointment_set + chain ONCE.
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n  ── (S) seller appointment_request → convert + listing-appt-prep chain once ──")
    const propertyData = { address: `${TAG} 14 Cypress Ln`, city: "Tampa", state: "FL", zip: "33602", bedrooms: 4, bathrooms: 3, sqft: 2400, propertyType: "single_family" }
    const { data: sLead } = await svc.from("leads").insert({
      brokerage_id: brokerageId, agent_id: agentId, first_name: `${TAG}sell`, last_name: "ApptSeller",
      email: `${TAG}sell@example.com`, lead_type: "seller", motivation_type: "seller_motivated",
      lifecycle_state: "isa_qualifying", is_active: true, ai_isa_owner: true, email_verified: true,
      address: propertyData.address, city: propertyData.city, state: propertyData.state,
    }).select("id").single()
    const sLeadId = (sLead as any)?.id as string | undefined
    if (sLeadId) {
      cleanup.push({ table: "lead_sla_tracking", column: "lead_id", value: sLeadId })
      cleanup.push({ table: "ai_isa_activities", column: "lead_id", value: sLeadId })
      cleanup.push({ table: "assignment_log", column: "lead_id", value: sLeadId })
      cleanup.push({ table: "ai_isa_qualifications", column: "lead_id", value: sLeadId })
      cleanup.push({ table: "lifecycle_events", column: "entity_id", value: sLeadId })
      cleanup.push({ table: "leads", column: "id", value: sLeadId })

      const startAt = new Date(Date.now() + 6 * 86_400_000)
      const endAt = new Date(startAt.getTime() + 60 * 60_000)
      const s = await convertSellerLeadOnIntent({
        brokerageId, leadId: sLeadId, reason: "appointment_request", propertyData,
        appointment: { startAt, endAt, timezoneName: "America/New_York", location: propertyData.address },
      })
      check("(S) seller appointment_request convert+book succeeded", s.success, s.error)
      const sContact = s.contactId
      if (sContact) registerContactCleanup(sContact)
      if (s.calendarEventId) cleanup.push({ table: "calendar_events", column: "id", value: s.calendarEventId })
      check("(S) converted to a SELLER contact", await isSellerContact(svc, sContact), sContact ?? "no contact")
      check("(S) listing appointment booked + chain started", !!s.calendarEventId && !!s.chainRunId, JSON.stringify({ cal: s.calendarEventId, run: s.chainRunId }))
      const { data: runs } = await svc.from("workflow_runs")
        .select("id, trigger_event").eq("contact_id", sContact ?? "").eq("chain_key", "listing-appt-prep")
      const runList = (runs ?? []) as Array<{ trigger_event: string }>
      check("(S) exactly ONE listing-appt-prep run via listing.appointment_set",
        runList.length === 1 && runList[0].trigger_event === "listing.appointment_set",
        `count=${runList.length} trigger=${runList[0]?.trigger_event}`)
      check("(S) money-leaves each ran exactly once (no real spend)",
        cmaCalls === 1 && presCalls === 1 && videoCalls === 1, `cma=${cmaCalls} pres=${presCalls} vid=${videoCalls}`)
      const { count: sContacts } = await svc.from("contacts")
        .select("id", { count: "exact", head: true }).eq("notes", `Promoted from lead ${sLeadId}`)
      check("(S) exactly ONE seller contact (no double-convert across handoff + book)", (sContacts ?? 0) === 1, `got ${sContacts}`)
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

async function isBuyerContact(svc: any, contactId: string | undefined, agentId: string): Promise<boolean> {
  if (!contactId) return false
  const { data } = await svc.from("contacts").select("contact_type, agent_id").eq("id", contactId).maybeSingle()
  return (data?.contact_type === "buyer" || data?.contact_type === "both") && data?.agent_id === agentId
}
async function isSellerContact(svc: any, contactId: string | undefined): Promise<boolean> {
  if (!contactId) return false
  const { data } = await svc.from("contacts").select("contact_type").eq("id", contactId).maybeSingle()
  return data?.contact_type === "seller"
}
function futureDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Buyer Intent → Conversion ROUTER simulator (+ seller appointment_request)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" BUYER_INTENT_CONVERSION_PASS — buyer converts on positive intent and each intent routes to its right milestone (criteria→saved-search+SEARCH_CONFIGURED, preapproval→profile started, showing→BBA-gated showing+TOURING, positive→convert only); seller appointment_request books the listing appointment + runs the chain once; idempotent, honest-guarded, cleanup verified")
}
main().catch((e) => { console.error(e); process.exit(1) })
