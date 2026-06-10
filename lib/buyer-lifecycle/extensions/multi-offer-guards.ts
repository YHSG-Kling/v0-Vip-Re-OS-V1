/**
 * System 5.1D: Buyer Lifecycle Governance Hardening
 * Extension 3: Multi-Offer Lifecycle Guards
 * 
 * Handles multiple offer submissions without corrupting buyer lifecycle.
 * Only accepted offers trigger UNDER_CONTRACT transition.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { getCurrentBuyerState } from "../lifecycle-logger"

export type OfferStatus = "submitted" | "accepted" | "rejected" | "withdrawn" | "expired" | "countered"

export interface OfferLifecycleEvent {
  offerId: string
  contactId: string
  listingId: string
  status: OfferStatus
  occurredAt: Date
}

/**
 * Emit offer lifecycle event
 */
export async function emitOfferLifecycleEvent(params: {
  offerId: string
  contactId: string
  listingId: string
  status: OfferStatus
  userId: string
  metadata?: Record<string, unknown>
}): Promise<{ success: boolean; error?: string; activityId?: string }> {
  const { offerId, contactId, listingId, status, userId, metadata } = params
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("activities")
    .insert({
      activity_type: "buyer.offer.lifecycle",
      entity_type: "contact",
      entity_id: contactId,
      agent_user_id: userId,
      metadata: {
        offer_id: offerId,
        listing_id: listingId,
        offer_status: status,
        ...metadata,
      },
    })
    .select("id")
    .single()

  if (error) {
    console.error("[5.1D] Error emitting offer lifecycle event:", error)
    return { success: false, error: error.message }
  }

  return { success: true, activityId: data?.id }
}

/**
 * Query all offers for a buyer
 */
export async function queryBuyerOffers(
  contactId: string,
  options?: {
    statusFilter?: OfferStatus[]
    limit?: number
  }
): Promise<OfferLifecycleEvent[]> {
  const { statusFilter, limit = 100 } = options || {}
  const supabase = createServiceClient()

  const { data: events, error } = await supabase
    .from("activities")
    .select("created_at, metadata")
    .eq("activity_type", "buyer.offer.lifecycle")
    .eq("entity_type", "contact")
    .eq("entity_id", contactId)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("[5.1D] Error querying buyer offers:", error)
    return []
  }

  if (!events) {
    return []
  }

  let offers = events.map((event) => {
    const metadata = (event.metadata as Record<string, unknown>) || {}
    return {
      offerId: metadata.offer_id as string,
      contactId,
      listingId: metadata.listing_id as string,
      status: metadata.offer_status as OfferStatus,
      occurredAt: new Date(event.created_at),
    }
  })

  // Apply status filter
  if (statusFilter && statusFilter.length > 0) {
    offers = offers.filter((offer) => statusFilter.includes(offer.status))
  }

  return offers
}

/**
 * Check if buyer has any accepted offers
 */
export async function hasAcceptedOffer(contactId: string): Promise<boolean> {
  const acceptedOffers = await queryBuyerOffers(contactId, {
    statusFilter: ["accepted"],
    limit: 1,
  })

  return acceptedOffers.length > 0
}

/**
 * Get active offers (submitted or countered, not terminal)
 */
export async function getActiveOffers(contactId: string): Promise<OfferLifecycleEvent[]> {
  return queryBuyerOffers(contactId, {
    statusFilter: ["submitted", "countered"],
  })
}

/**
 * Validate offer submission (can buyer submit another offer?)
 */
export interface OfferSubmissionValidation {
  allowed: boolean
  reason?: string
  currentOfferCount?: number
  maxOffers?: number
}

export async function validateOfferSubmission(
  contactId: string
): Promise<OfferSubmissionValidation> {
  const currentState = await getCurrentBuyerState(contactId)

  // Must be in OFFER_ELIGIBLE or OFFER_SUBMITTED state
  if (currentState !== "BUYER_OFFER_ELIGIBLE" && currentState !== "BUYER_OFFER_SUBMITTED") {
    return {
      allowed: false,
      reason: `Buyer is not eligible to submit offers (current state: ${currentState})`,
    }
  }

  // If already under contract, cannot submit more offers
  // @ts-ignore - state may have changed between checks
  if (currentState === "BUYER_UNDER_CONTRACT") {
    return {
      allowed: false,
      reason: "Buyer is already under contract",
    }
  }

  // Check if there's an accepted offer
  const hasAccepted = await hasAcceptedOffer(contactId)
  if (hasAccepted) {
    return {
      allowed: false,
      reason: "Buyer has an accepted offer - cannot submit additional offers",
    }
  }

  // Check active offers count (business rule: max 3 active offers)
  const activeOffers = await getActiveOffers(contactId)
  const MAX_ACTIVE_OFFERS = 3

  if (activeOffers.length >= MAX_ACTIVE_OFFERS) {
    return {
      allowed: false,
      reason: `Maximum active offers reached (${MAX_ACTIVE_OFFERS})`,
      currentOfferCount: activeOffers.length,
      maxOffers: MAX_ACTIVE_OFFERS,
    }
  }

  return {
    allowed: true,
    currentOfferCount: activeOffers.length,
    maxOffers: MAX_ACTIVE_OFFERS,
  }
}

/**
 * Determine if buyer should transition to UNDER_CONTRACT
 * Only happens when an offer is ACCEPTED
 */
export interface ContractTransitionEvaluation {
  shouldTransition: boolean
  reason?: string
  acceptedOfferId?: string
  acceptedListingId?: string
}

export async function evaluateContractTransition(
  contactId: string,
  offerId: string,
  offerStatus: OfferStatus
): Promise<ContractTransitionEvaluation> {
  // Only accepted offers trigger transition
  if (offerStatus !== "accepted") {
    return {
      shouldTransition: false,
      reason: `Offer status is "${offerStatus}" - only accepted offers trigger UNDER_CONTRACT transition`,
    }
  }

  // Verify buyer is in correct state
  const currentState = await getCurrentBuyerState(contactId)
  if (currentState !== "BUYER_OFFER_SUBMITTED") {
    return {
      shouldTransition: false,
      reason: `Buyer is not in OFFER_SUBMITTED state (current: ${currentState})`,
    }
  }

  // Get offer details
  const offers = await queryBuyerOffers(contactId, { limit: 100 })
  const acceptedOffer = offers.find((o) => o.offerId === offerId && o.status === "accepted")

  if (!acceptedOffer) {
    return {
      shouldTransition: false,
      reason: "Accepted offer not found in events",
    }
  }

  return {
    shouldTransition: true,
    acceptedOfferId: offerId,
    acceptedListingId: acceptedOffer.listingId,
  }
}

/**
 * Emit offer terminal event (rejected/withdrawn/expired)
 * These do NOT regress buyer state
 */
export async function emitOfferTerminalEvent(params: {
  offerId: string
  contactId: string
  listingId: string
  terminalStatus: "rejected" | "withdrawn" | "expired"
  userId: string
  reason?: string
}): Promise<{ success: boolean; error?: string }> {
  const { offerId, contactId, listingId, terminalStatus, userId, reason } = params
  const supabase = createServiceClient()

  // Agent task (correct location, no changes) — type: buyer.offer.terminal
  const { error } = await supabase.from("activities").insert({
    activity_type: "buyer.offer.terminal",
    entity_type: "contact",
    entity_id: contactId,
    agent_user_id: userId,
    metadata: {
      offer_id: offerId,
      listing_id: listingId,
      terminal_status: terminalStatus,
      reason,
      preserves_buyer_state: true,
    },
  })

  if (error) {
    console.error("[5.1D] Error emitting offer terminal event:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * Get offer statistics for a buyer
 */
export interface OfferStatistics {
  totalOffers: number
  activeOffers: number
  acceptedOffers: number
  rejectedOffers: number
  withdrawnOffers: number
  expiredOffers: number
}

export async function getBuyerOfferStatistics(contactId: string): Promise<OfferStatistics> {
  const allOffers = await queryBuyerOffers(contactId)

  return {
    totalOffers: allOffers.length,
    activeOffers: allOffers.filter((o) => o.status === "submitted" || o.status === "countered").length,
    acceptedOffers: allOffers.filter((o) => o.status === "accepted").length,
    rejectedOffers: allOffers.filter((o) => o.status === "rejected").length,
    withdrawnOffers: allOffers.filter((o) => o.status === "withdrawn").length,
    expiredOffers: allOffers.filter((o) => o.status === "expired").length,
  }
}

/**
 * Batch validate offer submissions for multiple buyers
 */
export async function batchValidateOfferSubmissions(
  contactIds: string[]
): Promise<Map<string, OfferSubmissionValidation>> {
  const results = new Map<string, OfferSubmissionValidation>()

  const promises = contactIds.map(async (contactId) => {
    const validation = await validateOfferSubmission(contactId)
    return { contactId, validation }
  })

  const settled = await Promise.allSettled(promises)

  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      results.set(outcome.value.contactId, outcome.value.validation)
    }
  }

  return results
}
