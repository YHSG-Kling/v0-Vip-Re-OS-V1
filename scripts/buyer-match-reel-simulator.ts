#!/usr/bin/env tsx
/**
 * scripts/buyer-match-reel-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 59 — proves the buyer property-match REEL AUTO-handoff is DELIVERABLE-gated:
 * when a buyer gets fresh high-score matches, the system enqueues a personalized
 * "homes matching your search" reel (reusing AffordabilitySnapshotReel) into the
 * canonical render queue — zero agent effort, idempotent per buyer/week.
 *
 *   Layer 1 — pure: buildBuyerMatchReelProps (3 cards, formatted price, sanitized,
 *     Fair-Housing clean labels).
 *   Layer 2 — live (gated): seed a buyer + listing + property_match → produceBuyerMatchReel
 *     enqueues a 'queued' remotion_composition_renders row with the right composition +
 *     inputProps + scope; idempotent within the cooldown; cleanup.
 *
 * Run: npx tsx scripts/buyer-match-reel-simulator.ts  (npm run test:buyer-match-reel)
 */
import { buildBuyerMatchReelProps } from "../lib/agents/buyer-match-reel-producer"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  console.log("\n[Layer 1 · buildBuyerMatchReelProps — resolved facts from EITHER source]")
  const props = buildBuyerMatchReelProps(
    [
      { id: "1", address: "12 Oak St", city: "Maple Grove", state: "MN", price: 485000, bedrooms: 3, bathrooms: 2, photoUrl: "https://cdn/x.jpg", source: "listing", status: "active" },
      { id: "2", address: "9 Elm Ave", city: "Maple Grove", state: "MN", price: 525000, bedrooms: 4, bathrooms: 3, photoUrl: null, source: "idx", status: "active" },
    ],
    { agentName: "Dana Kling", agentPhone: "(555) 555-1212", brokerageName: "Kling Realty" },
  ) as any
  check("builds props with one card per resolved property", Array.isArray(props?.examples) && props.examples.length === 2)
  check("formats price as currency", props.examples[0].price === "$485,000")
  check("carries the photo when present (external MLS snapshot)", props.examples[0].photoUrl === "https://cdn/x.jpg")
  check("weaves the area from the property city", props.areaName === "Maple Grove")
  check("buyer-match framing headline (not a generic affordability band)", /matching your search/i.test(props.monthlyHeadline))
  check("carries agent + brokerage for the footer", props.agentName === "Dana Kling" && props.brand.brokerageName === "Kling Realty")
  check("Fair-Housing clean labels", !/famil|kids|perfect for|safe neighborhood/i.test(JSON.stringify(props)))
  const none = buildBuyerMatchReelProps([{ id: "x", address: null, city: null, state: null, price: null, bedrooms: null, bathrooms: null, photoUrl: null, source: "saved", status: "active" }], { agentName: "X", agentPhone: "", brokerageName: "Y" })
  check("no renderable facts → null (no empty reel)", none === null)
}

async function testLive() {
  console.log("\n[Layer 2 · live render-queue enqueue]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure layer ran)."); return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { produceBuyerMatchReel } = await import("../lib/agents/buyer-match-reel-producer")
  const svc = createServiceClient()
  const TAG = `__bmr_${Date.now()}__`
  let buyerId: string | null = null, listingId: string | null = null, savedId: string | null = null
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id

    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: `${TAG}Buyer`, last_name: "Test", email: `${TAG}b@example.com`, contact_type: "buyer",
    }).select("id").maybeSingle()
    buyerId = (c as { id: string } | null)?.id ?? null
    const { data: l } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: `${TAG} 12 Oak St`, city: "Maple Grove", state: "MN",
      list_price: 485000, bedrooms: 3, bathrooms: 2, status: "active", lifecycle_stage: "MLS_ACTIVE",
    }).select("id").maybeSingle()
    listingId = (l as { id: string } | null)?.id ?? null
    if (!buyerId || !listingId) { console.log("  ⏭  seed failed — skipped"); return }

    await svc.from("property_matches").insert({
      brokerage_id: brokerageId, contact_id: buyerId, property_id: listingId, match_score: 95, ai_generated: true,
    })
    // An EXTERNAL MLS (RentCast/IDX) match — cached in saved_properties, referenced by its uuid.
    const { data: anyUser } = await svc.from("users").select("id").limit(1).maybeSingle()
    const userId = (anyUser as { id: string } | null)?.id ?? null
    const { data: sp } = userId ? await svc.from("saved_properties").insert({
      brokerage_id: brokerageId, contact_id: buyerId, user_id: userId, source: "idx", external_property_id: `${TAG}MLS1`,
      property_address: `${TAG} 9 Elm Ave`, city: "Maple Grove", state: "MN", list_price: 525000,
      bedrooms: 4, bathrooms: 3, primary_photo_url: "https://cdn.example/elm.jpg",
    }).select("id").maybeSingle() : { data: null }
    savedId = (sp as { id: string } | null)?.id ?? null
    if (savedId) {
      await svc.from("property_matches").insert({
        brokerage_id: brokerageId, contact_id: buyerId, property_id: savedId, match_score: 92, ai_generated: true,
      })
    }

    const r = await produceBuyerMatchReel(brokerageId, buyerId, svc)
    check("fresh matches → enqueues a reel render", r.queued === true && !!r.renderId, r.reason)

    const { data: render } = await svc.from("remotion_composition_renders")
      .select("composition_id, render_status, entity_type, entity_id, input_props")
      .eq("id", r.renderId!).maybeSingle()
    const rr = render as any
    check("queued render uses AffordabilitySnapshotReel, scoped to the contact", rr?.composition_id === "AffordabilitySnapshotReel" && rr?.render_status === "queued" && rr?.entity_type === "contact" && rr?.entity_id === buyerId)
    const examplesJson = JSON.stringify(rr?.input_props?.examples ?? [])
    check("inputProps carry the OUR-LISTING match card", /Oak St/.test(examplesJson))
    if (savedId) {
      check("inputProps ALSO carry the EXTERNAL MLS match (resolved from saved_properties)", /Elm Ave/.test(examplesJson))
      check("external MLS card carries its photo", /elm\.jpg/.test(examplesJson))
    }

    const r2 = await produceBuyerMatchReel(brokerageId, buyerId, svc)
    check("idempotent within the weekly cooldown (no duplicate reel)", r2.queued === false, r2.reason)
  } finally {
    if (buyerId) {
      try { await svc.from("remotion_composition_renders").delete().eq("entity_id", buyerId).eq("composition_id", "AffordabilitySnapshotReel") } catch {}
      try { await svc.from("property_matches").delete().eq("contact_id", buyerId) } catch {}
      try { await svc.from("saved_properties").delete().eq("contact_id", buyerId) } catch {}
      try { await svc.from("contacts").delete().eq("id", buyerId) } catch {}
    }
    if (listingId) { try { await svc.from("listings").delete().eq("id", listingId) } catch {} }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("first_name", `${TAG}%`)
    check("cleanup verified — 0 test contacts remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Buyer property-match REEL AUTO-handoff simulator (deliverable-gated)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Buyer match reel: zero agent effort; render is deliverable-gated in the queue")
}
main().catch((e) => { console.error(e); process.exit(1) })
