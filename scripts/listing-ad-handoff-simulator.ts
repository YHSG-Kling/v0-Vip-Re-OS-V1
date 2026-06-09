#!/usr/bin/env tsx
/**
 * scripts/listing-ad-handoff-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 49 — proves the cross-manager AUTO-handoff is DELIVERABLE-gated, not
 * proposal-gated: a listing going live AUTO-produces a draft paid-ad campaign +
 * creative (zero agent effort), and the ONLY human gate is the finished creative
 * in the ad_creative approval queue. Fair-Housing-clean copy by construction.
 *
 *   Layer 1 — pure: buildListingCreative (just-listed / just-sold; no protected-class
 *     language; specs from facts).
 *   Layer 2 — live (gated): seed a listing → produceListingAdCampaign auto-creates a
 *     DRAFT campaign + a DRAFT creative that surfaces in the Command Center
 *     ad_creative queue; idempotent; cleanup.
 *
 * Run: npx tsx scripts/listing-ad-handoff-simulator.ts  (npm run test:listing-ad-handoff)
 */
import { buildListingCreative } from "../lib/ads/listing-ad-producer"
import { findSuggestedPriceLeaks } from "../lib/cma/customer-facing-guard"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  console.log("\n[Layer 1 · buildListingCreative]")
  const jl = buildListingCreative({ city: "Maple Grove", bedrooms: 4, bathrooms: 3 }, "just_listed")
  check("just-listed headline + specs woven in", jl.headline === "Just Listed!" && /4 bed, 3 bath/.test(jl.primaryText) && /Maple Grove/.test(jl.primaryText))
  const js = buildListingCreative({ city: "Maple Grove" }, "just_sold")
  check("just-sold headline + 'what yours could sell for'", js.headline === "Just Sold!" && /sell for/i.test(js.primaryText))
  check("valid CTA", ["LEARN_MORE", "SIGN_UP", "CONTACT_US", "GET_OFFER"].includes(jl.callToAction))
  check("Fair-Housing clean — no protected-class / 'should live' language", !/(family|families|safe neighborhood|good schools|christian|no kids|adults only|perfect for)/i.test(jl.primaryText + js.primaryText))
  check("seller-safe — no suggested price leaked", findSuggestedPriceLeaks({ a: jl.primaryText, b: js.primaryText }).length === 0)
}

async function testLive() {
  console.log("\n[Layer 2 · live auto-handoff]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure layer ran)."); return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { produceListingAdCampaign } = await import("../lib/ads/listing-ad-producer")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const svc = createServiceClient()
  const TAG = `__lah_${Date.now()}__`
  let listingId: string | null = null; let campaignId: string | null = null; let creativeId: string | null = null
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id

    const { data: listing, error: lErr } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: `${TAG} 742 Evergreen Ter`, city: "Maple Grove", state: "MN",
      list_price: 675000, bedrooms: 4, bathrooms: 3, status: "active", lifecycle_stage: "MLS_ACTIVE",
    }).select("id").maybeSingle()
    if (lErr || !listing) { console.log(`  ⏭  listing seed failed (${lErr?.message}) — skipped`); return }
    listingId = (listing as { id: string }).id

    // AUTO-produce (no proposal step).
    const r = await produceListingAdCampaign(brokerageId, listingId, "just_listed", svc)
    check("listing live → auto-produces a draft ad campaign + creative", r.produced === true && !!r.creativeId, r.reason)
    campaignId = r.campaignId ?? null; creativeId = r.creativeId ?? null

    const { data: camp } = await svc.from("ad_campaigns").select("status, targeting_config").eq("id", campaignId!).single()
    check("campaign is a DRAFT (no spend, not launched)", (camp as any).status === "draft" && (camp as any).targeting_config?.listing_id === listingId)
    const { data: cr } = await svc.from("ad_creative_variations").select("approval_status, generated_from, headline").eq("id", creativeId!).single()
    check("creative is a DRAFT awaiting the human deliverable gate", (cr as any).approval_status === "draft" && (cr as any).generated_from === "listing_handoff")

    // It surfaces in the ad_creative queue — the ONLY human gate.
    const cc = await loadCommandCenter({ brokerageId })
    check("creative surfaces in the Command Center ad_creative deliverable queue", !!cc.pendingActions.find((a) => a.id === creativeId && a.queue === "ad_creative"))

    // Idempotent — re-firing the handoff does not duplicate.
    const r2 = await produceListingAdCampaign(brokerageId, listingId, "just_listed", svc)
    check("auto-handoff is idempotent (one campaign per listing/kind)", r2.produced === false && r2.campaignId === campaignId)
  } finally {
    if (creativeId) { try { await svc.from("ad_creative_variations").delete().eq("id", creativeId) } catch {} }
    if (campaignId) { try { await svc.from("ad_campaigns").delete().eq("id", campaignId) } catch {} }
    if (listingId) { try { await svc.from("listings").delete().eq("id", listingId) } catch {} }
    const { count } = await svc.from("listings").select("id", { count: "exact", head: true }).like("address", `${TAG}%`)
    check("cleanup verified — 0 test listings remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Listing → paid-ad AUTO-handoff simulator (deliverable-gated)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Auto-handoff: zero agent effort; only the finished creative is human-gated")
}
main()
