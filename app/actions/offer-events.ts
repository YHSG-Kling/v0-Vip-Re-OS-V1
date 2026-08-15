"use server"

/**
 * OFFER EVENTS — real-time offer coach hook
 *
 * Called when a new offer or counter-offer is recorded. Triggers AI strategy
 * analysis and notifies the listing agent so the intelligence tab + agent
 * dashboard reflect the new state immediately.
 *
 * Wire callers:
 *   - When agent uploads/extracts an offer (existing offer ingest flow)
 *   - When a counter-offer is recorded (parent_offer_id NOT NULL on offers)
 *   - When eSign callback marks offer as signed by buyer
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
// NOTE: aiOfferStrategyAdvisor + aiCounterOfferStrategy require richer context
// (negotiation round, buyer max budget, market conditions, days on market)
// than this hook receives. Intelligence-tab UI calls them directly with the
// agent's curated inputs. This hook just persists + notifies — fast, cheap.

interface HandleOfferReceivedInput {
  offerId: string
  brokerageId?: string  // ignored — derived from session / offer
}

export async function handleOfferReceived(
  input: HandleOfferReceivedInput
): Promise<{ success: boolean; error?: string }> {
  // Auth gate — was previously trusting caller-supplied brokerageId
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }
  const { data: callerRow } = await authClient
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" }

  const supabase = createServiceClient()

  // 1. Load offer + listing context
  const { data: offer } = await supabase
    .from("offers")
    .select(
      "id, listing_id, parent_offer_id, offer_price, earnest_money, contingencies, " +
        "financing_type, escalation_clause, escalation_cap, appraisal_gap, " +
        "inspection_period_days, closing_date, status, current_round, agent_id, " +
        "listings(agent_id, address, list_price, brokerage_id)"
    )
    .eq("id", input.offerId)
    .maybeSingle()

  if (!offer) return { success: false, error: "Offer not found" }

  const o = offer as unknown as {
    id: string
    listing_id: string | null
    parent_offer_id: string | null
    offer_price: number
    contingencies: string[] | null
    financing_type: string | null
    escalation_clause: boolean | null
    escalation_cap: number | null
    appraisal_gap: number | null
    inspection_period_days: number | null
    closing_date: string | null
    current_round: number | null
    agent_id: string | null
    listings: {
      agent_id: string | null
      address: string | null
      list_price: number | null
      brokerage_id: string | null
    } | null
  }

  if (!o.listings) return { success: false, error: "Listing missing on offer" }

  // Use the listing's actual brokerage_id (not caller-supplied) — guards
  // against a hostile caller passing a different brokerageId.
  if (o.listings.brokerage_id !== callerRow.brokerage_id) {
    return { success: false, error: "Forbidden" }
  }
  const listingBrokerageId = o.listings.brokerage_id

  // 2. Notify the listing agent — AI analysis runs separately when the agent
  //    opens the Intelligence tab (which has the curated context inputs).
  const listingAgentId = o.listings.agent_id ?? o.agent_id
  if (listingAgentId) {
    const { data: agent } = await supabase
      .from("agents")
      .select("user_id")
      .eq("id", listingAgentId)
      .maybeSingle()

    if (agent?.user_id) {
      const isCounter = o.parent_offer_id !== null
      const listPrice = o.listings.list_price ?? o.offer_price
      const pctOfList = listPrice > 0 ? ((o.offer_price / listPrice) * 100).toFixed(0) : null
      const title = isCounter
        ? `Counter-offer received on ${o.listings.address ?? "your listing"}`
        : `New offer received on ${o.listings.address ?? "your listing"}`
      const body = `$${o.offer_price.toLocaleString()}${pctOfList ? ` (${pctOfList}% of list)` : ""}. Open the Intelligence tab to run AI analysis.`
      await supabase.from("notifications").insert({
        user_id: agent.user_id,
        brokerage_id: listingBrokerageId,
        type: isCounter ? "counter_offer_received" : "offer_received",
        title,
        body,
        entity_type: "listing",
        entity_id: o.listing_id,
        priority: "high",
        is_read: false,
        created_at: new Date().toISOString(),
      })
    }
  }

  return { success: true }
}

/**
 * Read offers + AI analysis for the intelligence tab.
 * Wraps the existing offers query with a clean signature for the offers
 * manager UI.
 */
export async function getOfferIntelligence(params: {
  listingId: string
}): Promise<Array<{
  offerId: string
  offerNumber: string | null
  offerPrice: number
  status: string
  parentOfferId: string | null
  currentRound: number | null
  aiRecommendation: string | null
  aiAnalysis: Record<string, unknown> | null
  contingencies: string[] | null
  escalationClause: boolean | null
  escalationCap: number | null
  appraisalGap: number | null
  closingDate: string | null
  submittedAt: string | null
}>> {
  // Auth gate — reads ai_recommendation + ai_analysis (sensitive deal data)
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return []
  const { data: callerRow } = await authClient
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return []

  const supabase = createServiceClient()

  // Verify listing belongs to caller's brokerage
  const { data: listing } = await supabase
    .from("listings")
    .select("brokerage_id")
    .eq("id", params.listingId)
    .maybeSingle()
  if (!listing || listing.brokerage_id !== callerRow.brokerage_id) return []

  const { data } = await supabase
    .from("offers")
    .select(
      "id, offer_number, offer_price, status, parent_offer_id, current_round, " +
        "ai_recommendation, ai_analysis, contingencies, escalation_clause, " +
        "escalation_cap, appraisal_gap, closing_date, submitted_at"
    )
    .eq("listing_id", params.listingId)
    .eq("brokerage_id", callerRow.brokerage_id)
    .order("submitted_at", { ascending: false })

  if (!data) return []
  return (data as unknown as Array<{
    id: string
    offer_number: string | null
    offer_price: number
    status: string
    parent_offer_id: string | null
    current_round: number | null
    ai_recommendation: string | null
    ai_analysis: Record<string, unknown> | null
    contingencies: string[] | null
    escalation_clause: boolean | null
    escalation_cap: number | null
    appraisal_gap: number | null
    closing_date: string | null
    submitted_at: string | null
  }>).map((o) => ({
    offerId: o.id,
    offerNumber: o.offer_number,
    offerPrice: o.offer_price,
    status: o.status,
    parentOfferId: o.parent_offer_id,
    currentRound: o.current_round,
    aiRecommendation: o.ai_recommendation,
    aiAnalysis: o.ai_analysis,
    contingencies: o.contingencies,
    escalationClause: o.escalation_clause,
    escalationCap: o.escalation_cap,
    appraisalGap: o.appraisal_gap,
    closingDate: o.closing_date,
    submittedAt: o.submitted_at,
  }))
}
