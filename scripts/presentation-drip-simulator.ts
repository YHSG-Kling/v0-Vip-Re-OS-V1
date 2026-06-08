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
import { planPresentationSections, SECTION_SEQUENCE } from "../lib/listing-presentation/section-drip"
import { findSuggestedPriceLeaks } from "../lib/cma/customer-facing-guard"

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
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Pre-listing drip verified (seller-safe sections scheduled before the appt)")
}
main().catch((e) => { console.error(e); process.exit(1) })
