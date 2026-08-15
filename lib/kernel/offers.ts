/**
 * lib/kernel/offers.ts
 *
 * Offer OS — canonical kernel commands for the full offer lifecycle.
 *
 * Rules:
 *  - All column names match the live `offers` schema:
 *      contact_id (not buyer_id), offer_price (not offer_amount),
 *      responded_at (not accepted_at), notes (not rejection_reason),
 *      list_price on listings (not price), seller_contact_id on listings (not seller_id),
 *      parent_offer_id + offer_type='counter' for counter history.
 *  - Delegates to existing lib/buyer-offer/ utilities — never duplicates logic.
 *  - Emits KernelEvent.OFFER_OS_* events only (never string literals).
 *  - Never calls AI ISA from here.
 *  - Returns { success: boolean; error?: string; data?: T } — never throws.
 */

import { createClient }          from "@/lib/supabase/server"
import { createServiceClient }   from "@/lib/supabase/service"
import { KernelEvent }           from "@/lib/kernel/events"
import { isValidUUID }           from "@/lib/validations"
import { calcNetToSeller }       from "@/lib/offers/offer-analyzer"
import { getDefaultCommissionStructure } from "@/lib/brokerage"
import { recordOutcomeForOfferSafe } from "@/lib/negotiation/auto-trigger"

// ─── SHARED TYPES ─────────────────────────────────────────────────────────────
// Types live in ./offer-types.ts (no side-effect imports) so client components
// can `import type` them without dragging the AI/server-only chain.

export type { KernelOfferResult, OfferRow } from "./offer-types"
import type { KernelOfferResult, OfferRow } from "./offer-types"

// ─── HELPER: emit lifecycle event + kernel notification ───────────────────────

async function emitOfferEvent(params: {
  event:       KernelEvent
  brokerageId: string
  entityId:    string
  actorUserId: string
  metadata?:   Record<string, unknown>
}): Promise<void> {
  const supabase = createServiceClient()
  const { event, brokerageId, entityId, actorUserId, metadata } = params

  await supabase.from("lifecycle_events").insert({
    brokerage_id:  brokerageId,
    entity_type:   "offer",
    entity_id:     entityId,
    event_type:    event,
    actor_user_id: actorUserId,
    metadata:      metadata ?? {},
  }).throwOnError()

  // Resolve buyer (offer.contact_id) + seller (listing.seller_contact_id) so the
  // canonical fan-out can reach both sides' portals. Only events with a portal
  // template (e.g. OFFER_OS_SUBMITTED) produce a client card; others stay
  // staff-only (fanOutKernelEvent still runs processKernelEvent internally).
  let buyerContactId: string | undefined
  let sellerContactId: string | undefined
  let listingId: string | undefined
  let transactionId: string | undefined
  try {
    const { data: o } = await supabase
      .from("offers")
      .select("contact_id, listing_id, transaction_id")
      .eq("id", entityId)
      .maybeSingle()
    buyerContactId = o?.contact_id ?? undefined
    listingId      = o?.listing_id ?? undefined
    transactionId  = o?.transaction_id ?? undefined
    if (listingId) {
      const { data: l } = await supabase
        .from("listings")
        .select("seller_contact_id")
        .eq("id", listingId)
        .maybeSingle()
      sellerContactId = l?.seller_contact_id ?? undefined
    }
  } catch { /* best-effort enrichment */ }

  const { fanOutKernelEvent } = await import("./event-fanout")
  await fanOutKernelEvent({
    event,
    brokerageId,
    entityType:      "offer",
    entityId,
    contactId:       buyerContactId,
    buyerContactId,
    sellerContactId,
    listingId,
    transactionId,
    agentUserId:     actorUserId,
    metadata,
  }).catch(() => {})
}

// ─── 1. LOAD OFFER WORKSPACE ──────────────────────────────────────────────────
// Returns a single offer with related listing and contact for the detail page.

export async function loadOfferWorkspace(offerId: string): Promise<KernelOfferResult<{
  offer:    OfferRow
  listing:  { id: string; address: string; list_price: number; seller_contact_id: string | null } | null
  contact:  { id: string; first_name: string; last_name: string; email: string | null; phone: string | null } | null
  history:  OfferRow[]
}>> {
  if (!isValidUUID(offerId)) return { success: false, error: "Invalid offer ID" }
  const supabase = await createClient()

  const { data: offer, error } = await supabase
    .from("offers")
    .select("*")
    .eq("id", offerId)
    .single()

  if (error || !offer) return { success: false, error: error?.message ?? "Offer not found" }

  const [listingResult, contactResult, historyResult] = await Promise.all([
    offer.listing_id
      ? supabase.from("listings")
          .select("id, address, list_price, seller_contact_id")
          .eq("id", offer.listing_id)
          .single()
      : Promise.resolve({ data: null, error: null }),

    offer.contact_id
      ? supabase.from("contacts")
          .select("id, first_name, last_name, email, phone")
          .eq("id", offer.contact_id)
          .single()
      : Promise.resolve({ data: null, error: null }),

    // Load counter history: all offers with parent_offer_id = this offer's root
    supabase.from("offers")
      .select("*")
      .or(`parent_offer_id.eq.${offerId},id.eq.${offerId}`)
      .order("current_round", { ascending: true }),
  ])

  return {
    success: true,
    data: {
      offer:   offer as unknown as OfferRow,
      listing: listingResult.data as { id: string; address: string; list_price: number; seller_contact_id: string | null } | null,
      contact: contactResult.data as { id: string; first_name: string; last_name: string; email: string | null; phone: string | null } | null,
      history: (historyResult.data ?? []) as unknown as OfferRow[],
    },
  }
}

// ─── 2. LOAD OFFERS FOR LISTING (seller view) ─────────────────────────────────

export async function loadOffersForListing(listingId: string): Promise<KernelOfferResult<OfferRow[]>> {
  if (!isValidUUID(listingId)) return { success: false, error: "Invalid listing ID" }
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("offers")
    .select("*")
    .eq("listing_id", listingId)
    .not("status", "in", '("rejected","withdrawn")')
    .order("submitted_at", { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, data: (data ?? []) as unknown as OfferRow[] }
}

// ─── 3. LOAD OFFERS FOR BUYER (buyer view) ────────────────────────────────────

export async function loadOffersForBuyer(contactId: string): Promise<KernelOfferResult<OfferRow[]>> {
  if (!isValidUUID(contactId)) return { success: false, error: "Invalid contact ID" }
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("offers")
    .select("*")
    .eq("contact_id", contactId)
    .order("submitted_at", { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, data: (data ?? []) as unknown as OfferRow[] }
}

// ─── 4. RECORD OFFER SUBMITTED ────────────────────────────────────────────────
// Marks an offer as submitted + emits OFFER_OS_SUBMITTED.

export async function recordOfferSubmitted(params: {
  offerId:    string
  agentId:    string
  brokerageId: string
}): Promise<KernelOfferResult<{ offerId: string }>> {
  const { offerId, agentId, brokerageId } = params
  if (!isValidUUID(offerId)) return { success: false, error: "Invalid offer ID" }

  const supabase = await createClient()

  const { error } = await supabase
    .from("offers")
    .update({ status: "submitted", submitted_at: new Date().toISOString() })
    .eq("id", offerId)

  if (error) return { success: false, error: error.message }

  await emitOfferEvent({
    event:       KernelEvent.OFFER_OS_SUBMITTED,
    brokerageId,
    entityId:    offerId,
    actorUserId: agentId,
  }).catch(() => {})

  return { success: true, data: { offerId } }
}

// ─── 5. RECORD AI SINGLE ANALYSIS ────────────────────────────────────────────
// Writes AI analysis into offers.ai_analysis (jsonb). Emits OFFER_OS_AI_ANALYZED.

export async function recordOfferAiAnalysis(params: {
  offerId:         string
  agentId:         string
  brokerageId:     string
  analysis:        string
  strengthScore:   number
  netToSeller:     number
  recommendation:  string
}): Promise<KernelOfferResult<{ offerId: string }>> {
  const { offerId, agentId, brokerageId, analysis, strengthScore, netToSeller, recommendation } = params
  if (!isValidUUID(offerId)) return { success: false, error: "Invalid offer ID" }

  const supabase = await createClient()

  const { error } = await supabase
    .from("offers")
    .update({
      ai_analysis: {
        analysis_type:    "single",
        ai_recommendation: analysis,
        net_to_seller:    netToSeller,
        strength_score:   strengthScore,
        analyzed_at:      new Date().toISOString(),
        analyzed_by_user: agentId,
      },
      ai_recommendation:     recommendation.substring(0, 500),
      seller_net_estimate:   netToSeller,
      ai_extraction_status:  "completed",
    })
    .eq("id", offerId)

  if (error) return { success: false, error: error.message }

  await emitOfferEvent({
    event:       KernelEvent.OFFER_OS_AI_ANALYZED,
    brokerageId,
    entityId:    offerId,
    actorUserId: agentId,
    metadata:    { strength_score: strengthScore, net_to_seller: netToSeller },
  }).catch(() => {})

  return { success: true, data: { offerId } }
}

// ─── 6. COMPARE OFFERS (seller-side AI) ──────────────────────────────────────
// Delegates to offer-analyzer, saves to offer_comparison. Emits OFFER_OS_AI_COMPARED.

export async function compareOffersForListing(params: {
  listingId:    string
  agentId:      string
  brokerageId:  string
}): Promise<KernelOfferResult<{
  comparisonId: string | null
  offerCount:   number
  netByOffer:   Record<string, number>
}>> {
  const { listingId, agentId, brokerageId } = params
  if (!isValidUUID(listingId)) return { success: false, error: "Invalid listing ID" }

  const supabase = await createClient()

  const { data: listing } = await supabase
    .from("listings")
    .select("id, address, list_price")
    .eq("id", listingId)
    .single()

  if (!listing) return { success: false, error: "Listing not found" }

  const { data: offers } = await supabase
    .from("offers")
    .select("*")
    .eq("listing_id", listingId)
    .in("status", ["pending", "countered"])

  if (!offers || offers.length < 2) {
    return { success: false, error: "At least 2 pending offers required for comparison" }
  }

  const commissionStructure = await getDefaultCommissionStructure(brokerageId, agentId)
  const totalRate = commissionStructure.agentBuyerSideRate + commissionStructure.agentListingSideRate

  const netByOffer: Record<string, number> = {}
  const matrix = offers.map(o => {
    const net = calcNetToSeller({
      offer_price: (o as any).offer_price,
      closing_cost_contribution: (o as any).closing_cost_contribution ?? null,
      commission_rate: totalRate,
    })
    netByOffer[o.id] = net
    return {
      offer_id:             o.id,
      offer_price:          (o as any).offer_price,
      net_to_seller:        net,
      financing_type:       (o as any).financing_type,
      down_payment_percent: (o as any).down_payment_percent,
      closing_date:         (o as any).closing_date,
    }
  })

  // Persist comparison record
  const { data: compRow } = await supabase
    .from("offer_comparison")
    .insert({
      listing_id:              listingId,
      brokerage_id:            brokerageId,
      agent_id:                agentId,
      created_by:              agentId,
      offer_ids:               offers.map(o => o.id),
      net_to_seller_by_offer:  netByOffer,
      comparison_matrix:       matrix,
      recommended_offer_id:    matrix.sort((a, b) => b.net_to_seller - a.net_to_seller)[0]?.offer_id ?? null,
    })
    .select("id")
    .single()

  await emitOfferEvent({
    event:       KernelEvent.OFFER_OS_AI_COMPARED,
    brokerageId,
    entityId:    listingId,
    actorUserId: agentId,
    metadata:    { offer_count: offers.length, comparison_id: compRow?.id ?? null },
  }).catch(() => {})

  return {
    success: true,
    data: {
      comparisonId: compRow?.id ?? null,
      offerCount:   offers.length,
      netByOffer,
    },
  }
}

// ─── 7. COUNTER OFFER ────────────────────────────────────────────────────────
// Creates a new offers row with offer_type='counter' + parent_offer_id.
// (offer_counters table does NOT exist — counter history lives in offers table.)

export async function issueCounterOffer(params: {
  offerId:         string
  agentId:         string
  brokerageId:     string
  counterPrice?:   number
  closingDate?:    string
  contingencies?:  string[]
  possessionTerms?: string
  notes?:          string
}): Promise<KernelOfferResult<{ counterId: string; round: number }>> {
  const { offerId, agentId, brokerageId, counterPrice, closingDate, contingencies, possessionTerms, notes } = params
  if (!isValidUUID(offerId)) return { success: false, error: "Invalid offer ID" }

  const supabase = await createClient()

  const { data: offer } = await supabase
    .from("offers")
    .select("id, offer_price, current_round, listing_id, contact_id, brokerage_id")
    .eq("id", offerId)
    .single()

  if (!offer) return { success: false, error: "Offer not found" }

  const nextRound = ((offer as any).current_round ?? 1) + 1

  const { data: counter, error } = await supabase
    .from("offers")
    .insert({
      listing_id:      (offer as any).listing_id,
      contact_id:      (offer as any).contact_id,
      brokerage_id:    brokerageId,
      agent_id:        agentId,
      parent_offer_id: offerId,
      offer_type:      "counter",
      current_round:   nextRound,
      offer_price:     counterPrice ?? (offer as any).offer_price,
      closing_date:    closingDate ?? null,
      contingencies:   contingencies ?? [],
      possession_terms: possessionTerms ?? null,
      notes:           notes ?? null,
      status:          "pending",
      submitted_at:    new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !counter) return { success: false, error: error?.message ?? "Counter creation failed" }

  // The original offer is always the parent root and stays part of the
  // executed contract — we do NOT mark it superseded when a counter is
  // issued. We DO set has_counter=true (the agent-UI checkbox signal that a
  // counter exists) and status='countered' so any "open offers" filter still
  // sees that this offer received a counter.
  await supabase
    .from("offers")
    .update({ status: "countered", has_counter: true })
    .eq("id", offerId)

  await emitOfferEvent({
    event:       KernelEvent.OFFER_OS_COUNTERED,
    brokerageId,
    entityId:    counter.id,
    actorUserId: agentId,
    metadata:    { parent_offer_id: offerId, round: nextRound, counter_price: counterPrice },
  }).catch(() => {})

  return { success: true, data: { counterId: counter.id, round: nextRound } }
}

// ─── 8. RESPOND TO COUNTER (buyer-side) ──────────────────────────────────────
// Buyer accepts or rejects the seller's counter. Delegates to buyer-offer handler.

export async function respondToCounter(params: {
  counterId:   string
  agentId:     string
  brokerageId: string
  response:    "accept" | "reject" | "counter_back"
  counterPrice?: number
  notes?:      string
}): Promise<KernelOfferResult<{ offerId: string }>> {
  const { counterId, agentId, brokerageId, response, counterPrice, notes } = params
  if (!isValidUUID(counterId)) return { success: false, error: "Invalid counter ID" }

  const { respondToCounter: buyerRespondToCounter } = await import("@/app/actions/buyer-offer/respond-to-counter")
  const result = await buyerRespondToCounter({
    offerId:     counterId,
    response,
    userId:      agentId,
    counterTerms: counterPrice ? { counter_price: counterPrice, notes } : undefined,
  })

  if (!result.success) return { success: false, error: result.error }

  await emitOfferEvent({
    event:       KernelEvent.OFFER_OS_COUNTER_RESPONDED,
    brokerageId,
    entityId:    counterId,
    actorUserId: agentId,
    metadata:    { response, counter_price: counterPrice },
  }).catch(() => {})

  // Sprint 8 outcome loop:
  //   accept       → outcome 'accepted'
  //   reject       → outcome 'rejected'
  //   counter_back → chain continues, no outcome yet
  if (response === "accept")      void recordOutcomeForOfferSafe(counterId, "accepted")
  else if (response === "reject") void recordOutcomeForOfferSafe(counterId, "rejected")

  return { success: true, data: { offerId: counterId } }
}

// ─── 9. ACCEPT OFFER ─────────────────────────────────────────────────────────
// Sets status='accepted', responded_at=now(). Emits OFFER_OS_ACCEPTED.
// (accepted_at column does NOT exist — use responded_at)

export async function acceptOffer(params: {
  offerId:     string
  agentId:     string
  brokerageId: string
}): Promise<KernelOfferResult<{ offerId: string }>> {
  const { offerId, agentId, brokerageId } = params
  if (!isValidUUID(offerId)) return { success: false, error: "Invalid offer ID" }

  const supabase = await createClient()

  const { data: offer } = await supabase
    .from("offers")
    .select("id, listing_id, contact_id, offer_price, closing_date, transaction_id")
    .eq("id", offerId)
    .single()

  if (!offer) return { success: false, error: "Offer not found" }

  const { error } = await supabase
    .from("offers")
    .update({ status: "accepted", responded_at: new Date().toISOString() })
    .eq("id", offerId)

  if (error) return { success: false, error: error.message }

  // Reject all other pending/countered offers on same listing
  if ((offer as any).listing_id) {
    await supabase
      .from("offers")
      .update({ status: "rejected" })
      .eq("listing_id", (offer as any).listing_id)
      .neq("id", offerId)
      .in("status", ["pending", "countered"])
  }

  // Update linked transaction if present
  if ((offer as any).transaction_id) {
    await supabase
      .from("transactions")
      .update({
        status:         "under_contract",
        purchase_price: (offer as any).offer_price,
        contract_date:  new Date().toISOString().split("T")[0],
        close_date:     (offer as any).closing_date ?? null,
      })
      .eq("id", (offer as any).transaction_id)
  }

  await emitOfferEvent({
    event:       KernelEvent.OFFER_OS_ACCEPTED,
    brokerageId,
    entityId:    offerId,
    actorUserId: agentId,
    metadata:    { listing_id: (offer as any).listing_id, contact_id: (offer as any).contact_id },
  }).catch(() => {})

  // Sprint 8 — close the negotiation learning loop. Idempotent and
  // failure-isolated; never blocks the offer acceptance.
  void recordOutcomeForOfferSafe(offerId, "accepted")

  return { success: true, data: { offerId } }
}

// ─── 10. REJECT OFFER ────────────────────────────────────────────────────────
// Sets status='rejected', responded_at=now(), notes=reason.
// (rejection_reason column does NOT exist — use notes)

export async function rejectOffer(params: {
  offerId:     string
  agentId:     string
  brokerageId: string
  reason?:     string
}): Promise<KernelOfferResult<{ offerId: string }>> {
  const { offerId, agentId, brokerageId, reason } = params
  if (!isValidUUID(offerId)) return { success: false, error: "Invalid offer ID" }

  const supabase = await createClient()

  const { error } = await supabase
    .from("offers")
    .update({
      status:       "rejected",
      responded_at: new Date().toISOString(),
      notes:        reason ?? null,   // rejection_reason does NOT exist
    })
    .eq("id", offerId)

  if (error) return { success: false, error: error.message }

  await emitOfferEvent({
    event:       KernelEvent.OFFER_OS_REJECTED,
    brokerageId,
    entityId:    offerId,
    actorUserId: agentId,
    metadata:    { reason: reason ?? null },
  }).catch(() => {})

  void recordOutcomeForOfferSafe(offerId, "rejected")

  return { success: true, data: { offerId } }
}

// ─── 11. WITHDRAW OFFER (buyer-side) ─────────────────────────────────────────

export async function withdrawOffer(params: {
  offerId:     string
  agentId:     string
  brokerageId: string
  reason?:     string
}): Promise<KernelOfferResult<{ offerId: string }>> {
  const { offerId, agentId, brokerageId, reason } = params
  if (!isValidUUID(offerId)) return { success: false, error: "Invalid offer ID" }

  const supabase = await createClient()

  const { error } = await supabase
    .from("offers")
    .update({
      status:       "withdrawn",
      responded_at: new Date().toISOString(),
      notes:        reason ?? null,
    })
    .eq("id", offerId)

  if (error) return { success: false, error: error.message }

  await emitOfferEvent({
    event:       KernelEvent.OFFER_OS_WITHDRAWN,
    brokerageId,
    entityId:    offerId,
    actorUserId: agentId,
    metadata:    { reason: reason ?? null },
  }).catch(() => {})

  void recordOutcomeForOfferSafe(offerId, "withdrawn")

  return { success: true, data: { offerId } }
}

// ─── UTILITY: GET COUNTER HISTORY ────────────────────────────────────────────
// Returns the full negotiation chain rooted at a given offer ID (or any offer in the chain).

export async function getOfferNegotiationHistory(offerId: string): Promise<KernelOfferResult<OfferRow[]>> {
  if (!isValidUUID(offerId)) return { success: false, error: "Invalid offer ID" }
  const supabase = await createClient()

  // Fetch the root offer (could be the original or any counter in the chain)
  const { data: root } = await supabase
    .from("offers")
    .select("id, parent_offer_id")
    .eq("id", offerId)
    .single()

  const rootId = (root as any)?.parent_offer_id ?? offerId

  const { data, error } = await supabase
    .from("offers")
    .select("*")
    .or(`id.eq.${rootId},parent_offer_id.eq.${rootId}`)
    .order("current_round", { ascending: true })

  if (error) return { success: false, error: error.message }
  return { success: true, data: (data ?? []) as unknown as OfferRow[] }
}
