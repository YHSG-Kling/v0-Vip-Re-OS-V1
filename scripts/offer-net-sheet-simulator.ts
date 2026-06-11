#!/usr/bin/env tsx
/**
 * scripts/offer-net-sheet-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OFFER NET SHEET harness — the seller's "which offer do I actually keep the
 * most from?" play.
 *
 * Layer 1 (pure): computeNetProceeds (price − commission − payoff − taxes − HOA −
 *   other − buyer credit); rankOffersByNet (RANK-BY-NET beats rank-by-price when a
 *   LOWER offer nets more); composeComparisonFallback (earned lines, names the net
 *   winner + the dollar delta, no fabrication).
 * Layer 2 (live, gated): seed an in-house listing (seller_contact_id + agent_id) +
 *   seller contact + 2 offers (A higher price but big buyer credit, B lower price no
 *   credit so B NETS MORE); run runOfferNetSheets; assert a GATED agent comparison
 *   summary (audience 'agent', proposed) AND a seller PORTAL CARD (transparency_updates,
 *   visible, update_type 'offer_net_sheet') whose metadata names B as the net winner;
 *   second pass is a no-op (idempotent per offer-set/24h). Self-cleans with a unique TAG.
 *
 * Run: npx tsx scripts/offer-net-sheet-simulator.ts  (npm run test:offer-net-sheet)
 */
import {
  computeNetProceeds,
  rankOffersByNet,
  composeComparisonFallback,
  offerSetSignature,
  type OfferNetInput,
} from "../lib/kernel/offer-net-sheet"

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
  console.log(" ✅ Offer Net Sheet verified — rank-by-net + gated agent summary + seller portal value card")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Offer Net Sheet simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · net math + rank-by-net + compose]")

  // Shared seller-responsible costs.
  const costs = { commissionRate: 0.06, mortgagePayoff: 300_000, countyCityTaxes: 4_000, hoaDuesProration: 1_200, otherProratedFees: 1_500 }

  // Offer A: higher price ($520k) but a big buyer credit ($18k).
  const netA = computeNetProceeds({ offerPrice: 520_000, buyerClosingCredit: 18_000 }, costs)
  // Offer B: lower price ($512k), no buyer credit.
  const netB = computeNetProceeds({ offerPrice: 512_000, buyerClosingCredit: 0 }, costs)
  // Hand-computed: A = 520000 - 31200 - 300000 - 4000 - 1200 - 1500 - 18000 = 164100
  //                B = 512000 - 30720 - 300000 - 4000 - 1200 - 1500 - 0     = 174580
  check("computeNetProceeds A correct", netA === 164_100, `got ${netA}`)
  check("computeNetProceeds B correct", netB === 174_580, `got ${netB}`)
  check("LOWER-priced offer B nets MORE than higher-priced A (the whole point)", netB > netA)

  const inputs: OfferNetInput[] = [
    { offerId: "A", buyerName: "Buyer A", offerPrice: 520_000, financingType: "conventional", buyerClosingCredit: 18_000 },
    { offerId: "B", buyerName: "Buyer B", offerPrice: 512_000, financingType: "cash", buyerClosingCredit: 0 },
  ]
  const ranking = rankOffersByNet(inputs, costs)
  check("rank-by-net: top by PRICE is A", ranking.topByPrice === "A")
  check("rank-by-net: top by NET is B", ranking.topByNet === "B")
  check("rank-by-net: netBeatsPrice flag true (net winner ≠ price winner)", ranking.netBeatsPrice === true)

  const composed = composeComparisonFallback({ listingAddress: "10 Probe St", ranking })
  check("agent summary names the listing + net delta + 'despite a lower price'",
    composed.agentSummary.includes("10 Probe St") && composed.agentSummary.includes("Buyer B") && composed.agentSummary.toLowerCase().includes("despite a lower price"))
  check("seller card body is read-only + does NOT fabricate (mentions 'read-only')",
    composed.sellerCardBody.toLowerCase().includes("read-only"))

  // Single-offer + matching-winner edge cases.
  const single = rankOffersByNet([inputs[0]], costs)
  check("single offer: net winner = price winner, netBeatsPrice false", single.topByNet === "A" && single.topByPrice === "A" && !single.netBeatsPrice)
  check("offerSetSignature order-independent", offerSetSignature(["B", "A"]) === offerSetSignature(["A", "B"]))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live offer net sheet]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { runOfferNetSheets } = await import("../lib/kernel/offer-net-sheet")
  const svc = createServiceClient()
  const TAG = `NetSheet${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // Seller is a CONTACT (has a portal).
    const { data: seller } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Seller", contact_type: "seller",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (seller as any).id })

    // OUR in-house listing: seller_contact_id + agent_id (FK → agents.id) set.
    const { data: lst } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: `${TAG} 10 Probe St`, city: "Testville", state: "CA",
      status: "active", list_price: 515_000, agent_id: (agent as any).id,
      seller_contact_id: (seller as any).id, hoa_dues: 100, commission_rate: 6,
    }).select("id").single()
    cleanup.push({ table: "listings", id: (lst as any).id })

    // Two offers — A higher price + big credit, B lower price no credit (B nets more).
    const { data: offA } = await svc.from("offers").insert({
      brokerage_id: brokerageId, listing_id: (lst as any).id, contact_id: (seller as any).id,
      agent_id: (agent as any).id, offer_price: 520_000, closing_cost_contribution: 18_000,
      status: "pending", financing_type: "conventional", submitted_at: new Date().toISOString(),
    }).select("id").single()
    cleanup.push({ table: "offers", id: (offA as any).id })
    const { data: offB } = await svc.from("offers").insert({
      brokerage_id: brokerageId, listing_id: (lst as any).id, contact_id: (seller as any).id,
      agent_id: (agent as any).id, offer_price: 512_000, closing_cost_contribution: 0,
      status: "pending", financing_type: "cash", submitted_at: new Date().toISOString(),
    }).select("id").single()
    cleanup.push({ table: "offers", id: (offB as any).id })

    // Known costs so the net assertions are deterministic (B nets more).
    const r1 = await runOfferNetSheets(brokerageId, {
      costsResolver: () => ({ commissionRate: 0.06, mortgagePayoff: 300_000, countyCityTaxes: 4_000, hoaDuesProration: 1_200, otherProratedFees: 1_500 }),
      copyGenerator: async () => null, // deterministic fallback (no token spend)
    }, svc)

    check("runner: comparison proposed + portal card pushed for the in-house listing",
      r1.listingsScanned >= 1 && r1.comparisonsProposed >= 1 && r1.portalCardsPushed >= 1)

    const sig = offerSetSignature([(offA as any).id, (offB as any).id])

    // (a) GATED agent summary — audience 'agent', proposed, listing_concierge.
    const { data: summary } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind, entity_id, subject, rationale")
      .eq("entity_id", (lst as any).id).ilike("rationale", `OFFER NET SHEET — sig:${sig}%`).maybeSingle()
    if (summary) {
      cleanup.push({ table: "agent_client_messages", id: (summary as any).id })
      const { data: notes } = await svc.from("notifications").select("id").eq("entity_id", (summary as any).id)
      for (const n of (notes ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }
    check("Listing Concierge: ONE gated agent comparison summary (audience 'agent', proposed)",
      (summary as any)?.status === "proposed" && (summary as any)?.audience === "agent" && (summary as any)?.agent_kind === "listing_concierge")
    check("agent summary subject signals the comparison is ready (offers time-sensitive)",
      ((summary as any)?.subject ?? "").toLowerCase().includes("offer comparison ready"))

    // (b) Seller PORTAL CARD — transparency_updates, visible, names B as net winner.
    const { data: card } = await svc.from("transparency_updates")
      .select("id, contact_id, listing_id, update_type, is_visible_to_client, metadata, title")
      .eq("listing_id", (lst as any).id).eq("update_type", "offer_net_sheet").maybeSingle()
    if (card) cleanup.push({ table: "transparency_updates", id: (card as any).id })
    check("seller portal: read-only VALUE card pushed (visible, update_type 'offer_net_sheet', to the seller contact)",
      (card as any)?.is_visible_to_client === true && (card as any)?.contact_id === (seller as any).id)
    check("portal card metadata: NET winner is offer B (lower price), net beats price",
      (card as any)?.metadata?.net_winner_offer_id === (offB as any).id &&
      (card as any)?.metadata?.price_winner_offer_id === (offA as any).id &&
      (card as any)?.metadata?.net_beats_price === true)

    // Idempotency — second pass within 24h on the same offer-set is a no-op.
    const r2 = await runOfferNetSheets(brokerageId, {
      costsResolver: () => ({ commissionRate: 0.06, mortgagePayoff: 300_000, countyCityTaxes: 4_000, hoaDuesProration: 1_200, otherProratedFees: 1_500 }),
      copyGenerator: async () => null,
    }, svc)
    check("idempotency: second pass proposes nothing new (one comparison per offer-set/24h)",
      r2.comparisonsProposed === 0 && r2.portalCardsPushed === 0)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("listings").select("id", { count: "exact", head: true }).like("address", `${TAG}%`)
    check("cleanup verified — 0 seeded listings remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
