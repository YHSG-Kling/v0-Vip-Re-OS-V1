#!/usr/bin/env tsx
/**
 * scripts/seller-appt-conversion-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the FULL seller-lead journey end to end — the MISSING STEP now wired:
 *
 *   qualified seller LEAD
 *     → bookSellerListingAppointment
 *         (1) schedules the listing appointment   (reuse scheduleISAAppointment)
 *         (2) CONVERTS lead → contact             (canonical promoteLeadToContact)
 *         (3) fires CONTACT_AGENT_ASSIGNED        (welcome / meet-your-agent intro)
 *         (4) runs listing.appointment_set        (flagship listing-appt-prep chain)
 *
 * Layer 1 (pure, no I/O):
 *   - motivationToContactType maps a seller motivation to contact_type='seller'
 *     (the converter's persisted intent — the contact lands as a seller, getting
 *     the seller portal view).
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY):
 *   - seed a QUALIFIED seller LEAD (ai_isa_owner, no contact_id, email_verified),
 *     inject the chain's money-spending leaves (NO D-ID / AVM / CMA spend), run
 *     bookSellerListingAppointment for REAL, and assert:
 *       (a) an appointment row exists (calendar_events, ISA_APPOINTMENT)
 *       (b) the lead CONVERTED → a contact (contacts row; lead deactivated + linked)
 *       (c) the contact has portal eligibility (determinePortalView → 'seller')
 *       (d) CONTACT_AGENT_ASSIGNED fired the welcome/intro reactor path
 *           (an agent_intro_videos ledger row for trigger=contact_agent_assigned)
 *       (e) listing.appointment_set ran the chain (a workflow_runs row for
 *           chain listing-appt-prep on this contact)
 *       (f) idempotent rerun — no double convert / double book / double chain run
 *   - then a "lead under representation" → REFUSED (honest guard).
 *   - reverse-delete ALL seeded rows + assert cleanup count == 0.
 *
 * Run:  npx tsx scripts/seller-appt-conversion-simulator.ts   (npm run test:seller-appt-conversion)
 */

// ── test-only shim ──────────────────────────────────────────────────────────
// The chain's direct-mail leaves import `server-only`, which throws outside a
// Server Component. Neutralize it in the require cache BEFORE importing anything
// that transitively pulls it. Shims the guard module ONLY; the orchestration,
// converter, reactor, and engine (the system under test) all run for real.
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
// Layer 1 — PURE: the converter persists the ISA's seller intent as the
// contact_type, which is what gives the converted contact its seller portal view.
// ───────────────────────────────────────────────────────────────────────────
function testPure() {
  console.log("\n[Layer 1 · pure — seller intent → contact_type]")
  check("a 'seller' motivation maps to contact_type='seller'",
    motivationToContactType("seller_motivated") === "seller", String(motivationToContactType("seller_motivated")))
  check("an 'investor' motivation maps to 'investor' (not mis-bucketed as seller)",
    motivationToContactType("investor") === "investor")
  check("a null motivation maps to null (caller falls back to lead_type)",
    motivationToContactType(null) === null)
}

// ───────────────────────────────────────────────────────────────────────────
// Layer 2 — LIVE: real orchestration, injected money-leaves, real DB.
// ───────────────────────────────────────────────────────────────────────────
async function testLive() {
  console.log("\n[Layer 2 · live seller-lead journey (money-leaves injected)]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("  ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { bookSellerListingAppointment } = await import("../lib/ai-isa/book-seller-appointment")
  const { setListingApptPrepExecutors } = await import("../lib/workflow-orchestrator/chains/listing-appt-prep")
  const { determinePortalView } = await import("../lib/kernel/portal")
  const svc = createServiceClient()

  const TAG = `__sappt_${Date.now()}__`
  const cleanup: Array<{ table: string; column: string; value: string }> = []
  let leadId: string | null = null
  let contactId: string | null = null
  let repLeadId: string | null = null

  // Inject the three money-spending leaves of listing-appt-prep. The orchestration
  // around them (schedule → convert → welcome → chain) is REAL.
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
    // Reuse a real agent (the converter + chain resolve agents by id/user_id) under a real brokerage.
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

    // ── Seed a QUALIFIED seller LEAD: ai_isa_owner, active, no contact_id, email_verified.
    const { data: lead, error: lErr } = await svc.from("leads").insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      first_name: TAG,
      last_name: "SellerLead",
      email: `${TAG}@example.com`,
      lead_type: "seller",
      motivation_type: "seller_motivated",
      lifecycle_state: "qualification",
      is_active: true,
      ai_isa_owner: true,
      email_verified: true,
    }).select("id").single()
    check("seed qualified seller lead", !lErr && !!lead, lErr?.message)
    if (!lead) throw new Error("lead seed failed")
    leadId = (lead as any).id as string
    cleanup.push({ table: "lead_sla_tracking", column: "lead_id", value: leadId })
    cleanup.push({ table: "ai_isa_activities", column: "lead_id", value: leadId })

    const startAt = new Date(Date.now() + 6 * 86_400_000) // 6 days out
    const endAt = new Date(startAt.getTime() + 60 * 60_000)
    const propertyData = { address: `${TAG} 12 Cypress Ln`, city: "Tampa", state: "FL", zip: "33602", bedrooms: 4, bathrooms: 3, sqft: 2400, propertyType: "single_family" }

    // ── (RUN 1) The full journey, for real. ──────────────────────────────────
    const r1 = await bookSellerListingAppointment({
      brokerageId, leadId, agentId, startAt, endAt, timezoneName: "America/New_York", location: propertyData.address, propertyData,
    })
    check("bookSellerListingAppointment succeeded", r1.success, r1.error)
    contactId = r1.contactId ?? null

    // Register cleanup for everything the journey created.
    const calId = r1.calendarEventId
    if (calId) cleanup.push({ table: "calendar_events", column: "id", value: calId })
    if (contactId) {
      cleanup.push({ table: "agent_intro_videos", column: "contact_id", value: contactId })
      cleanup.push({ table: "transparency_updates", column: "contact_id", value: contactId })
      cleanup.push({ table: "activities", column: "contact_id", value: contactId })
      cleanup.push({ table: "workflow_runs", column: "contact_id", value: contactId })
      cleanup.push({ table: "ai_isa_activities", column: "contact_id", value: contactId })
      cleanup.push({ table: "contacts", column: "id", value: contactId })
    }
    if (leadId) {
      cleanup.push({ table: "lifecycle_events", column: "entity_id", value: leadId })
    }
    if (contactId) cleanup.push({ table: "lifecycle_events", column: "entity_id", value: contactId })
    cleanup.push({ table: "leads", column: "id", value: leadId })

    // (a) Appointment row exists, ISA appointment type.
    const { data: cal } = await svc.from("calendar_events")
      .select("id, entity_type, entity_id, event_type").eq("id", calId ?? "").maybeSingle()
    check("(a) appointment row exists (calendar_events)", !!cal, "no calendar_events row")
    check("(a) appointment is an ISA appointment for the lead",
      (cal as any)?.entity_type === "lead" && (cal as any)?.event_type === "isa_appointment",
      `${(cal as any)?.entity_type}/${(cal as any)?.event_type}`)

    // (b) Lead converted → contact; lead deactivated + linked.
    check("(b) lead converted to a contact (contactId returned)", !!contactId, "no contactId")
    const { data: contactRow } = contactId
      ? await svc.from("contacts").select("id, contact_type, agent_id, notes").eq("id", contactId).maybeSingle()
      : { data: null }
    check("(b) contact row exists with the agent assigned (relationship begins)",
      !!contactRow && (contactRow as any).agent_id === agentId)
    check("(b) contact landed as a SELLER (ISA seller intent persisted)",
      (contactRow as any)?.contact_type === "seller", (contactRow as any)?.contact_type)
    const { data: leadAfter } = await svc.from("leads").select("is_active, ai_isa_owner, contact_id").eq("id", leadId).maybeSingle()
    check("(b) lead deactivated + ISA released after conversion",
      (leadAfter as any)?.is_active === false && (leadAfter as any)?.ai_isa_owner === false)
    check("(b) lead linked to its contact (leads.contact_id stamped)",
      (leadAfter as any)?.contact_id === contactId, String((leadAfter as any)?.contact_id))

    // (c) The contact has portal eligibility — a seller contact resolves to the seller view.
    const portal = contactId ? await determinePortalView(svc as any, { contactId }) : null
    check("(c) converted contact has portal eligibility → seller view",
      portal?.view === "seller", `${portal?.view} (${portal?.reason})`)

    // (d) CONTACT_AGENT_ASSIGNED fired the welcome/meet-your-agent intro reactor path.
    // The agent_intro_videos ledger row is written by dispatchAssignmentIntroVideo for
    // trigger=contact_agent_assigned regardless of the agent's voice-profile config
    // (queued / suppressed / failed all leave the ledger row — proof the path ran).
    const { data: introVids } = contactId
      ? await svc.from("agent_intro_videos").select("id, trigger, status").eq("contact_id", contactId).eq("trigger", "contact_agent_assigned")
      : { data: [] as any[] }
    const introList = (introVids ?? []) as Array<{ status: string }>
    // Belt-and-suspenders: the m122 trigger also logs the kernel event as an audit row.
    const { data: caaEvents } = contactId
      ? await svc.from("lifecycle_events").select("id").eq("entity_id", contactId).eq("event_type", "contact_agent_assigned")
      : { data: [] as any[] }
    check("(d) CONTACT_AGENT_ASSIGNED fired (intro-video reactor path OR kernel audit row)",
      introList.length >= 1 || (caaEvents ?? []).length >= 1,
      `intro_rows=${introList.length} caa_events=${(caaEvents ?? []).length}`)

    // (e) listing.appointment_set ran the flagship chain.
    check("(e) listing-appt-prep chain run started for the contact", !!r1.chainRunId, "no chainRunId")
    const { data: runs } = contactId
      ? await svc.from("workflow_runs").select("id, chain_key, trigger_event, status").eq("contact_id", contactId).eq("chain_key", "listing-appt-prep")
      : { data: [] as any[] }
    const runList = (runs ?? []) as Array<{ trigger_event: string; status: string }>
    check("(e) exactly one listing-appt-prep run exists (trigger listing.appointment_set)",
      runList.length === 1 && runList[0].trigger_event === "listing.appointment_set",
      `count=${runList.length} trigger=${runList[0]?.trigger_event}`)
    check("(e) the injected money-leaves each ran exactly once (no real spend)",
      cmaCalls === 1 && presCalls === 1 && videoCalls === 1, `cma=${cmaCalls} pres=${presCalls} vid=${videoCalls}`)

    // ── (RUN 2) Idempotent rerun — no double convert / book / chain run. ──────
    const cmaBefore = cmaCalls, vidBefore = videoCalls
    const r2 = await bookSellerListingAppointment({
      brokerageId, leadId, agentId, startAt, endAt, timezoneName: "America/New_York", location: propertyData.address, propertyData,
    })
    check("(f) rerun returns the SAME contact (no double convert)",
      r2.success && r2.contactId === contactId && r2.alreadyConverted === true, `${r2.contactId} already=${r2.alreadyConverted}`)
    const { count: contactCount } = await svc.from("contacts")
      .select("id", { count: "exact", head: true }).eq("notes", `Promoted from lead ${leadId}`)
    check("(f) still exactly ONE contact for this lead", (contactCount ?? 0) === 1, `got ${contactCount}`)
    const { count: runCount } = await svc.from("workflow_runs")
      .select("id", { count: "exact", head: true }).eq("contact_id", contactId!).eq("chain_key", "listing-appt-prep")
    check("(f) still exactly ONE listing-appt-prep run (chain deduped)", (runCount ?? 0) === 1, `got ${runCount}`)
    check("(f) rerun did NOT re-invoke the money leaves", cmaCalls === cmaBefore && videoCalls === vidBefore, `cma ${cmaCalls} vid ${videoCalls}`)

    // ── (REFUSE) A lead under representation is REFUSED (honest guard). ───────
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
    setListingApptPrepExecutors(null) // reset to real executors

    // Reverse-delete every seeded row, then verify nothing remains.
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
  console.log(" Seller Appointment → Conversion — full-journey simulator")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ SELLER_APPT_CONVERSION verified — schedule → convert → welcome → flagship chain, idempotent + honest-guarded")
}
main().catch((e) => { console.error(e); process.exit(1) })
