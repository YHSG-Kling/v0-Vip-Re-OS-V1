import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { OffersManagerClient } from "./offers-manager-client"
import MultiOfferMatrixCard from "./components/multi-offer-matrix-card"
import { InteractiveNetSheet } from "@/components/features/offers/interactive-net-sheet"
import { defaultSellerCosts, type OfferNetInput } from "@/lib/kernel/offer-net-sheet"
import { deriveNetSheetClosingCostSection } from "@/lib/offers/seller-closing-costs"
import { resolveAgreedCommission } from "@/lib/offers/net-sheet-calc"
import { buildSellerDecisionRoom, type DecisionOffer } from "@/lib/kernel/seller-decision-room"

export default async function OffersPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: listingId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const [{ data: listing }, { data: agentRow }] = await Promise.all([
    supabase
      .from("listings")
      .select("id, address, city, state, list_price, status, brokerage_id, agent_id, hoa_dues, commission_rate")
      .eq("id", listingId)
      .single(),
    supabase
      .from("users")
      .select("brokerage_id, user_type, platform_role")
      .eq("id", user.id)
      .single(),
  ])

  if (!listing) redirect("/dashboard/listings")

  // tenant anchor (scope burn-down): offers are fetched only AFTER the listing
  // (the validated parent) resolves, and are pinned to its brokerage.
  const { data: offers } = await supabase
    .from("offers")
    .select(`
      id, listing_id, contact_id, agent_id, brokerage_id,
      offer_number, offer_price, earnest_money,
      closing_date, financing_type, down_payment_amount, down_payment_percent,
      appraisal_contingency_days, financing_contingency_days, inspection_period_days,
      escalation_clause, escalation_cap, appraisal_gap, closing_cost_contribution,
      due_diligence_fee, possession_terms, contingencies, buyer_notes,
      seller_net_estimate, ai_recommendation, ai_analysis,
      ai_extraction_status, offer_document_url, offer_document_name,
      status, offer_type, parent_offer_id, current_round,
      is_winning_offer, submitted_at, response_deadline,
      seller_viewed_at, form_source
    `)
    .eq("listing_id", listingId)
    .eq("brokerage_id", listing.brokerage_id)
    .order("submitted_at", { ascending: false })

  // Resolve buyer agent names.
  // IDENTITY CLASS: `offers.agent_id` is an **agents.id** (createOffer writes it
  // through resolveAgentId), and identity lives on **users**, reached via
  // agents.user_id. This query used to look the agents ids up in `users` by id
  // — two disjoint uuid spaces — so it matched nothing and EVERY offer rendered
  // its buyer agent as "Unknown". Resolve agents → users, then map back to the
  // agents.id the offer rows actually carry.
  const agentIds = [...new Set((offers ?? []).map((o) => o.agent_id).filter(Boolean))] as string[]
  let agentNameMap: Record<string, string> = {}
  if (agentIds.length > 0) {
    const { data: agentRows } = await supabase
      .from("agents")
      .select("id, user_id")
      .in("id", agentIds)
    const userIds = [...new Set((agentRows ?? []).map((a: any) => a.user_id).filter(Boolean))] as string[]
    if (userIds.length > 0) {
      const { data: agentUsers } = await supabase
        .from("users")
        .select("id, first_name, last_name")
        .in("id", userIds)
      const nameByUserId = Object.fromEntries(
        (agentUsers ?? []).map((u: any) => [u.id, `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Unknown"])
      )
      agentNameMap = Object.fromEntries(
        (agentRows ?? []).map((a: any) => [a.id, nameByUserId[a.user_id] ?? "Unknown"])
      )
    }
  }

  const offersWithAgentNames = (offers ?? []).map((o) => ({
    ...o,
    buyer_agent: o.agent_id ? { full_name: agentNameMap[o.agent_id] ?? null } : null,
  }))

  // Active offers (pending|submitted|countered) drive the multi-offer matrix
  const activeOffers = offersWithAgentNames.filter(o =>
    ["pending", "submitted", "under_review", "countered"].includes(o.status)
  )
  const activeOfferCount = activeOffers.filter(o =>
    ["pending", "submitted", "countered"].includes(o.status)
  ).length

  // Interactive net sheet inputs — REUSES the consolidated net-proceeds engine
  // (lib/kernel/offer-net-sheet). Same math the cron's portal card + agent summary use,
  // so the agent edits assumptions live and sees which offer nets the seller most.
  const netSheetOffers: OfferNetInput[] = activeOffers.map((o, i) => ({
    offerId: o.id,
    buyerName: o.buyer_agent?.full_name ?? `Offer ${String.fromCharCode(65 + i)}`,
    offerPrice: Number(o.offer_price ?? 0),
    financingType: o.financing_type ?? null,
    buyerClosingCredit: o.closing_cost_contribution != null ? Number(o.closing_cost_contribution) : 0,
  }))
  // Agreed commission terms. Scoped to the validated listing's brokerage.
  const { data: agreement } = await supabase
    .from("listing_agreements")
    .select("listing_commission_rate, buyer_commission_rate, total_commission_rate, commission_is_flat_fee, commission_flat_amount, seller_transaction_fee, fully_executed_at")
    .eq("listing_id", listingId)
    .eq("brokerage_id", listing.brokerage_id)
    .order("fully_executed_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  // The seller pays BOTH sides, so a listing-side-only rate understates the
  // commission and overstates the net — on the screen where they pick an offer.
  const agreed = resolveAgreedCommission({
    agreement,
    listingCommissionRatePercent: (listing as any).commission_rate ?? null,
    referencePrice: listing.list_price != null ? Number(listing.list_price) : null,
  })

  const netSheetCosts = defaultSellerCosts({
    listPrice: listing.list_price != null ? Number(listing.list_price) : null,
    commissionRateDecimal: agreed.rate,
    hoaDuesMonthly: (listing as any).hoa_dues != null ? Number((listing as any).hoa_dues) : null,
    transactionFee: (agreement as any)?.seller_transaction_fee ?? null,
  })
  // KEEP-ONE (round 36): the net sheet's closing-cost line derives from the
  // seller closing-cost model when the listing's state is known — the flat
  // "other prorated fees" default becomes the state-convention band midpoint,
  // rendered with its regional provenance label. Still editable live (manual
  // override preserved); unknown state → the flat default stands, unlabeled.
  const closingCostSection = deriveNetSheetClosingCostSection(
    listing.list_price != null ? Number(listing.list_price) : null,
    (listing as any).state ?? null,
  )
  if (closingCostSection) netSheetCosts.otherProratedFees = closingCostSection.midpoint

  // Deterministic seller recommendation, computed from the SAME cost lines the net
  // sheet uses (including the state-derived closing-cost midpoint above). This is the
  // auditable counterpart to the matrix's LLM-written summary: "which offer should I
  // take" is advice with legal weight, so the recommendation itself is rule-based and
  // reproducible. Rendered inside the existing matrix card — not a fourth card.
  const asDays = (d: string | null | undefined): number | null => {
    if (!d) return null
    const ms = new Date(d).getTime() - Date.now()
    return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86_400_000)) : null
  }
  const toList = (c: unknown): string[] =>
    Array.isArray(c) ? c.map(String) : typeof c === "string" && c.trim() ? [c] : []

  const decisionOffers: DecisionOffer[] = activeOffers.map((o, i) => ({
    offerId: o.id,
    buyerName: o.buyer_agent?.full_name ?? `Offer ${String.fromCharCode(65 + i)}`,
    offerPrice: Number(o.offer_price ?? 0),
    financingType: o.financing_type ?? null,
    downPaymentPercent: o.down_payment_percent != null ? Number(o.down_payment_percent) : null,
    contingencies: toList(o.contingencies),
    emd: o.earnest_money != null ? Number(o.earnest_money) : null,
    buyerClosingCredit: o.closing_cost_contribution != null ? Number(o.closing_cost_contribution) : 0,
    closeDateDays: asDays(o.closing_date as string | null),
  }))
  const decision = decisionOffers.length >= 2
    ? buildSellerDecisionRoom(decisionOffers, netSheetCosts)
    : null

  return (
    <>
      {/* Multi-offer matrix card — renders only when 2+ active offers exist.
          Server component; runs in parallel with the existing client tree below. */}
      <MultiOfferMatrixCard listingId={listingId} activeOfferCount={activeOfferCount} decision={decision} />

      {/* Interactive net sheet — side-by-side net proceeds the agent adjusts live with
          the seller (commission/payoff/taxes/HOA/other). Surfaces which offer NETS the
          seller most, not just the highest price. Renders whenever there's an open offer. */}
      {netSheetOffers.length > 0 && (
        <div className="mb-4">
          {/* Commission provenance — same discipline as the CMA net sheet: never
              present a default as the agreed rate. */}
          <div
            className={`flex items-center gap-2 text-xs rounded px-3 py-2 border mb-2 ${
              agreed.isEstimate
                ? "text-amber-800 bg-amber-50 border-amber-200"
                : "text-blue-700 bg-blue-50 border-blue-200"
            }`}
          >
            {agreed.isEstimate ? "⚠ Commission is an estimate — " : "Commission per listing agreement — "}
            {agreed.label}
            {!agreed.isFlatFee && ` (${(agreed.rate * 100).toFixed(2)}% total)`}
          </div>
          <InteractiveNetSheet
            listingAddress={listing.address}
            offers={netSheetOffers}
            initialCosts={netSheetCosts}
            closingCostSection={closingCostSection}
          />
        </div>
      )}

      <OffersManagerClient
        listing={listing}
        initialOffers={offersWithAgentNames}
        currentUserId={user.id}
        brokerageId={agentRow?.brokerage_id ?? listing.brokerage_id ?? ""}
        userRole={agentRow?.user_type ?? agentRow?.platform_role ?? "agent"}
      />
    </>
  )
}
