#!/usr/bin/env tsx
/**
 * scripts/listing-appt-prep-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FLAGSHIP "listing appointment prep" chain harness.
 *
 * When an agent books a listing consultation, `listing.appointment_set` fires WITH
 * a contactId (see ai-calendar-management.createAppointment) and the
 * `listing-appt-prep` chain runs end to end:
 *
 *   prep_seller_portal → generate_cma → generate_presentation →
 *   generate_chapter_videos → enroll_drip → send_pre_listing_kit
 *
 * The three MONEY-SPENDING leaves — the AVM/AI CMA, the AI listing presentation, and
 * the D-ID + ElevenLabs chapter-video renders — are the ONLY things a test must not
 * invoke for real. The chain exposes setListingApptPrepExecutors() exactly for this:
 * we inject fakes for those leaves while the REAL orchestration runs — engine step
 * routing, the human-approval gate, run-dedupe idempotency keyed on
 * (chain, entity, trigger), the drip-enrollment insert, and the seller portal-value
 * card push. We do NOT mock the system under test; we inject the external leaves the
 * chain's own seam exposes.
 *
 * Layer 1 (pure, no I/O):
 *   - chain SHAPE: triggerEvent, step keys + order, money-leaf steps are injectable.
 *   - findReusableRun (run-dedupe): exact-event reuse, active-run reuse, and a fresh
 *     occurrence (no reusable run) — the (chain, entity, trigger) idempotency the
 *     LIFECYCLE_EVENT_CONTRACT §6.3 says "landed."
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY):
 *   - seed a throwaway contact under a real brokerage/agent; inject fake leaf
 *     executors (NO D-ID / AVM / CMA spend); run the chain via the real engine;
 *   - assert: steps execute in order and the run COMPLETES; the human-gate branch
 *     pauses then resumes on approval; run-dedupe returns the SAME run (deduped) for
 *     a second start with the same (chain, entity, trigger); EVERY CHAPTER REEL IS
 *     LINKED TO A SECTION OF THE SELLER DRIP (and no scheduled_video_touchpoint
 *     activity is written any more); the seller portal card is pushed exactly once;
 *   - then reverse-delete every seeded row and verify cleanup count == 0.
 *
 * WHY THE FAKE LEAVES RETURN REAL IDs. enroll_drip is REAL orchestration — it
 * attaches the chapter reels to presentation_sections, which requires a real
 * listing_presentations row and real ai_video_projects rows. The leaves are
 * still fake (nothing is rendered and no provider is called); the rows they
 * return are seeded by this harness so the drip enrollment under test operates
 * on the same shapes production gives it.
 *
 * Run:  npx tsx scripts/listing-appt-prep-simulator.ts   (npm run test:listing-appt-prep)
 */

// ── test-only shim ──────────────────────────────────────────────────────────
// The chain's direct-mail leaves (orchestrate-send / draft-copy / resolve-mailing-
// address) import `server-only`, which throws when loaded outside a Server
// Component. tsx is neither — so we neutralize that import in the require cache
// BEFORE importing the chain. This shims an external guard module ONLY; the chain
// and engine (the system under test) run for real.
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }
// ─────────────────────────────────────────────────────────────────────────────

// run-dedupe is pure (no server-only chain) so it's safe to import statically.
import { findReusableRun, type ExistingRun } from "../lib/workflow-orchestrator/run-dedupe"
import type { WorkflowChain } from "../lib/workflow-orchestrator/types"
// The chain module (transitively server-only) is loaded lazily AFTER the shim above.
type ChainModule = typeof import("../lib/workflow-orchestrator/chains/listing-appt-prep")
let listingApptPrepChain: WorkflowChain
let setListingApptPrepExecutors: ChainModule["setListingApptPrepExecutors"]
let listingApptPrepDedupeKey: ChainModule["listingApptPrepDedupeKey"]
async function loadChain() {
  const m = await import("../lib/workflow-orchestrator/chains/listing-appt-prep")
  listingApptPrepChain = m.listingApptPrepChain
  setListingApptPrepExecutors = m.setListingApptPrepExecutors
  listingApptPrepDedupeKey = m.listingApptPrepDedupeKey
}

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ───────────────────────────────────────────────────────────────────────────
// Layer 1 — PURE: chain shape + run-dedupe decision logic.
// ───────────────────────────────────────────────────────────────────────────
function testPure() {
  console.log("\n[Layer 1 · chain shape]")

  check("triggerEvent is listing.appointment_set",
    listingApptPrepChain.triggerEvent === "listing.appointment_set", listingApptPrepChain.triggerEvent)

  // Deterministic per-listing dedupe key — every booking path (stage pipeline, calendar, AI-ISA)
  // passes the SAME key for a listing so the engine collapses them to ONE prep run (no double spend).
  check("dedupe key is deterministic per listing",
    listingApptPrepDedupeKey("L-1") === "listing_appt_L-1" && listingApptPrepDedupeKey("L-1") === listingApptPrepDedupeKey("L-1"))
  check("dedupe key differs across listings",
    listingApptPrepDedupeKey("L-1") !== listingApptPrepDedupeKey("L-2"))

  const keys = listingApptPrepChain.steps.map((s) => s.key)
  const expected = [
    "prep_seller_portal",
    "generate_cma",
    "generate_presentation",
    "generate_chapter_videos",
    "enroll_drip",
    "send_pre_listing_kit",
  ]
  check("step keys + order match the flagship pipeline",
    JSON.stringify(keys) === JSON.stringify(expected), keys.join(" → "))

  check("CMA precedes presentation precedes chapter videos precedes drip",
    keys.indexOf("generate_cma") < keys.indexOf("generate_presentation") &&
    keys.indexOf("generate_presentation") < keys.indexOf("generate_chapter_videos") &&
    keys.indexOf("generate_chapter_videos") < keys.indexOf("enroll_drip"))

  check("portal value card is prepped BEFORE any money-spending step (flywheel)",
    keys.indexOf("prep_seller_portal") === 0)

  console.log("\n[Layer 1 · run-dedupe (chain, entity, trigger) idempotency]")

  // (1) Exact source-event reuse: same trigger_event_id already started a run → reuse it.
  const runs: ExistingRun[] = [
    { id: "run-A", status: "completed", trigger_event_id: "evt-1" },
    { id: "run-B", status: "running", trigger_event_id: "evt-2" },
  ]
  check("exact trigger_event_id reuses that run (even if completed)",
    findReusableRun(runs, "evt-1")?.id === "run-A")

  // (2) No matching event id, but an ACTIVE run exists → don't start a concurrent dup.
  check("active run reused when no exact event match",
    findReusableRun(runs, "evt-XYZ")?.id === "run-B")
  check("active run reused when no trigger id supplied",
    findReusableRun(runs, null)?.id === "run-B")

  // (3) Genuinely new occurrence — only terminal prior runs, no event match → fresh run.
  const terminalOnly: ExistingRun[] = [
    { id: "run-C", status: "completed", trigger_event_id: "evt-old" },
    { id: "run-D", status: "failed", trigger_event_id: "evt-older" },
  ]
  check("no reusable run for a new occurrence (terminal-only, no event match)",
    findReusableRun(terminalOnly, "evt-new") === null)
  check("paused/needs_approval count as active (not duplicated)",
    findReusableRun([{ id: "run-P", status: "paused", trigger_event_id: null }], null)?.id === "run-P" &&
    findReusableRun([{ id: "run-N", status: "needs_approval", trigger_event_id: null }], null)?.id === "run-N")
}

// ───────────────────────────────────────────────────────────────────────────
// Layer 2 — LIVE: real engine, injected money-leaves, real DB.
// ───────────────────────────────────────────────────────────────────────────
async function testLive() {
  console.log("\n[Layer 2 · live chain run (money-leaves injected)]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("  ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { startRun, advanceRun, approveStep } = await import("../lib/workflow-orchestrator/engine")
  const svc = createServiceClient()

  const TAG = `__lappt_${Date.now()}__`
  const cleanup: Array<{ table: string; column: string; value: string }> = []
  let contactId: string | null = null

  // The leaves are fake (no D-ID / AVM / CMA spend) but the rows they hand back
  // are REAL, because enroll_drip — the orchestration under test — links each
  // chapter reel to a section of a real listing presentation. Filled in below,
  // before the first startRun; the closures read them at call time.
  const FAKE_CHAPTERS = [
    { title: "Why Me",    focus: "credibility" },
    { title: "Pricing",   focus: "pricing_strategy" },
    { title: "Marketing", focus: "marketing" },
  ]
  let seededPresentationId: string | null = null
  let seededVideoIds: string[] = []

  // Inject the three money-spending leaves. The orchestration around them is REAL.
  let cmaCalls = 0, presCalls = 0, videoCalls = 0
  setListingApptPrepExecutors({
    generateCMA: async () => { cmaCalls++; return { success: true, id: `${TAG}-cma`, valuation: 675000, pricingStrategy: "market" } },
    generatePresentation: async () => {
      presCalls++
      return {
        success: true,
        presentationId: seededPresentationId,
        chapters: FAKE_CHAPTERS,
        content: "fake presentation content",
      }
    },
    generateChapterVideos: async () => {
      videoCalls++
      return { success: true, videoIds: seededVideoIds, chapterTitles: FAKE_CHAPTERS.map((c) => c.title) }
    },
  })

  try {
    // Reuse a real agent (the chain resolves agents by user_id) under a real brokerage.
    const { data: agent } = await svc
      .from("agents")
      .select("id, user_id, brokerage_id")
      .not("user_id", "is", null)
      .not("brokerage_id", "is", null)
      .limit(1)
      .single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent with user_id + brokerage_id."); return }
    const brokerageId = (agent as any).brokerage_id as string
    const agentUserId = (agent as any).user_id as string

    // Seed a throwaway seller contact.
    const { data: c, error: cErr } = await svc.from("contacts").insert({
      brokerage_id: brokerageId,
      first_name: TAG,
      last_name: "Seller",
      email: `${TAG}@example.com`,
      contact_type: "seller",
    }).select("id").single()
    check("seed seller contact", !cErr && !!c, cErr?.message)
    if (!c) throw new Error("contact seed failed")
    contactId = (c as any).id as string
    cleanup.push({ table: "transparency_updates", column: "contact_id", value: contactId })
    cleanup.push({ table: "activities", column: "contact_id", value: contactId })
    cleanup.push({ table: "workflow_runs", column: "contact_id", value: contactId })
    cleanup.push({ table: "contacts", column: "id", value: contactId })

    const apptDate = new Date(Date.now() + 5 * 86_400_000).toISOString() // 5 days out
    const metadata = {
      appointment_date: apptDate,
      property_data: {
        address: `${TAG} 742 Evergreen Ter`, city: "Tampa", state: "FL", zip: "33601",
        bedrooms: 3, bathrooms: 2, sqft: 1800, propertyType: "single_family",
      },
    }

    // Seed the presentation the fake generatePresentation "produced". Real row:
    // enroll_drip materializes its seller-safe sections and links the reels to
    // them. Deleting it cascades presentation_sections (m179 FK).
    const { data: presRow, error: presErr } = await svc.from("listing_presentations").insert({
      brokerage_id: brokerageId, agent_user_id: agentUserId, contact_id: contactId,
      state: "FL", property_address: `${TAG} 742 Evergreen Ter`,
      appointment_at: apptDate, status: "ready",
    }).select("id").single()
    check("seed listing_presentations for the drip", !presErr && !!presRow, presErr?.message)
    if (!presRow) throw new Error("presentation seed failed")
    seededPresentationId = (presRow as any).id as string
    cleanup.push({ table: "listing_presentations", column: "id", value: seededPresentationId })
    // Materializing the sections also queues their Remotion section reels
    // (entity_type='listing_presentation', entity_id=the presentation). Those do
    // not cascade — pushed AFTER the presentation so the reverse-delete removes
    // them FIRST (presentation_sections.render_id is ON DELETE SET NULL).
    cleanup.push({ table: "remotion_composition_renders", column: "entity_id", value: seededPresentationId })

    // Seed the chapter reels the fake generator "queued". Real ai_video_projects
    // rows: the drip stores their ids and resolves the playable URL at DELIVERY
    // time, so 'queued' here is exactly the state production is in at this point.
    // agent_id is agents-class (m366) — the agents row resolved above.
    const { data: vidRows, error: vidErr } = await svc.from("ai_video_projects").insert(
      FAKE_CHAPTERS.map((ch, i) => ({
        brokerage_id: brokerageId, agent_id: (agent as any).id, contact_id: contactId,
        title: `${TAG} ${ch.title}`, video_type: "presentation_chapter", status: "queued",
        usage_intent: "public_marketing", audience_type: "customer_facing",
        video_metadata: { chapter_index: i, chapter_title: ch.title, presentation_id: seededPresentationId },
      })),
    ).select("id")
    check("seed chapter reel rows", !vidErr && (vidRows ?? []).length === FAKE_CHAPTERS.length, vidErr?.message)
    seededVideoIds = ((vidRows ?? []) as Array<{ id: string }>).map((v) => v.id)
    for (const vid of seededVideoIds) cleanup.push({ table: "ai_video_projects", column: "id", value: vid })

    // (A) Run the REAL chain (auto-completes; default executors are injected fakes).
    const r1 = await startRun({
      chainKey: listingApptPrepChain.key,
      brokerageId, contactId, agentUserId,
      triggerEvent: "listing.appointment_set",
      metadata,
    })
    check("chain run started + reached a terminal state", r1.success && r1.status === "completed", `${r1.status} ${r1.error ?? ""}`)
    check("CMA / presentation / video leaves each invoked exactly once (injected, no spend)",
      cmaCalls === 1 && presCalls === 1 && videoCalls === 1, `cma=${cmaCalls} pres=${presCalls} vid=${videoCalls}`)
    const runId = r1.runId!

    // Steps executed in order and all done.
    const { data: steps } = await svc.from("workflow_run_steps")
      .select("step_index, step_key, status").eq("run_id", runId).order("step_index")
    const stepList = (steps ?? []) as Array<{ step_index: number; step_key: string; status: string }>
    check("all 6 steps persisted in order",
      stepList.length === 6 && stepList.every((s, i) => s.step_index === i && s.step_key === listingApptPrepChain.steps[i].key))
    check("every step reached status=done", stepList.every((s) => s.status === "done"),
      stepList.map((s) => `${s.step_key}:${s.status}`).join(","))

    // (B) Drip enrollment — every chapter reel is linked to a SECTION of the
    //     seller drip, so each one goes out as its own email on the timetable
    //     that ends before the appointment. There is one scheduler and one
    //     delivery path; the writer-less activities touchpoints are gone.
    const { data: sections } = await svc.from("presentation_sections")
      .select("id, section_key, section_order, status, channel, price_withheld, scheduled_for, body")
      .eq("presentation_id", seededPresentationId).order("section_order")
    const secList = (sections ?? []) as Array<{ section_key: string; status: string; channel: string; price_withheld: boolean; scheduled_for: string; body: any }>
    check("drip sections materialized for the presentation", secList.length >= 3, `got ${secList.length}`)
    check("every section is scheduled + seller-safe",
      secList.every((s) => s.status === "scheduled" && s.price_withheld === true))
    check("every section is scheduled BEFORE the appointment",
      secList.every((s) => new Date(s.scheduled_for).getTime() <= new Date(apptDate).getTime()))
    check("every section asks for the email channel", secList.every((s) => s.channel === "both" || s.channel === "email"))

    const linked = secList.filter((s) => !!s.body?.chapter_video?.ai_video_project_id)
    check("one chapter reel linked per seeded video", linked.length === seededVideoIds.length, `got ${linked.length}`)
    check("each reel is linked to a DISTINCT section (one reel per email)",
      new Set(linked.map((s) => s.body.chapter_video.ai_video_project_id)).size === seededVideoIds.length)
    check("the links point at the real ai_video_projects rows",
      linked.every((s) => seededVideoIds.includes(s.body.chapter_video.ai_video_project_id)))
    check("known chapter focuses landed on their matching sections",
      linked.some((s) => s.section_key === "credibility") &&
      linked.some((s) => s.section_key === "cma") &&
      linked.some((s) => s.section_key === "marketing"),
      linked.map((s) => s.section_key).join(","))

    // The dead end is gone: nothing writes scheduled_video_touchpoint any more.
    const { count: deadTouchpoints } = await svc.from("activities")
      .select("id", { count: "exact", head: true })
      .eq("contact_id", contactId).eq("activity_type", "scheduled_video_touchpoint")
    check("NO writer-less scheduled_video_touchpoint activities are written", (deadTouchpoints ?? 0) === 0, `got ${deadTouchpoints}`)

    // (C) Seller portal value card pushed exactly once (the flywheel).
    const { data: cards } = await svc.from("transparency_updates")
      .select("id, update_type, is_visible_to_client")
      .eq("contact_id", contactId).eq("update_type", "listing_appt_prep")
    const cardList = (cards ?? []) as Array<{ is_visible_to_client: boolean }>
    check("exactly one seller portal value card pushed", cardList.length === 1, `got ${cardList.length}`)
    check("portal card is visible to the client", cardList.every((c) => c.is_visible_to_client === true))

    // (D) run-dedupe — a second start for the same (chain, entity, trigger) does NOT
    // start a duplicate run; the engine reuses the existing one.
    const cmaBefore = cmaCalls
    const r2 = await startRun({
      chainKey: listingApptPrepChain.key,
      brokerageId, contactId, agentUserId,
      triggerEvent: "listing.appointment_set",
      metadata,
    })
    check("second start is deduped (same run, no new instance)", r2.success === true && r2.runId === runId, `runId=${r2.runId} deduped=${(r2 as any).deduped}`)
    const { count: runCount } = await svc.from("workflow_runs")
      .select("id", { count: "exact", head: true }).eq("contact_id", contactId)
    check("exactly ONE workflow_runs row exists for this (chain, entity, trigger)", (runCount ?? 0) === 1, `got ${runCount}`)
    check("dedupe did NOT re-invoke the money leaves", cmaCalls === cmaBefore, `cma now ${cmaCalls}`)

    // (E) Human-gate branch — inject requiresApproval on a fresh run and prove the
    // engine PAUSES, then resumes to completion on approve. We reuse the same
    // injected (free) executors, on a fresh contact so dedupe doesn't intercept.
    const { data: c2 } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: `${TAG}gate`, last_name: "Seller", contact_type: "seller",
    }).select("id").single()
    const gateContactId = (c2 as any)?.id as string | undefined
    if (gateContactId) {
      cleanup.push({ table: "transparency_updates", column: "contact_id", value: gateContactId })
      cleanup.push({ table: "activities", column: "contact_id", value: gateContactId })
      cleanup.push({ table: "workflow_runs", column: "contact_id", value: gateContactId })
      cleanup.push({ table: "contacts", column: "id", value: gateContactId })

      // Temporarily flag the CMA step as requiring approval (engine reads step.requiresApproval).
      const cmaStep = listingApptPrepChain.steps.find((s) => s.key === "generate_cma")!
      const original = cmaStep.requiresApproval
      cmaStep.requiresApproval = true
      try {
        const g1 = await startRun({
          chainKey: listingApptPrepChain.key,
          brokerageId, contactId: gateContactId, agentUserId,
          triggerEvent: "listing.appointment_set", metadata,
        })
        check("gated chain PAUSES at the approval step", g1.success && g1.status === "paused", `${g1.status} ${g1.error ?? ""}`)
        const { data: gsteps } = await svc.from("workflow_run_steps")
          .select("step_key, status").eq("run_id", g1.runId!).order("step_index")
        const gl = (gsteps ?? []) as Array<{ step_key: string; status: string }>
        check("paused run: CMA needs_approval, downstream still pending",
          gl.find((s) => s.step_key === "generate_cma")?.status === "needs_approval" &&
          gl.find((s) => s.step_key === "enroll_drip")?.status === "pending")

        const g2 = await approveStep({ runId: g1.runId!, stepKey: "generate_cma" })
        check("approving the gate resumes the chain to completion", g2.success && g2.status === "completed", `${g2.status} ${g2.error ?? ""}`)
        // The resumed run re-enrolls against the SAME presentation. Attachment is
        // idempotent: each reel keeps the section it already has — a re-run must
        // never duplicate or reshuffle a touch the seller may have received.
        const { data: gsections } = await svc.from("presentation_sections")
          .select("section_key, body").eq("presentation_id", seededPresentationId!)
        const gLinked = ((gsections ?? []) as Array<{ section_key: string; body: any }>)
          .filter((s) => !!s.body?.chapter_video?.ai_video_project_id)
        check("resumed run completed the drip enrollment without duplicating reels",
          gLinked.length === seededVideoIds.length &&
          new Set(gLinked.map((s) => s.body.chapter_video.ai_video_project_id)).size === seededVideoIds.length,
          `linked=${gLinked.length}`)
      } finally {
        cmaStep.requiresApproval = original
      }
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
  console.log(" Listing Appointment Prep — flagship chain simulator")
  console.log("══════════════════════════════════════════════════")
  await loadChain()
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ LISTING_APPT_PREP verified — real orchestration, injected money-leaves, dedupe + gate + drip + portal card")
}
main().catch((e) => { console.error(e); process.exit(1) })
