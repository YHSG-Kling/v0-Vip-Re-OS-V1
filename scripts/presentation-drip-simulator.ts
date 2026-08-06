#!/usr/bin/env tsx
/**
 * scripts/presentation-drip-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — seller-facing pre-listing section drip harness.
 *
 *   Layer 1 — planPresentationSections: ordered seller-safe sections spread
 *     across the window before the appointment; the CMA is mixed in price-
 *     withheld; NO section leaks a suggested price; immediate-drip when the
 *     appointment is too soon.
 *   Layer 2 — live materialize round-trip (gated): seed a listing_presentations
 *     row, materialize its sections, assert 7 scheduled seller-safe rows, prove
 *     idempotency, deliver one, then cascade-clean up.
 *
 * Run:  npx tsx scripts/presentation-drip-simulator.ts   (npm run test:presentation-drip)
 */
import {
  planPresentationSections, SECTION_SEQUENCE,
  planChapterReelSections, composeSectionEmail,
} from "../lib/listing-presentation/section-drip"
import { findSuggestedPriceLeaks, containsPriceAmount } from "../lib/cma/customer-facing-guard"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPlan() {
  console.log("\n[Layer 1 · planPresentationSections]")
  const now = new Date("2026-01-01T00:00:00Z")
  const appt = new Date("2026-01-08T00:00:00Z") // 7 days out
  const plan = planPresentationSections({
    presentationId: "p1", brokerageId: "b1", contactId: "c1", appointmentAt: appt, now,
    bufferHoursBeforeAppt: 12, marketNarrative: "Low inventory, strong buyer demand.",
  })

  check("one row per canonical section", plan.length === SECTION_SEQUENCE.length)
  check("section_order is 0..N ascending", plan.every((s, i) => s.section_order === i))
  check("scheduled_for strictly increasing", plan.every((s, i) => i === 0 || s.scheduled_for > plan[i - 1].scheduled_for))
  check("first section scheduled after now", new Date(plan[0].scheduled_for).getTime() > now.getTime())
  check("last section lands before appt minus buffer", new Date(plan[plan.length - 1].scheduled_for).getTime() <= appt.getTime() - 12 * 3_600_000 + 1000)
  check("every section is price_withheld + scheduled", plan.every((s) => s.price_withheld === true && s.status === "scheduled"))
  check("CMA section is mixed in", plan.some((s) => s.section_key === "cma"))
  check("CMA section carries the price-withheld note + market narrative", (() => {
    const cma = plan.find((s) => s.section_key === "cma")!
    return /meeting/i.test(String((cma.body as any).note)) && (cma.body as any).market_narrative === "Low inventory, strong buyer demand."
  })())
  check("NO section leaks a suggested price (compliance)", plan.every((s) => findSuggestedPriceLeaks(s.body).length === 0))

  // Appointment too soon → immediate drip (no negative scheduling).
  const soon = planPresentationSections({ presentationId: "p2", brokerageId: "b1", appointmentAt: new Date(now.getTime() + 2 * 3_600_000), now })
  check("appt within buffer → all sections drip immediately", soon.every((s) => Math.abs(new Date(s.scheduled_for).getTime() - now.getTime()) < 1000))

  // Every section carries a channel, and the drip's whole point is that the
  // channel is HONORED — a row that says 'email'/'both' must produce an email.
  check("every planned section carries a delivery channel", plan.every((s) => ["email", "portal", "both"].includes(s.channel)))
  check("the default channel includes email", plan.every((s) => s.channel === "both"))
}

// ── Layer 1b — chapter reels ride the SAME timetable, one reel per section ──
function testChapterReelPlan() {
  console.log("\n[Layer 1b · planChapterReelSections]")
  const sectionKeys = SECTION_SEQUENCE.map((s) => ({ section_key: s.key, alreadyLinkedVideoId: null as string | null }))

  // The chapters listing-appt-prep actually emits (DEFAULT_CHAPTERS).
  const reels = [
    { videoId: "v-cred", title: "Why I'm the Right Agent for You", focus: "credibility",      chapterIndex: 0 },
    { videoId: "v-price", title: "How I'll Price Your Home",       focus: "pricing_strategy", chapterIndex: 1 },
    { videoId: "v-mktg", title: "My Marketing Plan",               focus: "marketing",        chapterIndex: 2 },
    { videoId: "v-exp",  title: "What to Expect at Our Appointment", focus: "expectations",   chapterIndex: 3 },
  ]
  const plan = planChapterReelSections(reels, sectionKeys)
  check("one assignment per reel", plan.length === reels.length)
  check("every reel lands on a DISTINCT section (one reel per email)",
    new Set(plan.map((a) => a.sectionKey)).size === plan.length)
  check("known focuses land on the section they are the on-camera version of",
    plan[0].sectionKey === "credibility" && plan[1].sectionKey === "cma" &&
    plan[2].sectionKey === "marketing" && plan[3].sectionKey === "process",
    plan.map((a) => `${a.videoId}→${a.sectionKey}`).join(", "))
  check("no new section is invented while canonical sections are free",
    plan.every((a) => !a.isNewSection))

  // Unknown focus → next free section, still no collision.
  const odd = planChapterReelSections(
    [{ videoId: "v-x", title: "Something New", focus: "not_a_focus", chapterIndex: 0 },
     { videoId: "v-y", title: "Another",       focus: null,          chapterIndex: 1 }],
    sectionKeys,
  )
  check("unmapped focus takes the next free section", new Set(odd.map((a) => a.sectionKey)).size === 2 && odd.every((a) => !a.isNewSection))

  // More reels than sections → overflow gets its OWN section (still one scheduler).
  const many = Array.from({ length: SECTION_SEQUENCE.length + 2 }, (_, i) => ({ videoId: `v${i}`, title: `C${i}`, focus: null, chapterIndex: i }))
  const overflowed = planChapterReelSections(many, sectionKeys)
  check("overflow reels get their own sections rather than being dropped",
    overflowed.filter((a) => a.isNewSection).length === 2 && overflowed.every((a) => !!a.sectionKey))

  // Idempotency — a reel already linked keeps its section on a re-run.
  const linked = SECTION_SEQUENCE.map((s) => ({ section_key: s.key, alreadyLinkedVideoId: s.key === "marketing" ? "v-mktg" : null }))
  const again = planChapterReelSections(reels, linked)
  check("a reel already delivered on a section is not moved",
    again.find((a) => a.videoId === "v-mktg")!.sectionKey === "marketing")
  check("re-run still gives every reel a distinct section", new Set(again.map((a) => a.sectionKey)).size === reels.length)
}

// ── Layer 1c — the email the seller actually receives ───────────────────────
function testSectionEmail() {
  console.log("\n[Layer 1c · composeSectionEmail]")
  const base = {
    agentName: "Dana Reyes", brokerageName: "Harbour & Co.",
    propertyAddress: "742 Evergreen Ter, Tampa FL",
    sectionTitle: "How We Sell Your Home", step: 4, totalSteps: 7,
    portalUrl: "https://app.test/portal/listing-plan/p1",
  }
  const withReel = composeSectionEmail({
    ...base,
    reel: { videoUrl: "https://bucket.test/reel.mp4", thumbnailUrl: "https://bucket.test/reel.jpg" },
  })
  check("the reel is embedded as a CLICKABLE THUMBNAIL, not a bare URL",
    withReel.html.includes(`<img src="https://bucket.test/reel.jpg"`) &&
    withReel.html.includes(`<a href="https://bucket.test/reel.mp4"`))
  check("the plain-text part still carries the watch link", withReel.text.includes("https://bucket.test/reel.mp4"))
  check("the email names its place in the timetable", withReel.html.includes("Part 4 of 7") && withReel.text.includes("Part 4 of 7"))
  check("the portal link is present", withReel.html.includes(base.portalUrl))

  // No thumbnail → a button, never a naked URL in the body copy.
  const noThumb = composeSectionEmail({ ...base, reel: { videoUrl: "https://bucket.test/reel.mp4", thumbnailUrl: null } })
  check("a render with no thumbnail degrades to a button", noThumb.html.includes("Watch the video") && !noThumb.html.includes("<img"))

  // No reel at all → the email still says something true, with no dead player.
  const noReel = composeSectionEmail({ ...base, reel: null })
  check("no reel → no fabricated video block", !noReel.html.includes("<img") && !noReel.html.includes("Watch the video"))

  // SELLER-SAFE: a price cannot ride in on a free-text title or note.
  const leaky = composeSectionEmail({
    ...base,
    sectionTitle: "Pricing Your Home at $675,000",
    note: "Your home's value will be presented at our meeting.",
    reel: null,
  })
  check("a price in the TITLE never reaches the subject line",
    !containsPriceAmount(leaky.subject) && leaky.subject.includes("[withheld]"))
  check("a price in the title never reaches the body", !containsPriceAmount(leaky.html) && !containsPriceAmount(leaky.text))
  check("the CMA deferral note survives intact", leaky.html.includes("presented at our meeting"))
  const leakyNote = composeSectionEmail({ ...base, note: "Comparable homes are closing near $1.2 million.", reel: null })
  check("a price in the NOTE is redacted too", !containsPriceAmount(leakyNote.html) && !containsPriceAmount(leakyNote.text))
}

async function testLive() {
  console.log("\n[Layer 2 · live materialize round-trip]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { materializePresentationSections } = await import("../lib/listing-presentation/section-drip")
  const svc = createServiceClient()
  let presId: string | null = null
  const TAG = `__dripsim_${Date.now()}__`
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as any).id

    const { data: pres, error: pErr } = await svc.from("listing_presentations").insert({
      brokerage_id: brokerageId, state: "FL", property_address: `${TAG} 742 Evergreen Ter`,
      built_at: new Date().toISOString(), appointment_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      cma_mid_value: 675000, cma_narrative: "Strong market, low inventory.",
      net_sheet: {}, marketing_plan: {}, slide_deck: { slides: [] }, status: "ready",
    }).select("id").single()
    check("seed listing_presentations", !pErr && !!pres, pErr?.message)
    if (!pres) throw new Error("presentation seed failed")
    presId = (pres as any).id

    const res = await materializePresentationSections(presId!, svc)
    check("materialize inserts the section set", res.ok && res.inserted === SECTION_SEQUENCE.length, res.error)

    const { data: rows } = await svc.from("presentation_sections")
      .select("section_key, section_order, status, price_withheld, scheduled_for, body")
      .eq("presentation_id", presId!).order("section_order")
    const list = rows ?? []
    check("all sections persisted + scheduled + price_withheld", list.length === SECTION_SEQUENCE.length && list.every((r: any) => r.status === "scheduled" && r.price_withheld === true))
    check("sections scheduled in order", list.every((r: any, i: number) => i === 0 || r.scheduled_for >= (list[i - 1] as any).scheduled_for))
    check("CMA section present + market-only (no price leak)", (() => {
      const cma = list.find((r: any) => r.section_key === "cma") as any
      return cma && cma.body?.market_only === true && findSuggestedPriceLeaks(cma.body).length === 0
    })())
    check("NO persisted section leaks a suggested price", list.every((r: any) => findSuggestedPriceLeaks(r.body).length === 0))

    // Idempotency.
    const again = await materializePresentationSections(presId!, svc)
    check("re-materialize is idempotent (0 new rows)", again.ok && again.inserted === 0)

    // Drip delivery — force the first section due, then run the real cron core.
    const { deliverDueSections } = await import("../lib/listing-presentation/section-drip")
    const firstKey = (list[0] as any).section_key
    await svc.from("presentation_sections")
      .update({ scheduled_for: new Date(Date.now() - 60_000).toISOString() })
      .eq("presentation_id", presId!).eq("section_key", firstKey)
    const delivery = await deliverDueSections({ now: new Date() }, svc)
    check("deliverDueSections delivers the due section", delivery.delivered >= 1)
    const { data: deliveredRow } = await svc.from("presentation_sections")
      .select("status, delivered_at").eq("presentation_id", presId!).eq("section_key", firstKey).single()
    check("due section advanced scheduled → delivered + stamped", (deliveredRow as any)?.status === "delivered" && !!(deliveredRow as any)?.delivered_at)
    const { count: stillScheduled } = await svc.from("presentation_sections")
      .select("id", { count: "exact", head: true }).eq("presentation_id", presId!).eq("status", "scheduled")
    check("future sections stay scheduled (only due ones deliver)", (stillScheduled ?? 0) === SECTION_SEQUENCE.length - 1)
  } finally {
    // Cascade: deleting the presentation removes its sections (FK on delete cascade).
    if (presId) { try { await svc.from("listing_presentations").delete().eq("id", presId) } catch { /* noop */ } }
    const { count } = await svc.from("presentation_sections").select("id", { count: "exact", head: true }).eq("presentation_id", presId ?? "00000000-0000-0000-0000-000000000000")
    check("cleanup verified — 0 sections remain (cascade)", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Pre-listing section drip simulator")
  console.log("══════════════════════════════════════════════════")
  testPlan()
  testChapterReelPlan()
  testSectionEmail()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Pre-listing drip verified (seller-safe sections scheduled before the appt)")
}
main().catch((e) => { console.error(e); process.exit(1) })
