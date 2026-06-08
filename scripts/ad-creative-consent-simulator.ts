#!/usr/bin/env tsx
/**
 * scripts/ad-creative-consent-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 41 — finishes the Ads Manager section: (a) the ad lead-form creates a
 * CONSENTED CONTACT (unlocking avatar follow-up + audience eligibility), and
 * (b) high-performing COMPETITOR ads auto-generate NEW ad creative (fresh copy +
 * an Asset-Manager video) into the ad_creative approval queue.
 *
 *   Layer 1 — pure: rankCompetitorAds (longevity + engagement = winner; reach is
 *     ignored) + fallbackCreative (Fair-Housing-clean, not a copy).
 *   Layer 2 — live (gated): ingest an ad lead → assert a CONSENTED contact +
 *     consent event; seed competitor_ads + an Asset-Manager video → run the
 *     engine → assert a DRAFT creative with competitor provenance + Asset-Manager
 *     media lands in the ad_creative queue; idempotency; cleanup.
 *
 * Run: npx tsx scripts/ad-creative-consent-simulator.ts  (npm run test:ad-creative-consent)
 */
import { rankCompetitorAds, fallbackCreative, HIGH_PERF_MIN_LONGEVITY_DAYS, type CompetitorAdRow } from "../lib/ads/ad-creative-engine"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  console.log("\n[Layer 1 · competitor ranking]")
  const now = new Date("2026-02-01T00:00:00Z")
  const ad = (o: Partial<CompetitorAdRow>): CompetitorAdRow => ({
    id: "a", competitor_name: "Rival Realty", source_platform: "facebook", ad_headline: "Sell fast", ad_copy: "We sell homes",
    engagement_score: 0, first_seen_at: null, last_seen_at: null, ad_delivery_start: null, ad_delivery_stop: null, ...o,
  })

  const longRunner = rankCompetitorAds([ad({ id: "long", ad_delivery_start: "2026-01-01T00:00:00Z", ad_delivery_stop: "2026-02-01T00:00:00Z" })], now)[0]
  check("a 31-day-live ad is high-performing (longevity = winner)", longRunner.longevityDays >= HIGH_PERF_MIN_LONGEVITY_DAYS && longRunner.isHighPerforming)

  const freshLowEngage = rankCompetitorAds([ad({ id: "fresh", ad_delivery_start: "2026-01-30T00:00:00Z", engagement_score: 10 })], now)[0]
  check("a 2-day-live, low-engagement ad is NOT high-performing", !freshLowEngage.isHighPerforming)

  const highEngage = rankCompetitorAds([ad({ id: "eng", ad_delivery_start: "2026-01-31T00:00:00Z", engagement_score: 85 })], now)[0]
  check("strong engagement alone qualifies", highEngage.isHighPerforming)

  const ranked = rankCompetitorAds([
    ad({ id: "weak", ad_delivery_start: "2026-01-31T00:00:00Z", engagement_score: 5 }),
    ad({ id: "strong", ad_delivery_start: "2025-12-01T00:00:00Z", ad_delivery_stop: "2026-02-01T00:00:00Z", engagement_score: 60 }),
  ], now)
  check("winners sort to the top", ranked[0].id === "strong")

  console.log("\n[Layer 1 · fallback creative is original + compliant]")
  const fb = fallbackCreative(longRunner, "Kling Group")
  check("fallback does not reuse the competitor's wording", fb.headline !== "Sell fast" && fb.primaryText.includes("Kling Group"))
  check("fallback has a valid CTA", ["LEARN_MORE", "SIGN_UP", "CONTACT_US", "GET_OFFER"].includes(fb.callToAction))
}

async function testLive() {
  console.log("\n[Layer 2 · live consent intake + competitor creative]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { ingestConsentedAdLead } = await import("../lib/ads/ad-lead-intake")
  const { proposeCompetitorInspiredCreative } = await import("../lib/ads/ad-creative-engine")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const svc = createServiceClient()
  const TAG = `__adcr_${Date.now()}__`
  const email = `${TAG}@example.com`
  let contactId: string | null = null
  const compIds: string[] = []; const assetIds: string[] = []; const campIds: string[] = []; const creativeIds: string[] = []
  try {
    const { data: brk } = await svc.from("brokerages").select("id, name").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id

    // ── Consent intake: ad form → consented contact ──
    const r1 = await ingestConsentedAdLead({ brokerageId, firstName: "Pat", email, phone: null, platform: "facebook", formId: "f1" }, svc)
    check("ad lead-form ingests a contact", r1.ok && !!r1.contactId, r1.reason)
    contactId = r1.contactId ?? null
    const { data: c } = await svc.from("contacts").select("tcpa_consent, tcpa_consent_source, contact_type").eq("id", contactId!).single()
    check("contact is CONSENTED (tcpa_consent=true, source ad_lead_form)", (c as any).tcpa_consent === true && (c as any).tcpa_consent_source === "ad_lead_form")
    const { count: events } = await svc.from("contact_consent_events").select("id", { count: "exact", head: true }).eq("contact_id", contactId!).eq("consented", true)
    check("a consent audit event was written", (events ?? 0) >= 1)
    // Idempotent re-ingest upgrades the same contact.
    const r2 = await ingestConsentedAdLead({ brokerageId, firstName: "Pat", email, platform: "facebook" }, svc)
    check("re-ingest de-dupes to the same contact", r2.ok && r2.contactId === contactId && r2.created === false)

    // ── Competitor-inspired creative ──
    // Seed an Asset-Manager video (the creative's media source).
    const { data: asset } = await svc.from("marketing_assets").insert({
      brokerage_id: brokerageId, asset_type: "video", asset_name: `${TAG} avatar reel`,
      asset_url: "https://blob/avatar-reel.mp4", tags: ["avatar", "reusable"], approval_status: "approved",
    }).select("id").single()
    assetIds.push((asset as { id: string }).id)

    // Seed a high-performing competitor ad (long-running).
    const { data: comp } = await svc.from("competitor_ads").insert({
      brokerage_id: brokerageId, source_platform: "facebook", competitor_name: `${TAG} Rival`,
      ad_headline: "We sell in 7 days", ad_copy: "List with us and sell fast.",
      engagement_score: 80, ad_delivery_start: new Date(Date.now() - 40 * 86_400_000).toISOString(), ad_delivery_stop: new Date().toISOString(),
    }).select("id").single()
    compIds.push((comp as { id: string }).id)

    const eng = await proposeCompetitorInspiredCreative(brokerageId, svc, { limit: 3 })
    check("engine proposes creative from the high-performing competitor ad", eng.proposed >= 1, JSON.stringify(eng))
    check("engine sourced media from the Asset Manager", eng.usedAssetManagerMedia >= 1)

    const { data: creatives } = await svc.from("ad_creative_variations")
      .select("id, ad_campaign_id, approval_status, generated_from, competitor_ad_id, source_marketing_asset_id, media_asset_url, headline")
      .eq("competitor_ad_id", compIds[0])
    const list = (creatives ?? []) as Array<any>
    for (const c of list) creativeIds.push(c.id)
    const cr = list[0]
    check("a DRAFT creative was created with competitor provenance", !!cr && cr.approval_status === "draft" && cr.generated_from === "competitor")
    check("creative links the Asset-Manager media (avatar reel)", !!cr && cr.source_marketing_asset_id === assetIds[0] && cr.media_asset_url === "https://blob/avatar-reel.mp4")
    check("creative copy is fresh (not a verbatim copy of the competitor)", !!cr && cr.headline !== "We sell in 7 days")
    if (cr) { const { data: camp } = await svc.from("ad_campaigns").select("id").eq("id", cr.ad_campaign_id).single(); if (camp) campIds.push((camp as { id: string }).id) }

    // It surfaces in the unified ad_creative approval queue.
    const cc = await loadCommandCenter({ brokerageId })
    check("draft creative surfaces in the Command Center ad_creative queue", !!cc.pendingActions.find((a) => a.id === cr?.id && a.queue === "ad_creative"))

    // Idempotent — one creative per competitor ad.
    const eng2 = await proposeCompetitorInspiredCreative(brokerageId, svc, { limit: 3 })
    check("engine is idempotent (no duplicate creative per competitor ad)", eng2.proposed === 0)
  } finally {
    for (const id of creativeIds) { try { await svc.from("ad_creative_variations").delete().eq("id", id) } catch {} }
    for (const id of campIds) { try { await svc.from("ad_campaigns").delete().eq("id", id) } catch {} }
    for (const id of compIds) { try { await svc.from("competitor_ads").delete().eq("id", id) } catch {} }
    for (const id of assetIds) { try { await svc.from("marketing_assets").delete().eq("id", id) } catch {} }
    if (contactId) { try { await svc.from("contact_consent_events").delete().eq("contact_id", contactId) } catch {}; try { await svc.from("contacts").delete().eq("id", contactId) } catch {} }
    // Clean any stray AI Creative Lab campaign created with no creatives left.
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("email", email)
    check("cleanup verified — 0 test contacts remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Ad creative + consent simulator (finish the Ads Manager)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Ad form → consented contact; competitor winners → governed creative from the Asset Manager")
}
main().catch((e) => { console.error(e); process.exit(1) })
