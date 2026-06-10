import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { OffersManagerClient } from "./offers-manager-client"
import MultiOfferMatrixCard from "./components/multi-offer-matrix-card"

export default async function OffersPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: listingId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const [{ data: listing }, { data: agentRow }, { data: offers }] = await Promise.all([
    supabase
      .from("listings")
      .select("id, address, city, state, list_price, status, brokerage_id, agent_id")
      .eq("id", listingId)
      .single(),
    supabase
      .from("users")
      .select("brokerage_id, user_type, platform_role")
      .eq("id", user.id)
      .single(),
    supabase
      .from("offers")
      .select(`
        id, offer_number, offer_price, earnest_money,
        closing_date, financing_type, down_payment_amount, down_payment_percent,
        appraisal_contingency_days, financing_contingency_days, inspection_period_days,
        escalation_clause, escalation_cap, appraisal_gap, closing_cost_contribution,
        due_diligence_fee, possession_terms, contingencies, buyer_notes,
        seller_net_estimate, ai_recommendation, ai_analysis,
        ai_extraction_status, offer_document_url, offer_document_name,
        status, offer_type, parent_offer_id, current_round,
        is_winning_offer, submitted_at, response_deadline,
        seller_viewed_at, contact_id, agent_id, brokerage_id, form_source
      `)
      .eq("listing_id", listingId)
      .order("submitted_at", { ascending: false }),
  ])

  // Resolve buyer agent names — separate query since offers.agent_id has no declared FK to users
  const agentIds = [...new Set((offers ?? []).map((o) => o.agent_id).filter(Boolean))] as string[]
  let agentNameMap: Record<string, string> = {}
  if (agentIds.length > 0) {
    const { data: agentUsers } = await supabase
      .from("users")
      .select("id, full_name")
      .in("id", agentIds)
    if (agentUsers) {
      agentNameMap = Object.fromEntries(agentUsers.map((u) => [u.id, u.full_name ?? "Unknown"]))
    }
  }

  const offersWithAgentNames = (offers ?? []).map((o) => ({
    ...o,
    buyer_agent: o.agent_id ? { full_name: agentNameMap[o.agent_id] ?? null } : null,
  }))

  if (!listing) redirect("/dashboard/listings")

  // Active offers (pending|submitted|countered) drive the multi-offer matrix
  const activeOfferCount = offersWithAgentNames.filter(o =>
    ["pending", "submitted", "countered"].includes(o.status)
  ).length

  return (
    <>
      {/* Multi-offer matrix card — renders only when 2+ active offers exist.
          Server component; runs in parallel with the existing client tree below. */}
      <MultiOfferMatrixCard listingId={listingId} activeOfferCount={activeOfferCount} />

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
