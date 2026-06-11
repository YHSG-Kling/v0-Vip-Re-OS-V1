#!/usr/bin/env tsx
/**
 * scripts/client-pulse-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CLIENT PULSE harness — the weekly "what your team did," for the CLIENT.
 *
 * Layer 1 (pure): composeSellerPulse / composeBuyerPulse — earned lines only;
 *   an EMPTY week returns null (silence beats fabricated activity); honest
 *   coverage language for the next deadline ("already covered" vs "on it").
 * Layer 2 (live, gated): seed a seller week (listing + seller contact + showing
 *   with feedback + published social post + reel + live ad in city) and a buyer
 *   week (live deal + saves + tour); run runClientPulse; assert BOTH pulses land
 *   in the gate (proposed, portal, never sent), the bodies carry the real facts,
 *   a quiet client gets NOTHING, and the weekly idempotency holds. Self-cleans.
 *
 * Run: npx tsx scripts/client-pulse-simulator.ts  (npm run test:client-pulse)
 */
import { composeSellerPulse, composeBuyerPulse, runClientPulse } from "../lib/kernel/client-pulse"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Client Pulse verified — the client never wonders")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Client Pulse simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · compose]")
  const seller = composeSellerPulse("Dana", {
    address: "44 Birch Lane", showings: 3, feedbackSnippet: "Loved the kitchen",
    socialPosts: 2, reelStatus: "ready", adsLiveInCity: 1,
    nextDeadline: { kind: "appraisal", date: "2026-06-19", covered: true },
  })
  check("seller: every earned line present (showings+feedback, social, reel, ads)",
    !!seller && seller.body.includes("3 buyer showings") && seller.body.includes("Loved the kitchen")
    && seller.body.includes("2 social posts") && seller.body.includes("rendered") && seller.body.includes("1 paid campaign"))
  check("seller: covered deadline says 'already covered' (honest reassurance)", !!seller && seller.body.includes("already covered"))
  const sellerUncovered = composeSellerPulse("Dana", {
    address: "44 Birch Lane", showings: 1, feedbackSnippet: null, socialPosts: 0,
    reelStatus: null, adsLiveInCity: 0,
    nextDeadline: { kind: "financing", date: "2026-06-15", covered: false },
  })
  check("seller: uncovered deadline says 'on it' — never overpromises", !!sellerUncovered && sellerUncovered.body.includes("on it this week"))
  check("seller: an EMPTY week returns null (silence beats noise)",
    composeSellerPulse("Dana", { address: "x", showings: 0, feedbackSnippet: null, socialPosts: 0, reelStatus: null, adsLiveInCity: 0, nextDeadline: null }) === null)

  const buyer = composeBuyerPulse("Sam", {
    savedThisWeek: 4, latestSave: "9 Elm St", toursOnBooks: 2,
    dealName: "12 Oak St", stage: "FINANCING_PENDING",
    nextDeadline: { kind: "financing", date: "2026-06-16", covered: false },
  })
  check("buyer: saves + tours + stage + deadline all present",
    !!buyer && buyer.body.includes("4 homes") && buyer.body.includes("2 tours") && buyer.body.includes("financing pending") && buyer.body.includes("2026-06-16"))
  check("buyer: an EMPTY week returns null",
    composeBuyerPulse("Sam", { savedThisWeek: 0, latestSave: null, toursOnBooks: 0, dealName: null, stage: null, nextDeadline: null }) === null)

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live pulse]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `Pulse${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentUserId = (agent as any).user_id

    // SELLER week: listing + seller + showing w/ feedback + published social + reel + ad.
    const { data: sellerC } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Sellerpulse", last_name: TAG, contact_type: "seller",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (sellerC as any).id })
    const { data: lst } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: `${TAG} 44 Birch Lane`, city: `${TAG}ville`,
      status: "active", seller_contact_id: (sellerC as any).id,
    }).select("id").single()
    cleanup.push({ table: "listings", id: (lst as any).id })
    // showings.contact_id is NOT NULL — the visiting buyer.
    const { data: visitor } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Visitor", last_name: TAG, contact_type: "buyer",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (visitor as any).id })
    const { data: show } = await svc.from("showings").insert({
      brokerage_id: brokerageId, listing_id: (lst as any).id, contact_id: (visitor as any).id,
      agent_id: (agent as any).id, scheduled_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      scheduled_date: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
      status: "completed", feedback: "Loved the kitchen, thinking it over",
    }).select("id").single()
    cleanup.push({ table: "showings", id: (show as any).id })
    const { data: sp } = await svc.from("social_posts").insert({
      brokerage_id: brokerageId, listing_id: (lst as any).id, platform: "all", post_type: "new_listing",
      content: "x", status: "published", approval_status: "approved",
      published_at: new Date(Date.now() - 86_400_000).toISOString(),
    }).select("id").single()
    cleanup.push({ table: "social_posts", id: (sp as any).id })
    const { data: reel } = await svc.from("listing_promo_videos").insert({
      brokerage_id: brokerageId, listing_id: (lst as any).id, agent_id: agentUserId,
      event_type: "just_listed", status: "social_drafted",
    }).select("id").single()
    cleanup.push({ table: "listing_promo_videos", id: (reel as any).id })
    const { data: ad } = await svc.from("ad_campaigns").insert({
      brokerage_id: brokerageId, campaign_name: `${TAG} Cover`, platform: "facebook",
      status: "live", objective: "lead_generation", targeting_config: { locations: [`${TAG}ville`] },
    }).select("id").single()
    cleanup.push({ table: "ad_campaigns", id: (ad as any).id })

    // BUYER week: live deal + a save this week + a tour.
    const { data: buyerC } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Buyerpulse", last_name: TAG, contact_type: "buyer",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (buyerC as any).id })
    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} 12 Oak St`, status: "under_contract",
      stage: "FINANCING_PENDING", buyer_contact_id: (buyerC as any).id, agent_id: (agent as any).id,
      financing_deadline: new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10),
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (txn as any).id })
    const { data: sv } = await svc.from("saved_properties").insert({
      brokerage_id: brokerageId, contact_id: (buyerC as any).id, user_id: agentUserId,
      property_address: `${TAG} 9 Elm St`, dismissed: false,
    }).select("id").single()
    cleanup.push({ table: "saved_properties", id: (sv as any).id })
    const { data: tour } = await svc.from("tours").insert({
      brokerage_id: brokerageId, contact_id: (buyerC as any).id, status: "scheduled",
    }).select("id").single()
    cleanup.push({ table: "tours", id: (tour as any).id })

    // A QUIET client — active listing, zero activity → must get NOTHING.
    const { data: quietC } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Quiet", last_name: TAG, contact_type: "seller",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (quietC as any).id })
    const { data: quietL } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: `${TAG} 1 Silent Rd`, city: `${TAG}quiet`,
      status: "active", seller_contact_id: (quietC as any).id,
    }).select("id").single()
    cleanup.push({ table: "listings", id: (quietL as any).id })

    const r1 = await runClientPulse(brokerageId, {}, svc)
    check("seller + buyer pulses proposed; the quiet client got NOTHING",
      r1.sellerPulses >= 1 && r1.buyerPulses >= 1 && r1.quietWeeks >= 1)

    const { data: sPulse } = await svc.from("agent_client_messages")
      .select("id, status, channel, audience, agent_kind, body").eq("recipient_contact_id", (sellerC as any).id).maybeSingle()
    if (sPulse) cleanup.push({ table: "agent_client_messages", id: (sPulse as any).id })
    check("seller pulse: gated (proposed, portal, Listing Concierge, seller audience)",
      (sPulse as any)?.status === "proposed" && (sPulse as any)?.channel === "portal" && (sPulse as any)?.agent_kind === "listing_concierge")
    check("seller pulse: the real week in the body (showing feedback + social + reel + ad)",
      ((sPulse as any)?.body ?? "").includes("Loved the kitchen") && ((sPulse as any)?.body ?? "").includes("1 social post")
      && ((sPulse as any)?.body ?? "").includes("rendered") && ((sPulse as any)?.body ?? "").includes("1 paid campaign"))
    const { data: bPulse } = await svc.from("agent_client_messages")
      .select("id, status, body, agent_kind").eq("recipient_contact_id", (buyerC as any).id).maybeSingle()
    if (bPulse) cleanup.push({ table: "agent_client_messages", id: (bPulse as any).id })
    check("buyer pulse: gated by the Shopping Agent with the real deal facts",
      (bPulse as any)?.agent_kind === "shopping_agent" && ((bPulse as any)?.body ?? "").includes("financing pending")
      && ((bPulse as any)?.body ?? "").includes("1 home"))
    const { data: qPulse } = await svc.from("agent_client_messages")
      .select("id").eq("recipient_contact_id", (quietC as any).id).maybeSingle()
    if (qPulse) cleanup.push({ table: "agent_client_messages", id: (qPulse as any).id })
    check("quiet client: zero messages (silence beats fabricated activity)", !qPulse)
    for (const cid of [(sellerC as any).id, (buyerC as any).id]) {
      const { data: rtN } = await svc.from("notifications").select("id").eq("type", "approval_needed")
        .in("entity_id", [(sPulse as any)?.id, (bPulse as any)?.id].filter(Boolean)).limit(5)
      for (const n of (rtN ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
      void cid
    }

    // Weekly idempotency.
    const r2 = await runClientPulse(brokerageId, {}, svc)
    check("idempotency: one Pulse per client per week", r2.sellerPulses === 0 && r2.buyerPulses === 0)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("last_name", TAG)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
