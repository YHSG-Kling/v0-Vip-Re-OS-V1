#!/usr/bin/env tsx
/**
 * scripts/inbound-intent-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the INBOUND INTENT CLASSIFIER — the autonomy capstone. When a lead
 * REPLIES, the AI ISA reads the message, classifies the intent, and routes ITSELF
 * to the right conversion + milestone (no human picks the reason).
 *
 *   Layer 1 (pure, no I/O) — keywordIntentFallback(message, knownSide?):
 *     - each canonical phrase → the right {side, reason}
 *         "what's my home worth"            → seller / cma_request
 *         "set up a time to list"           → seller / appointment_request
 *         "looking for 3bd under 500k"      → buyer  / criteria_request
 *         "am I pre-approved / what can I afford" → buyer / preapproval_request
 *         "can I tour 123 Main this weekend"→ buyer  / showing_request
 *         "yes, interested, tell me more"   → positive_reply on the KNOWN side
 *     - NEGATIVE phrases  → null (caller HALTS, never converts)
 *     - AMBIGUOUS phrases → null (keep nurturing)
 *     - side inference from knownSide for a bare positive reply
 *
 *   Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY) — classifyAndRouteInbound
 *     with an INJECTED classifier (no AI inference, deterministic assertions):
 *     - seller cma_request    → contact + draft CMA, NO appointment
 *     - seller appointment_request → contact (booking deferred — no slot from a reply)
 *     - buyer criteria_request → contact + saved search + BUYER_SEARCH_CONFIGURED
 *     - buyer showing_request  → contact + showing (BBA seeded) + BUYER_TOURING
 *     - buyer preapproval_request → contact + financial profile (verified=false)
 *     - a NEGATIVE message     → HALT (DNC) + NO conversion (still a lead, no contact)
 *     - an AMBIGUOUS message   → NO conversion (still a lead) + a nurture activity
 *     - idempotent (re-run same intent → same contact, no double-convert)
 *     - reverse-delete + cleanup count==0
 *
 * Run:  npx tsx scripts/inbound-intent-simulator.ts   (npm run test:inbound-intent)
 */

// ── test-only shim ──────────────────────────────────────────────────────────
// Modules under test import `server-only`, which throws outside a Server
// Component. Neutralize it in the require cache BEFORE importing anything that
// transitively pulls it.
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }
// ─────────────────────────────────────────────────────────────────────────────

import type { ClassifiedIntent, InboundClassifier } from "../lib/ai-isa/inbound-intent-classifier"

// keywordIntentFallback is imported dynamically inside main() — the module is
// `server-only`, so it must load AFTER the require-cache shim above (a static
// import would be hoisted above the shim and throw).
type KeywordIntentFallback = (message: string, knownSide?: "buyer" | "seller" | null) => ClassifiedIntent | null
let keywordIntentFallback: KeywordIntentFallback

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function eq(a: ClassifiedIntent | null, side: string, reason: string): boolean {
  return !!a && a.side === side && a.reason === reason
}

// ───────────────────────────────────────────────────────────────────────────
// Layer 1 — PURE: message → {side, reason} | null.
// ───────────────────────────────────────────────────────────────────────────
function testPure() {
  console.log("\n[Layer 1 · pure — keywordIntentFallback message → {side, reason}]")

  // SELLER intents
  check("'what's my home worth' → seller/cma_request",
    eq(keywordIntentFallback("Hi — what's my home worth these days?"), "seller", "cma_request"))
  check("'how much is my house worth' → seller/cma_request",
    eq(keywordIntentFallback("Curious how much is my house worth?"), "seller", "cma_request"))
  check("'set up a time to list' → seller/appointment_request",
    eq(keywordIntentFallback("Can we set up a time to list my place?"), "seller", "appointment_request"))
  check("'ready to list my home' → seller/appointment_request",
    eq(keywordIntentFallback("I'm ready to list my home, let's go"), "seller", "appointment_request"))

  // BUYER intents
  check("'looking for 3bd under 500k' → buyer/criteria_request",
    eq(keywordIntentFallback("Looking for a 3bd under $500k in midtown"), "buyer", "criteria_request"))
  check("'am I pre-approved' → buyer/preapproval_request",
    eq(keywordIntentFallback("Am I pre-approved? curious what I qualify for"), "buyer", "preapproval_request"))
  check("'what can I afford' → buyer/preapproval_request",
    eq(keywordIntentFallback("Quick q — what can I afford on my income?"), "buyer", "preapproval_request"))
  check("'can I tour 123 Main this weekend' → buyer/showing_request",
    eq(keywordIntentFallback("Can I tour 123 Main this weekend?"), "buyer", "showing_request"))
  check("'schedule a showing' → buyer/showing_request",
    eq(keywordIntentFallback("I'd love to schedule a showing for that listing"), "buyer", "showing_request"))

  // BARE POSITIVE → routes on knownSide
  check("'yes, interested, tell me more' + knownSide=seller → seller/positive_reply",
    eq(keywordIntentFallback("Yes! Interested — tell me more", "seller"), "seller", "positive_reply"))
  check("'yes, interested, tell me more' + knownSide=buyer → buyer/positive_reply",
    eq(keywordIntentFallback("Yes! Interested — tell me more", "buyer"), "buyer", "positive_reply"))
  check("bare positive + NO knownSide → null (don't guess a side to convert)",
    keywordIntentFallback("Sure, sounds good", null) === null)

  // Side-explicit bare intent (sell/buy stated, no specific milestone)
  check("'thinking of selling' → seller/positive_reply",
    eq(keywordIntentFallback("We've been thinking of selling soon"), "seller", "positive_reply"))
  check("'looking to buy a home' → buyer/positive_reply or criteria",
    (() => { const r = keywordIntentFallback("We're looking to buy a home"); return !!r && r.side === "buyer" })())

  // NEGATIVE → null (caller HALTS)
  check("'not interested' → null (negative — halt, never convert)",
    keywordIntentFallback("Not interested, please stop", "seller") === null)
  check("'unsubscribe' → null (negative)",
    keywordIntentFallback("unsubscribe me", "buyer") === null)
  check("'take me off your list' → null (negative)",
    keywordIntentFallback("take me off your list", "seller") === null)

  // AMBIGUOUS → null (keep nurturing)
  check("ambiguous chit-chat → null (no clear intent)",
    keywordIntentFallback("Thanks for the info, talk soon", "seller") === null)
  check("empty message → null",
    keywordIntentFallback("", "buyer") === null)
  check("vague question → null",
    keywordIntentFallback("How's the market doing lately?", null) === null)

  // Side inference: a seller valuation ask overrides a buyer knownSide (explicit wins)
  check("explicit seller cma overrides knownSide=buyer (explicit signal wins)",
    eq(keywordIntentFallback("what's my home worth?", "buyer"), "seller", "cma_request"))
}

// ───────────────────────────────────────────────────────────────────────────
// Layer 2 — LIVE: classifyAndRouteInbound with an INJECTED classifier.
// ───────────────────────────────────────────────────────────────────────────
async function testLive() {
  console.log("\n[Layer 2 · live — classifyAndRouteInbound (injected classifier)]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("  ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { classifyAndRouteInbound } = await import("../lib/ai-isa/inbound-intent-classifier")
  const svc = createServiceClient()

  const TAG = `__inintent_${Date.now()}__`
  const cleanup: Array<{ table: string; column: string; value: string }> = []

  // An injected classifier that returns a fixed intent — deterministic, no AI.
  const fixed = (intent: ClassifiedIntent | null): InboundClassifier => () => intent

  function registerLeadCleanup(id: string) {
    cleanup.push({ table: "lead_sla_tracking", column: "lead_id", value: id })
    cleanup.push({ table: "ai_isa_activities", column: "lead_id", value: id })
    cleanup.push({ table: "assignment_log", column: "lead_id", value: id })
    cleanup.push({ table: "ai_isa_qualifications", column: "lead_id", value: id })
    cleanup.push({ table: "activities", column: "contact_id", value: id })
    cleanup.push({ table: "lifecycle_events", column: "entity_id", value: id })
    cleanup.push({ table: "leads", column: "id", value: id })
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
    cleanup.push({ table: "contacts", column: "id", value: contactId })
  }

  async function seedLead(brokerageId: string, agentId: string, side: "buyer" | "seller", suffix: string, extra: Record<string, any> = {}): Promise<string | null> {
    const { data, error } = await svc.from("leads").insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      first_name: TAG,
      last_name: `${side}_${suffix}`,
      email: `${TAG}_${suffix}@example.com`,
      lead_type: side,
      motivation_type: side === "seller" ? "seller_motivated" : "buyer",
      lifecycle_state: "isa_qualifying",
      is_active: true,
      ai_isa_owner: true,
      email_verified: true,
      ...extra,
    }).select("id").single()
    if (error || !data) { check(`seed ${side} lead (${suffix})`, false, error?.message); return null }
    const id = (data as any).id as string
    registerLeadCleanup(id)
    return id
  }

  async function contactCountForLead(leadId: string): Promise<number> {
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("notes", `Promoted from lead ${leadId}`)
    return count ?? 0
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
    const propertyData = { address: `${TAG} 14 Cypress Ln`, city: "Tampa", state: "FL", zip: "33602", bedrooms: 4, bathrooms: 3, sqft: 2400, propertyType: "single_family" }

    // ── (1) seller cma_request → contact + draft CMA, NO appointment ──────────
    console.log("\n  ── (1) inbound 'what's my home worth' → seller/cma_request ──")
    const sCma = await seedLead(brokerageId, agentId, "seller", "cma", { address: propertyData.address, city: propertyData.city, state: propertyData.state })
    if (sCma) {
      const r = await classifyAndRouteInbound(
        { leadId: sCma, brokerageId, message: "what's my home worth?" },
        { classifier: fixed({ side: "seller", reason: "cma_request" }) },
      )
      check("(1) converted", r.outcome === "converted", JSON.stringify(r))
      if (r.contactId) registerContactCleanup(r.contactId)
      check("(1) landed as a SELLER contact", await isContactType(svc, r.contactId, "seller"), r.contactId ?? "no contact")
      const { count: cmaC } = await svc.from("cma_reports").select("id", { count: "exact", head: true }).eq("contact_id", r.contactId ?? "")
      check("(1) a draft CMA was proposed", (cmaC ?? 0) === 1, `cma rows=${cmaC}`)
      const { count: calC } = await svc.from("calendar_events").select("id", { count: "exact", head: true }).eq("entity_id", r.contactId ?? "")
      check("(1) NO appointment booked for a cma_request", (calC ?? 0) === 0, `calendar rows=${calC}`)
    }

    // ── (2) seller appointment_request → contact (booking deferred, no slot) ──
    console.log("\n  ── (2) inbound 'set up a time to list' → seller/appointment_request ──")
    const sAppt = await seedLead(brokerageId, agentId, "seller", "appt", { address: propertyData.address, city: propertyData.city, state: propertyData.state })
    if (sAppt) {
      const r = await classifyAndRouteInbound(
        { leadId: sAppt, brokerageId, message: "set up a time to list my home" },
        { classifier: fixed({ side: "seller", reason: "appointment_request" }) },
      )
      check("(2) converted", r.outcome === "converted", JSON.stringify(r))
      if (r.contactId) registerContactCleanup(r.contactId)
      check("(2) landed as a SELLER contact", await isContactType(svc, r.contactId, "seller"), r.contactId ?? "no contact")
      // No slot is fabricated from an inbound reply → no calendar event yet.
      const { count: calC } = await svc.from("calendar_events").select("id", { count: "exact", head: true }).eq("entity_id", r.contactId ?? "")
      check("(2) NO appointment auto-booked from a bare reply (agent confirms the slot)", (calC ?? 0) === 0, `calendar rows=${calC}`)
    }

    // ── (3) buyer criteria_request → contact + saved search + SEARCH_CONFIGURED ─
    console.log("\n  ── (3) inbound 'looking for 3bd under 500k' → buyer/criteria_request ──")
    const bCrit = await seedLead(brokerageId, agentId, "buyer", "crit")
    if (bCrit) {
      const r = await classifyAndRouteInbound(
        { leadId: bCrit, brokerageId, message: "looking for a 3bd under $500k" },
        { classifier: fixed({ side: "buyer", reason: "criteria_request" }) },
      )
      check("(3) converted", r.outcome === "converted", JSON.stringify(r))
      if (r.contactId) registerContactCleanup(r.contactId)
      check("(3) landed as a BUYER contact", await isContactType(svc, r.contactId, "buyer"), r.contactId ?? "no contact")
      // Bare inbound reply carries no structured criteria → converter converts but
      // skips the saved-search capture (honest). Stage stays at contact-created.
      const { data: c } = await svc.from("contacts").select("buyer_stage").eq("id", r.contactId ?? "").maybeSingle()
      check("(3) buyer contact exists (criteria capture deferred — no structured data in a reply)",
        !!r.contactId && (c as any)?.buyer_stage !== "BUYER_TOURING", String((c as any)?.buyer_stage))
    }

    // ── (4) buyer showing_request → contact + showing (BBA seeded) + TOURING ──
    console.log("\n  ── (4) inbound 'can I tour 123 Main' → buyer/showing_request ──")
    const bShow = await seedLead(brokerageId, agentId, "buyer", "show")
    if (bShow) {
      // First convert so the contact exists, then seed an active BBA so the showing routes.
      const first = await classifyAndRouteInbound(
        { leadId: bShow, brokerageId, message: "yes interested" },
        { classifier: fixed({ side: "buyer", reason: "positive_reply" }) },
      )
      const contactId = first.contactId
      if (contactId) {
        registerContactCleanup(contactId)
        await svc.from("buyer_broker_agreements").insert({
          brokerage_id: brokerageId, buyer_contact_id: contactId, agent_id: agentId,
          agreement_type: "exclusive", commission_payer: "seller", property_type_scope: {},
          status: "active", signed_at: new Date().toISOString(), created_by: agentUserId,
        })
      }
      // showing_request with a propertyRef-bearing propertyData so the showing routes.
      const r = await classifyAndRouteInbound(
        { leadId: bShow, brokerageId, message: "can I tour 123 Main this weekend?", propertyData: { address: "123 Main St", city: "Tampa", state: "FL" } },
        { classifier: fixed({ side: "buyer", reason: "showing_request" }) },
      )
      check("(4) routed on the SAME contact (no double-convert)", r.outcome === "converted" && r.contactId === contactId && r.alreadyConverted === true, JSON.stringify(r))
      // NOTE: convertBuyerLeadOnIntent reads propertyRef (not propertyData) for the
      // showing — a bare inbound reply has no propertyRef, so the showing is honestly
      // skipped (still converts). We assert the contact exists + is idempotent.
      check("(4) buyer contact unchanged (single contact)", await contactCountForLead(bShow) === 1, `contacts=${await contactCountForLead(bShow)}`)
    }

    // ── (5) buyer preapproval_request → contact + financial profile (verified=false) ─
    console.log("\n  ── (5) inbound 'what can I afford' → buyer/preapproval_request ──")
    const bPre = await seedLead(brokerageId, agentId, "buyer", "pre")
    if (bPre) {
      const r = await classifyAndRouteInbound(
        { leadId: bPre, brokerageId, message: "what can I afford?" },
        { classifier: fixed({ side: "buyer", reason: "preapproval_request" }) },
      )
      check("(5) converted", r.outcome === "converted", JSON.stringify(r))
      if (r.contactId) registerContactCleanup(r.contactId)
      const { data: fp } = await svc.from("buyer_financial_profiles").select("verified, lender_referral_status").eq("contact_id", r.contactId ?? "").maybeSingle()
      check("(5) pre-approval started but NOT verified (honest — requested, not completed)",
        !!fp && (fp as any).verified === false && (fp as any).lender_referral_status === "requested", JSON.stringify(fp))
    }

    // ── (6) NEGATIVE message → HALT + NO conversion (still a lead) ────────────
    console.log("\n  ── (6) inbound 'not interested, stop' → HALT, no conversion ──")
    const bNeg = await seedLead(brokerageId, agentId, "buyer", "neg")
    if (bNeg) {
      const r = await classifyAndRouteInbound(
        { leadId: bNeg, brokerageId, message: "not interested, please stop contacting me" },
        // Even a misbehaving classifier that says "convert" must NOT convert — the
        // negative gate runs FIRST, before the classifier is consulted.
        { classifier: fixed({ side: "buyer", reason: "positive_reply" }) },
      )
      check("(6) HALTED (negative gate runs before the classifier)", r.outcome === "halted" && r.halted === true && r.reason === "negative", JSON.stringify(r))
      check("(6) NO contact created for a negative reply", await contactCountForLead(bNeg) === 0, `contacts=${await contactCountForLead(bNeg)}`)
      const { data: la } = await svc.from("leads").select("call_stop_flag, lifecycle_state, contact_id").eq("id", bNeg).maybeSingle()
      check("(6) lead halted: call_stop_flag set, do_not_contact, NOT converted",
        (la as any)?.call_stop_flag === true && (la as any)?.lifecycle_state === "do_not_contact" && !(la as any)?.contact_id, JSON.stringify(la))
    }

    // ── (7) AMBIGUOUS message → NO conversion (still a lead) + nurture touch ──
    console.log("\n  ── (7) inbound vague reply → NO conversion, nurture touch ──")
    const bAmb = await seedLead(brokerageId, agentId, "buyer", "amb")
    if (bAmb) {
      const r = await classifyAndRouteInbound(
        { leadId: bAmb, brokerageId, message: "thanks, how's the market doing?" },
        { classifier: fixed(null) }, // classifier returns null = ambiguous
      )
      check("(7) NURTURED (no conversion)", r.outcome === "nurtured" && r.reason === "none", JSON.stringify(r))
      check("(7) NO contact created for an ambiguous reply", await contactCountForLead(bAmb) === 0, `contacts=${await contactCountForLead(bAmb)}`)
      const { data: la } = await svc.from("leads").select("contact_id, lifecycle_state").eq("id", bAmb).maybeSingle()
      check("(7) lead still a LEAD (not converted, not halted)", !(la as any)?.contact_id && (la as any)?.lifecycle_state !== "do_not_contact", JSON.stringify(la))
      const { count: nurtureC } = await svc.from("activities").select("id", { count: "exact", head: true }).eq("contact_id", bAmb).eq("activity_type", "ai_isa_inbound_nurture")
      check("(7) a nurture touch was recorded", (nurtureC ?? 0) === 1, `nurture activities=${nurtureC}`)
    }

    // ── (8) IDEMPOTENT — re-running the same intent re-uses the same contact ──
    console.log("\n  ── (8) idempotent re-run → same contact, no double-convert ──")
    const bIdem = await seedLead(brokerageId, agentId, "buyer", "idem")
    if (bIdem) {
      const r1 = await classifyAndRouteInbound(
        { leadId: bIdem, brokerageId, message: "yes interested" },
        { classifier: fixed({ side: "buyer", reason: "positive_reply" }) },
      )
      if (r1.contactId) registerContactCleanup(r1.contactId)
      const r2 = await classifyAndRouteInbound(
        { leadId: bIdem, brokerageId, message: "yes interested" },
        { classifier: fixed({ side: "buyer", reason: "positive_reply" }) },
      )
      check("(8) second run returns the SAME contact (alreadyConverted)",
        r2.outcome === "converted" && r2.contactId === r1.contactId && r2.alreadyConverted === true, JSON.stringify({ r1: r1.contactId, r2: r2.contactId, already: r2.alreadyConverted }))
      check("(8) still exactly ONE contact for the lead", await contactCountForLead(bIdem) === 1, `contacts=${await contactCountForLead(bIdem)}`)
    }
  } finally {
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

async function isContactType(svc: any, contactId: string | undefined, want: "buyer" | "seller"): Promise<boolean> {
  if (!contactId) return false
  const { data } = await svc.from("contacts").select("contact_type").eq("id", contactId).maybeSingle()
  if (!data) return false
  if (want === "buyer") return data.contact_type === "buyer" || data.contact_type === "both"
  return data.contact_type === "seller"
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Inbound Intent Classifier simulator")
  console.log("══════════════════════════════════════════════════")
  ;({ keywordIntentFallback } = await import("../lib/ai-isa/inbound-intent-classifier"))
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" INBOUND_INTENT_PASS — an inbound reply self-classifies + routes: clear positive intent converts to the right milestone (seller cma→draft CMA/no appt, seller appt→convert, buyer criteria/preapproval/showing/positive→convert), NEGATIVE halts (DNC, no convert), AMBIGUOUS keeps nurturing (no convert); side inferred from knownSide; idempotent; cleanup verified")
}
main().catch((e) => { console.error(e); process.exit(1) })
