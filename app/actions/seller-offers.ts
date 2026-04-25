"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import { analyzeAndCompareOffers, calcNetToSeller } from "@/lib/offers/offer-analyzer"
import { isValidUUID } from "@/lib/validations"
import crypto from "crypto"
import { getDefaultCommissionStructure } from "@/lib/brokerage"
import { incrementUsage } from "@/lib/usage"
import { generateTextRouted as generateText } from "@/lib/ai/models"

// ── LOAD OFFERS FOR LISTING ───────────────────────────────────────────────────
export async function getOffersForListing(listingId: string) {
  const supabase = await createClient()

  const { data: offers, error } = await supabase
    .from("offers")
    .select(`
      id,
      offer_number,
      offer_price,
      earnest_money,
      earnest_money_amount,
      closing_date,
      financing_type,
      down_payment_amount,
      down_payment_percent,
      appraisal_contingency_days,
      financing_contingency_days,
      inspection_period_days,
      escalation_clause,
      escalation_cap,
      appraisal_gap,
      closing_cost_contribution,
      due_diligence_fee,
      possession_terms,
      contingencies,
      buyer_notes,
      seller_net_estimate,
      ai_recommendation,
      ai_analysis,
      ai_extraction_status,
      ai_extracted_data,
      offer_document_url,
      offer_document_name,
      status,
      offer_type,
      parent_offer_id,
      current_round,
      is_winning_offer,
      winning_offer,
      submitted_at,
      response_deadline,
      seller_viewed_at,
      contact_id,
      agent_id,
      brokerage_id
    `)
    .eq("listing_id", listingId)
    .not("status", "in", '("rejected")')
    .order("submitted_at", { ascending: false })

  if (error) return { success: false, error: error.message, offers: [] }
  return { success: true, offers: offers ?? [] }
}

// ── ACCEPT OFFER ──────────────────────────────────────────────────────────────
export async function acceptOffer(params: {
  offerId: string
  listingId: string
  brokerageId: string
  agentUserId: string
}) {
  const supabase = await createClient()
  const { offerId, listingId, brokerageId, agentUserId } = params

  if (!isValidUUID(offerId) || !isValidUUID(listingId)) {
    return { success: false, error: "Invalid ID" }
  }

  // ── COMPLIANCE GATE (System 7.1B — ABSOLUTE) ─────────────────────────────
  // No offer may be accepted without a prior buyer.offer.compliance.passed event.
  const { checkCompliancePassed } = await import("@/lib/buyer-offer/compliance-gate")
  const complianceCheck = await checkCompliancePassed(offerId)
  if (!complianceCheck.passed) {
    return {
      success: false,
      error: `Compliance gate: offer ${offerId} has not passed compliance review. ${complianceCheck.error ?? ""}`.trim(),
    }
  }

  // Mark this offer as winner; set all others to not winning
  const { error: winnerError } = await supabase
    .from("offers")
    .update({
      is_winning_offer: true,
      winning_offer:    true,
      status:           "accepted",
      responded_at:     new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    })
    .eq("id", offerId)

  if (winnerError) return { success: false, error: winnerError.message }

  // Clear winning flag on all other offers for this listing
  await supabase
    .from("offers")
    .update({ is_winning_offer: false, winning_offer: false, updated_at: new Date().toISOString() })
    .eq("listing_id", listingId)
    .neq("id", offerId)

  // lifecycle_events + kernel event
  await supabase.from("lifecycle_events").insert({
    brokerage_id:  brokerageId,
    entity_type:   "offer",
    entity_id:     offerId,
    event_type:    KernelEvent.OFFER_ACCEPTED,
    actor_user_id: agentUserId,
    metadata:      { listing_id: listingId },
  })

  await processKernelEvent({
    event:      KernelEvent.OFFER_ACCEPTED,
    brokerageId,
    entityType: "offer",
    entityId:   offerId,
  }).catch(() => {})

  // transitionLifecycle — listing_stage_machine → UNDER_CONTRACT
  await transitionLifecycle({
    brokerageId,
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "",
    toState:     "UNDER_CONTRACT",
    actorUserId: agentUserId,
    eventType:   "UNDER_CONTRACT",
    metadata:    { winning_offer_id: offerId },
  })

  // ── CREATE TRANSACTION SHELL (HARD-REQUIRED) ─────────────────────────────
  // Accepted offer MUST always produce a transaction record.
  // This is a hard failure: if the transaction cannot be created, the entire
  // accept is rolled back by returning an error (offer status update already
  // happened, so we also revert it before returning).
  const { data: acceptedOffer } = await supabase
    .from("offers")
    .select("offer_price, closing_date, inspection_period_days, financing_contingency_days, appraisal_contingency_days, earnest_money, earnest_money_amount, contact_id")
    .eq("id", offerId)
    .single()

  if (!acceptedOffer) {
    // Revert: clear winning status so offer is not stranded
    await supabase
      .from("offers")
      .update({ is_winning_offer: false, winning_offer: false, status: "submitted", responded_at: null, updated_at: new Date().toISOString() })
      .eq("id", offerId)
    return { success: false, error: "[acceptOffer] Could not load offer data — acceptance rolled back." }
  }

  try {
    const { createTransactionFromOffer } = await import("@/lib/transactions/offer-bridge")
    await createTransactionFromOffer({
      offerId,
      brokerageId,
      contractDate: new Date().toISOString().split("T")[0],
      // Use the already-verified compliance timestamp from the gate above
      compliancePassedAt: complianceCheck.complianceTimestamp ?? new Date().toISOString(),
      contractTerms: {
        closingDate: acceptedOffer.closing_date ?? undefined,
        inspectionDeadline: acceptedOffer.inspection_period_days
          ? new Date(Date.now() + acceptedOffer.inspection_period_days * 86400000).toISOString().split("T")[0]
          : undefined,
        financingDeadline: acceptedOffer.financing_contingency_days
          ? new Date(Date.now() + acceptedOffer.financing_contingency_days * 86400000).toISOString().split("T")[0]
          : undefined,
        appraisalDeadline: acceptedOffer.appraisal_contingency_days
          ? new Date(Date.now() + acceptedOffer.appraisal_contingency_days * 86400000).toISOString().split("T")[0]
          : undefined,
        earnestMoneyDue: acceptedOffer.earnest_money
          ? new Date(Date.now() + 3 * 86400000).toISOString().split("T")[0]
          : undefined,
      },
    })
  } catch (err) {
    // HARD FAIL — revert the offer status so it is not stranded as "accepted"
    // with no corresponding transaction.
    console.error("[acceptOffer] createTransactionFromOffer HARD FAIL — reverting offer:", err)
    await supabase
      .from("offers")
      .update({ is_winning_offer: false, winning_offer: false, status: "submitted", responded_at: null, updated_at: new Date().toISOString() })
      .eq("id", offerId)
    // Also clear winning_offer flag on sibling offers we may have cleared
    await supabase
      .from("offers")
      .update({ is_winning_offer: false, winning_offer: false, updated_at: new Date().toISOString() })
      .eq("listing_id", listingId)
    return {
      success: false,
      error: `[acceptOffer] Transaction creation failed — offer acceptance rolled back. ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  revalidatePath(`/dashboard/listings/${listingId}/offers`)
  revalidatePath(`/dashboard/transactions`)
  return { success: true }
}

// ── SEND COUNTER OFFER ────────────────────────────────────────────────────────
export async function sendCounterOffer(params: {
  parentOfferId: string
  listingId: string
  brokerageId: string
  agentUserId: string
  counterPrice: number
  responseDeadline: string            // ISO string
  notes?: string
  contingencyChanges?: string[]
}) {
  const supabase = await createClient()
  const {
    parentOfferId, listingId, brokerageId, agentUserId,
    counterPrice, responseDeadline, notes, contingencyChanges,
  } = params

  // Fetch parent offer to derive contact + current_round
  const { data: parent } = await supabase
    .from("offers")
    .select("contact_id, current_round, contingencies")
    .eq("id", parentOfferId)
    .single()

  if (!parent) return { success: false, error: "Parent offer not found" }

  const nextRound = (parent.current_round ?? 1) + 1

  const { data: counter, error: insertError } = await supabase
    .from("offers")
    .insert({
      listing_id:        listingId,
      contact_id:        parent.contact_id,
      brokerage_id:      brokerageId,
      agent_id:          agentUserId,
      uploaded_by:       agentUserId,
      offer_price:       counterPrice,
      offer_type:        "counter",
      parent_offer_id:   parentOfferId,
      current_round:     nextRound,
      status:            "submitted",
      response_deadline: responseDeadline,
      notes:             notes ?? null,
      contingencies:     contingencyChanges ?? parent.contingencies,
      ai_extraction_status: "not_applicable",
      submitted_at:      new Date().toISOString(),
      created_at:        new Date().toISOString(),
      updated_at:        new Date().toISOString(),
    })
    .select("id")
    .single()

  if (insertError || !counter) return { success: false, error: insertError?.message ?? "Insert failed" }

  // Mark parent as countered
  await supabase
    .from("offers")
    .update({ status: "countered", updated_at: new Date().toISOString() })
    .eq("id", parentOfferId)

  // lifecycle_events + kernel event
  await supabase.from("lifecycle_events").insert({
    brokerage_id:  brokerageId,
    entity_type:   "offer",
    entity_id:     counter.id,
    event_type:    KernelEvent.OFFER_COUNTER_SENT,
    actor_user_id: agentUserId,
    metadata: {
      listing_id:      listingId,
      parent_offer_id: parentOfferId,
      counter_price:   counterPrice,
      round:           nextRound,
    },
  })

  await processKernelEvent({
    event:      KernelEvent.OFFER_COUNTER_SENT,
    brokerageId,
    entityType: "offer",
    entityId:   counter.id,
  }).catch(() => {})

  revalidatePath(`/dashboard/listings/${listingId}/offers`)
  return { success: true, counterId: counter.id }
}

// ── REJECT OFFER ──────────────────────────────────────────────────────────────
export async function rejectOffer(params: {
  offerId: string
  listingId: string
  brokerageId: string
  agentUserId: string
  reason?: string
}) {
  const supabase = await createClient()
  const { offerId, listingId, brokerageId, agentUserId, reason } = params

  const { error } = await supabase
    .from("offers")
    .update({
      status:       "rejected",
      responded_at: new Date().toISOString(),
      notes:        reason ?? null,
      updated_at:   new Date().toISOString(),
    })
    .eq("id", offerId)

  if (error) return { success: false, error: error.message }

  await supabase.from("lifecycle_events").insert({
    brokerage_id:  brokerageId,
    entity_type:   "offer",
    entity_id:     offerId,
    event_type:    KernelEvent.OFFER_REJECTED,
    actor_user_id: agentUserId,
    metadata:      { listing_id: listingId, reason: reason ?? null },
  })

  await processKernelEvent({
    event:      KernelEvent.OFFER_REJECTED,
    brokerageId,
    entityType: "offer",
    entityId:   offerId,
  }).catch(() => {})

  revalidatePath(`/dashboard/listings/${listingId}/offers`)
  return { success: true }
}

// ── GENERATE SELLER PORTAL LINK ───────────────────────────────────────────────
// Stores a secure token in offers.ai_extracted_data.seller_portal_token (reuses jsonb)
// and returns the shareable URL. Seller views only — no accept/reject actions.
export async function generateSellerPortalLink(params: {
  listingId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId } = params

  const token = crypto.randomBytes(32).toString("hex")
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  // Store token on the listing row (transaction_provider_ref repurposed as portal token)
  // Use a dedicated listings column if available, otherwise store in ai_extracted_data on all offers
  // The live listings schema has no portal_token column — store in listings metadata approach:
  // We write to each active offer's ai_extracted_data merging portal token
  const { data: activeOffers } = await supabase
    .from("offers")
    .select("id, ai_extracted_data")
    .eq("listing_id", listingId)
    .not("status", "in", '("rejected")')

  for (const offer of activeOffers ?? []) {
    const merged = {
      ...(offer.ai_extracted_data ?? {}),
      seller_portal_token: token,
      seller_portal_expires_at: expiresAt,
    }
    await supabase
      .from("offers")
      .update({ ai_extracted_data: merged, updated_at: new Date().toISOString() })
      .eq("id", offer.id)
  }

  const url = `${process.env.NEXT_PUBLIC_APP_URL}/seller/offers/${listingId}?token=${token}`
  return { success: true, url, expires_at: expiresAt }
}

// ── RECORD SELLER VIEW ────────────────────────────────────────────────────────
export async function recordSellerView(listingId: string) {
  const supabase = await createClient()
  const now = new Date().toISOString()

  await supabase
    .from("offers")
    .update({ seller_viewed_at: now, updated_at: now })
    .eq("listing_id", listingId)
    .is("seller_viewed_at", null)

  return { success: true }
}

// ── TRIGGER AI COMPARISON ─────────────────────────────────────────────────────
export async function triggerOfferComparison(params: {
  listingId: string
  brokerageId: string
  agentUserId: string
}) {
  const supabase = await createClient()
  const { listingId, brokerageId, agentUserId } = params

  const { data: listing } = await supabase
    .from("listings")
    .select("list_price")
    .eq("id", listingId)
    .single()

  const { data: agentRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", agentUserId)
    .single()

  const { data: offersRaw } = await supabase
    .from("offers")
    .select(`
      id, offer_number, offer_price, earnest_money, earnest_money_amount,
      closing_date, financing_type, down_payment_amount, down_payment_percent,
      appraisal_contingency_days, financing_contingency_days, inspection_period_days,
      escalation_clause, escalation_cap, appraisal_gap, closing_cost_contribution,
      possession_terms, contingencies, seller_net_estimate
    `)
    .eq("listing_id", listingId)
    .not("status", "in", '("rejected","countered")')

  if (!offersRaw || offersRaw.length < 2) {
    return { success: false, error: "At least 2 active offers are required for AI comparison" }
  }

  const result = await analyzeAndCompareOffers({
    listingId,
    brokerageId,
    agentUserId,
    listPrice: listing?.list_price ?? 0,
    offers: offersRaw as any,
    commissionRate: 0.06,  // default — brokerage-configurable via commission_adjustments
  })

  return result
}

// ── FETCH LINKED TRANSACTION FOR A LISTING ────────────────────────────────────
export async function getTransactionByListingId(listingId: string): Promise<{
  id: string
  property_address: string | null
  contract_price: number | null
  status: string | null
} | null> {
  if (!isValidUUID(listingId)) return null
  const supabase = await createClient()
  const { data } = await supabase
    .from("transactions")
    // contract_price does NOT exist — live column is purchase_price
    .select("id, property_address, purchase_price, status")
    .eq("listing_id", listingId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ? { ...data, contract_price: (data as any).purchase_price } : null
}

// ── FETCH REPAIR NEGOTIATION ITEMS FOR A TRANSACTION ─────────────────────────
// Repair negotiations happen post-acceptance inside transactions, not at the offer stage.
export async function getRepairNegotiationItems(transactionId: string): Promise<{
  success: boolean
  items: {
    id: string
    item_description: string
    estimated_cost: number | null
    actual_cost: number | null
    status: string | null
    priority: string | null
    requested_by: string | null
  }[]
  error?: string
}> {
  if (!isValidUUID(transactionId)) return { success: false, items: [], error: "Invalid transaction ID" }
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_repair_negotiations")
    .select("id, item_description, estimated_cost, actual_cost, status, priority, requested_by")
    .eq("transaction_id", transactionId)
    .order("priority", { ascending: true })
  if (error) return { success: false, items: [], error: error.message }
  return { success: true, items: data ?? [] }
}

// ── LOOKUP MLS NUMBER BY BUYER CONTACT + PROPERTY ADDRESS ─────────────────────
// Buyers don't have listings — their properties are matched via property_alert_results.
export async function getMlsNumberByAddress(contactId: string, propertyAddress: string): Promise<string | null> {
  if (!isValidUUID(contactId) || !propertyAddress) return null
  const supabase = await createClient()
  const { data } = await supabase
    .from("property_alert_results")
    .select("mls_number, list_price")
    .eq("contact_id", contactId)
    .ilike("property_address", `%${propertyAddress.trim()}%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.mls_number ?? null
}

// AI analysis functions — inlined to avoid Turbopack re-export resolution failures

function extractScore(text: string): number {
  const match = text.match(/STRENGTH SCORE:\s*(\d+)/)
  return match ? parseInt(match[1], 10) : 50
}

// ── PRIVATE HELPER: resolve commission rate for a user/brokerage ──────────────
// Shared by analyzeOffer and analyzeMultipleOffers to avoid duplicated logic.
async function resolveCommissionRate(userId: string): Promise<{
  brokerageId: string
  totalRate: number
} | { error: string }> {
  const supabase = await createClient()
  const { data: profile } = await supabase
    .from("users").select("brokerage_id").eq("id", userId).single()

  const brokerageId = profile?.brokerage_id
  if (!brokerageId) return { error: "User brokerage not found" }

  const commissionStructure = await getDefaultCommissionStructure(brokerageId, userId)
  const totalRate = commissionStructure.agentBuyerSideRate + commissionStructure.agentListingSideRate

  return { brokerageId, totalRate }
}

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

  const commissionResult = await resolveCommissionRate(userId)
  if ("error" in commissionResult) return { success: false, error: commissionResult.error }
  const { totalRate } = commissionResult

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
    success:   true,
    analysis,
    net_sheet: { net_to_seller: netToSeller, purchase_price: offer.offer_price },
  }
}

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

  const commissionResult = await resolveCommissionRate(userId)
  if ("error" in commissionResult) return { success: false, error: commissionResult.error }
  const { brokerageId, totalRate } = commissionResult

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

  // Sort descending by net_to_seller so index [0] is always the best offer.
  offerComparisons.sort((a, b) => b.net_to_seller - a.net_to_seller)

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

  const netByOffer: Record<string, number> = {}
  offerComparisons.forEach(o => { netByOffer[o.offer_id] = o.net_to_seller })

  const { data: _compData, error: compInsertError } = await supabase.from("offer_comparison").insert({
    listing_id:              listingId,
    brokerage_id:            brokerageId,
    agent_id:                userId,
    created_by:              userId,
    offer_ids:               offers.map(o => o.id),
    ai_recommendation:       comparison.substring(0, 500),
    ai_analysis_notes:       comparison,
    net_to_seller_by_offer:  netByOffer,
    comparison_matrix:       offerComparisons,
    recommended_offer_id:    offerComparisons[0]?.offer_id ?? null,
  })

  if (compInsertError) {
    return { success: false, error: "Failed to persist comparison: " + compInsertError.message }
  }

  return { success: true, comparison, offers: offerComparisons }
}

export async function calculateNetSheet(params: {
  purchase_price:      number
  earnest_money:       number
  agent_commission:    number
  closing_costs:       number
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
    seller_concessions = 0,
    loan_payoff        = 0,
    property_taxes     = 0,
    hoa_dues           = 0,
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
