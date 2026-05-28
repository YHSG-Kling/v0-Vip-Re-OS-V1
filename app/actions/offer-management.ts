"use server"

/**
 * app/actions/offer-management.ts
 *
 * Seller-side offer management actions (listing agent POV).
 * All column names match the live `offers` schema exactly:
 *   - contact_id     (not buyer_id)
 *   - offer_price    (not offer_amount)
 *   - responded_at   (not accepted_at / rejected_at)
 *   - notes          (not rejection_reason)
 *   - list_price     on listings (not price)
 *   - seller_contact_id on listings (not seller_id)
 *   - parent_offer_id + offer_type = 'counter' for counter history
 *     (offer_counters table does not exist)
 *   - ai_analysis    jsonb on offers (offer_analysis table does not exist)
 *   - offer_comparison table for multi-offer comparisons
 *
 * For buyer-side offer creation, use app/actions/buyer-offers.ts.
 */

import { createClient }          from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { incrementUsage }        from "@/lib/usage"
import { revalidatePath }        from "next/cache"
import { getDefaultCommissionStructure } from "@/lib/brokerage"
import { calcNetToSeller }       from "@/lib/offers/offer-analyzer"
import { KernelEvent }           from "@/lib/kernel/events"
import { isValidUUID }           from "@/lib/validations"
import { resolveAgentId }        from "@/lib/kernel/agent-identity"

// ─── LOAD OFFERS FOR LISTING ───────────────────────────────────────────────────

export async function getOffersForListing(listingId: string) {
  if (!isValidUUID(listingId)) return { success: false, error: "Invalid listing ID" }
  const supabase = await createClient()

  const { data: offers, error } = await supabase
    .from("offers")
    .select(`
      id, offer_number, offer_price, earnest_money,
      closing_date, financing_type, down_payment_amount, down_payment_percent,
      appraisal_contingency_days, financing_contingency_days, inspection_period_days,
      escalation_clause, escalation_cap, appraisal_gap, closing_cost_contribution,
      due_diligence_fee, possession_terms, contingencies, buyer_notes,
      seller_net_estimate, ai_recommendation, ai_analysis, ai_extraction_status,
      ai_extracted_data, offer_document_url, offer_document_name,
      status, offer_type, parent_offer_id, current_round, is_winning_offer,
      submitted_at, response_deadline, seller_viewed_at,
      responded_at, contact_id, agent_id, brokerage_id
    `)
    .eq("listing_id", listingId)
    .not("status", "in", '("rejected")')
    .order("submitted_at", { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, offers: offers ?? [] }
}

// ─── SUBMIT OFFER (buyer-side) ─────────────────────────────────────────────────
// NOTE: Canonical buyer offer creation uses app/actions/buyer-offers.ts createOffer().
// This function is a lighter convenience wrapper used from legacy listing pages.

export async function submitOffer(offerData: {
  listing_id:            string
  contact_id:            string
  offer_price:           number
  earnest_money:         number
  down_payment_percent:  number
  financing_type:        string
  contingencies:         string[]
  closing_date:          string
  additional_terms?:     any
  transaction_id?:       string
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthenticated" }

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .single()

  const brokerageId = profile?.brokerage_id
  if (!brokerageId) return { success: false, error: "User brokerage not found" }

  // offers.agent_id is an FK to agents.id, not users.id — resolve it.
  const agentId = await resolveAgentId(supabase, user.id)

  const { data: offer, error } = await supabase
    .from("offers")
    .insert({
      listing_id:           offerData.listing_id,
      contact_id:           offerData.contact_id,   // live FK (not buyer_id)
      brokerage_id:         brokerageId,
      agent_id:             agentId,
      offer_price:          offerData.offer_price,   // live column (not offer_amount)
      earnest_money:        offerData.earnest_money,
      down_payment_percent: offerData.down_payment_percent,
      financing_type:       offerData.financing_type,
      contingencies:        offerData.contingencies,
      closing_date:         offerData.closing_date,
      transaction_id:       offerData.transaction_id ?? null,
      status:               "pending",
      submitted_at:         new Date().toISOString(),
      // expires_at does NOT exist in the offers schema — omitted
    })
    .select()
    .single()

  if (error) return { success: false, error: error.message }

  // Notify seller's agent
  const { data: listing } = await supabase
    .from("listings")
    .select("agent_id, seller_contact_id, address, list_price")  // list_price (not price), seller_contact_id (not seller_id)
    .eq("id", offerData.listing_id)
    .single()

  if (listing?.agent_id) {
    const { data: agentRow } = await supabase
      .from("agents").select("brokerage_id").eq("id", listing.agent_id).maybeSingle()

    await supabase.from("activities").insert({
      brokerage_id:  agentRow?.brokerage_id ?? brokerageId,
      agent_id:      listing.agent_id,
      contact_id:    offerData.contact_id,
      activity_type: "offer_received",
      title:         `Offer received: $${offerData.offer_price.toLocaleString()}`,
      description:   `New offer of $${offerData.offer_price.toLocaleString()} received for ${listing.address}`,
      priority:      "high",
      status:        "pending",
      entity_type:   "contact",
    })
  }

  revalidatePath(`/dashboard/listings/${offerData.listing_id}`)
  return { success: true, offer }
}

// ─── AI ANALYZE SINGLE OFFER ──────────────────────────────────────────────────

export async function analyzeOffer(offerId: string, userId: string) {
  if (!isValidUUID(offerId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }
  const supabase = await createClient()

  const { data: offer } = await supabase
    .from("offers")
    .select(`*, listing:listings(id, address, list_price, seller_contact_id), buyer:contacts(id, first_name, last_name)`)
    .eq("id", offerId)
    .single()

  if (!offer) return { success: false, error: "Offer not found" }

  const { data: profile } = await supabase
    .from("users").select("brokerage_id").eq("id", userId).single()

  const brokerageId = profile?.brokerage_id
  if (!brokerageId) return { success: false, error: "User brokerage not found" }

  const commissionStructure = await getDefaultCommissionStructure(brokerageId, userId)
  const totalRate = commissionStructure.agentBuyerSideRate + commissionStructure.agentListingSideRate

  const netToSeller = calcNetToSeller({
    offer_price:              offer.offer_price,
    closing_cost_contribution: offer.closing_cost_contribution ?? null,
    commission_rate:          totalRate,
  })

  await incrementUsage(userId, "llm_calls", 1)

  const listPrice = Number((offer.listing as any)?.list_price ?? 0)

  const { text: analysis } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt: `You are a real estate offer analysis expert. Analyze this offer and provide structured feedback.

Property: ${(offer.listing as any)?.address ?? "Unknown"}
List Price: $${listPrice.toLocaleString()}
Offer Amount: $${Number(offer.offer_price).toLocaleString()}
Earnest Money: $${Number(offer.earnest_money ?? 0).toLocaleString()}
Down Payment: ${offer.down_payment_percent ?? 0}%
Financing: ${offer.financing_type ?? "unknown"}
Contingencies: ${offer.contingencies?.join(", ") || "None"}
Close Date: ${offer.closing_date ?? "TBD"}
Net to Seller: $${netToSeller.toLocaleString()}

Return this exact format:

STRENGTH SCORE: [0-100]

KEY ADVANTAGES:
- [Advantage 1]
- [Advantage 2]

RISK FACTORS:
- [Risk 1]

RECOMMENDATION: [Accept/Counter/Reject]

REASONING: [2-3 sentences]`,
  })

  // Save AI analysis into offers.ai_analysis (jsonb) — offer_analysis table does not exist
  await supabase
    .from("offers")
    .update({
      ai_analysis: {
        analysis_type:     "single",
        ai_recommendation: analysis,
        net_to_seller:     netToSeller,
        strength_score:    extractScore(analysis),
        analyzed_at:       new Date().toISOString(),
        analyzed_by_user:  userId,
      },
      ai_recommendation: analysis.substring(0, 500),
    })
    .eq("id", offerId)

  return {
    success:     true,
    analysis,
    net_sheet:   { net_to_seller: netToSeller, purchase_price: offer.offer_price },
  }
}

// ─── AI COMPARE MULTIPLE OFFERS ───────────────────────────────────────────────

export async function analyzeMultipleOffers(listingId: string, userId: string) {
  if (!isValidUUID(listingId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }
  const supabase = await createClient()

  const { data: offers } = await supabase
    .from("offers")
    .select(`*, buyer:contacts(id, first_name, last_name)`)
    .eq("listing_id", listingId)
    .in("status", ["pending", "countered"])

  if (!offers || offers.length === 0) {
    return { success: false, error: "No offers to compare" }
  }

  const { data: profile } = await supabase
    .from("users").select("brokerage_id").eq("id", userId).single()

  const brokerageId = profile?.brokerage_id
  if (!brokerageId) return { success: false, error: "User brokerage not found" }

  const commissionStructure = await getDefaultCommissionStructure(brokerageId, userId)
  const totalRate = commissionStructure.agentBuyerSideRate + commissionStructure.agentListingSideRate

  const offerComparisons = offers.map((offer) => {
    const net = calcNetToSeller({
      offer_price:              offer.offer_price,
      closing_cost_contribution: offer.closing_cost_contribution ?? null,
      commission_rate:          totalRate,
    })
    return {
      offer_id:             offer.id,
      buyer_name:           `${(offer.buyer as any)?.first_name ?? "Unknown"} ${(offer.buyer as any)?.last_name ?? "Buyer"}`,
      offer_price:          offer.offer_price,
      net_to_seller:        net,
      down_payment_percent: offer.down_payment_percent,
      financing_type:       offer.financing_type,
      contingencies_count:  offer.contingencies?.length ?? 0,
      closing_date:         offer.closing_date,
      days_to_close:        offer.closing_date
        ? Math.floor((new Date(offer.closing_date).getTime() - Date.now()) / 86400000)
        : 0,
    }
  })

  await incrementUsage(userId, "llm_calls", 1)

  const { text: comparison } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt: `Compare these ${offers.length} offers and rank from best to worst.

${offerComparisons.map((o, i) => `
Offer ${i + 1} (${o.buyer_name}):
  Price: $${o.offer_price.toLocaleString()}, Net: $${o.net_to_seller.toLocaleString()}
  Down: ${o.down_payment_percent}%, Financing: ${o.financing_type}
  Contingencies: ${o.contingencies_count}, Days to Close: ${o.days_to_close}
`).join("")}

Provide: 1) RANKED LIST with reasoning 2) COMPARISON MATRIX 3) OVERALL RECOMMENDATION 4) NEGOTIATION STRATEGY`,
  })

  // Save to offer_comparison table (exists in schema)
  const netByOffer: Record<string, number> = {}
  offerComparisons.forEach(o => { netByOffer[o.offer_id] = o.net_to_seller })

  await supabase.from("offer_comparison").insert({
    listing_id:           listingId,
    brokerage_id:         brokerageId,
    agent_id:             userId,
    created_by:           userId,
    offer_ids:            offers.map(o => o.id),
    ai_recommendation:    comparison.substring(0, 500),
    ai_analysis_notes:    comparison,
    net_to_seller_by_offer: netByOffer,
    comparison_matrix:    offerComparisons,
    recommended_offer_id: offerComparisons[0]?.offer_id ?? null,
  })

  return { success: true, comparison, offers: offerComparisons }
}

// ─── NET SHEET ────────────────────────────────────────────────────────────────

export async function calculateNetSheet(params: {
  purchase_price:     number
  earnest_money:      number
  agent_commission:   number   // decimal 0.06 = 6%
  closing_costs:      number   // decimal 0.02 = 2%
  seller_concessions?: number
  loan_payoff?:        number
  property_taxes?:     number
  hoa_dues?:           number
}) {
  const {
    purchase_price,
    earnest_money,
    agent_commission,
    closing_costs,
    seller_concessions  = 0,
    loan_payoff         = 0,
    property_taxes      = 0,
    hoa_dues            = 0,
  } = params

  const commission_amount    = purchase_price * agent_commission
  const closing_costs_amount = purchase_price * closing_costs
  const total_deductions     = commission_amount + closing_costs_amount + seller_concessions + loan_payoff + property_taxes + hoa_dues
  const net_to_seller        = purchase_price - total_deductions

  return {
    purchase_price,
    deductions: {
      agent_commission:   commission_amount,
      closing_costs:      closing_costs_amount,
      seller_concessions,
      loan_payoff,
      property_taxes,
      hoa_dues,
      total:              total_deductions,
    },
    net_to_seller,
    earnest_money,
  }
}

// ─── COUNTEROFFER ─────────────────────────────────────────────────────────────
// Counter history is stored in the offers table itself via:
//   parent_offer_id → links to the original offer
//   offer_type      = 'counter'
//   current_round   increments per round
// The `offer_counters` table does NOT exist in the live schema.

export async function counterOffer(
  offerId: string,
  counterData: {
    counter_price?:   number
    closing_date?:    string
    contingencies?:   string[]
    possession_terms?: string
    notes?:           string
  },
) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthenticated" }

  const { data: offer } = await supabase
    .from("offers")
    .select(`id, offer_price, current_round, listing_id, contact_id, brokerage_id, agent_id,
             listing:listings(address, list_price)`)
    .eq("id", offerId)
    .single()

  if (!offer) return { success: false, error: "Offer not found" }

  const nextRound = (offer.current_round ?? 1) + 1

  // Create counter offer as a new offers row linked via parent_offer_id
  const { data: counter, error } = await supabase
    .from("offers")
    .insert({
      listing_id:      offer.listing_id,
      contact_id:      offer.contact_id,   // live FK (not buyer_id)
      brokerage_id:    offer.brokerage_id,
      agent_id:        await resolveAgentId(supabase, user.id),  // agents.id, not users.id
      parent_offer_id: offerId,
      offer_type:      "counter",
      current_round:   nextRound,
      offer_price:     counterData.counter_price ?? offer.offer_price,
      closing_date:    counterData.closing_date ?? null,
      contingencies:   counterData.contingencies ?? [],
      possession_terms: counterData.possession_terms ?? null,
      notes:           counterData.notes ?? null,
      status:          "pending",
      submitted_at:    new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !counter) return { success: false, error: error?.message ?? "Failed to create counter" }

  // Mark original offer as countered
  await supabase.from("offers").update({ status: "countered" }).eq("id", offerId)

  // Notify buyer agent
  const { data: agentRow } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()

  await supabase.from("activities").insert({
    brokerage_id:  agentRow?.brokerage_id ?? offer.brokerage_id,
    agent_id:      user.id,
    contact_id:    offer.contact_id,
    activity_type: "offer_countered",
    title:         `Counter offer: $${(counterData.counter_price ?? offer.offer_price).toLocaleString()}`,
    description:   counterData.notes ?? `Round ${nextRound} counter offer`,
    priority:      "high",
    status:        "pending",
    entity_type:   "contact",
  })

  revalidatePath(`/dashboard/listings/${offer.listing_id}`)
  return { success: true, counterId: counter.id, round: nextRound }
}

// ─── ACCEPT OFFER ─────────────────────────────────────────────────────────────

/**
 * @deprecated DO NOT USE. Use acceptOffer() from `@/app/actions/seller-offers`
 * (object signature) which is the canonical path:
 *   - Runs the compliance gate (System 7.1B — required by spec)
 *   - Calls createTransactionFromOffer() to populate seller_contact_id +
 *     buyer_contact_id + listing_id + offer_id linkage
 *   - Uses transitionLifecycle() to atomically update listings.lifecycle_stage
 *   - Hard-rolls back the offer status if any step fails
 *
 * This legacy version skips the compliance gate, only updates the transaction
 * if one is already linked (it does NOT create one), and was the source of
 * silent state drift between the offer / listing / transaction / contact
 * tables. No call sites use it (verified via grep).
 */
export async function acceptOffer(offerId: string, agentId: string) {
  const supabase = await createClient()

  const { data: offer } = await supabase
    .from("offers")
    .select(`id, listing_id, contact_id, offer_price, closing_date, transaction_id,
             listing:listings(id, address, agent_id)`)
    .eq("id", offerId)
    .single()

  if (!offer) return { success: false, error: "Offer not found" }

  // responded_at is the live column (not accepted_at)
  await supabase
    .from("offers")
    .update({ status: "accepted", responded_at: new Date().toISOString() })
    .eq("id", offerId)

  // Update transaction if linked
  if (offer.transaction_id) {
    await supabase
      .from("transactions")
      .update({
        status:         "under_contract",
        purchase_price: offer.offer_price,
        contract_date:  new Date().toISOString().split("T")[0],
        close_date:     offer.closing_date ?? null,
      })
      .eq("id", offer.transaction_id)

    const { advanceListingStage } = await import("./listing-lifecycle")
    await advanceListingStage(offer.listing_id, "under_contract", agentId)
  }

  // Reject all other pending offers
  await supabase
    .from("offers")
    .update({ status: "rejected" })
    .eq("listing_id", offer.listing_id)
    .neq("id", offerId)
    .in("status", ["pending", "countered"])

  const listingAddress = (offer.listing as any)?.address ?? offerId
  const buyerAgentId   = (offer.listing as any)?.agent_id

  if (buyerAgentId) {
    const { data: baRow } = await supabase
      .from("users").select("brokerage_id").eq("id", buyerAgentId).maybeSingle()

    await supabase.from("activities").insert({
      brokerage_id:  baRow?.brokerage_id ?? null,
      agent_id:      buyerAgentId,
      contact_id:    offer.contact_id,
      activity_type: "offer_accepted",
      title:         `Offer accepted: ${listingAddress}`,
      description:   `Offer accepted on ${listingAddress}`,
      priority:      "high",
      status:        "completed",
      entity_type:   "contact",
    })
  }

  revalidatePath(`/dashboard/listings/${offer.listing_id}`)
  return { success: true }
}

// ─── REJECT OFFER ─────────────────────────────────────────────────────────────

export async function rejectOffer(offerId: string, reason?: string) {
  const supabase = await createClient()

  const { data: offer } = await supabase
    .from("offers")
    .select("contact_id, listing_id, listing:listings(address, id)")  // contact_id (not buyer_id)
    .eq("id", offerId)
    .single()

  // notes column stores rejection reason (rejection_reason column does not exist)
  await supabase
    .from("offers")
    .update({
      status:       "rejected",
      responded_at: new Date().toISOString(),
      notes:        reason ?? null,
    })
    .eq("id", offerId)

  if (offer?.contact_id) {
    const { data: agRow } = await supabase
      .from("users").select("brokerage_id").eq("id", offer.contact_id).maybeSingle()

    await supabase.from("activities").insert({
      brokerage_id:  agRow?.brokerage_id ?? null,
      contact_id:    offer.contact_id,
      activity_type: "offer_rejected",
      title:         `Offer rejected: ${(offer.listing as any)?.address ?? offerId}`,
      description:   reason || "Offer was not accepted",
      status:        "completed",
      entity_type:   "contact",
    })
  }

  if (offer?.listing_id) {
    revalidatePath(`/dashboard/listings/${offer.listing_id}`)
  }

  return { success: true }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function extractScore(aiResponse: string): number {
  const match = aiResponse.match(/strength score:?\s*(\d+)/i)
  return match ? parseInt(match[1], 10) : 75
}
