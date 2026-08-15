/**
 * System 7.1B - Buyer Offer Lifecycle Event Mapping
 * 
 * Canonical event types for offer lifecycle
 * ALL events emitted to activities table ONLY
 */

export const OFFER_LIFECYCLE_EVENTS = {
  // Creation events
  DRAFT_CREATED: "buyer.offer.draft_created",
  PROVIDER_LOOP_CREATED: "buyer.offer.provider_loop_created",
  PREFILL_COMPLETE: "buyer.offer.prefill_complete",
  
  // Submission events
  SUBMITTED_FOR_SIGNATURE: "buyer.offer.submitted_for_signature",
  BUYER_SIGNED: "buyer.offer.buyer_signed",
  SUBMITTED_TO_SELLER: "buyer.offer.submitted_to_seller",
  
  // Response events
  SELLER_ACCEPTED: "buyer.offer.seller_accepted",
  SELLER_REJECTED: "buyer.offer.seller_rejected",
  SELLER_COUNTERED: "buyer.offer.seller_countered",
  
  // Counter-offer events
  COUNTER_RECEIVED: "buyer.offer.counter_received",
  COUNTER_ACCEPTED: "buyer.offer.counter_accepted",
  COUNTER_REJECTED: "buyer.offer.counter_rejected",
  
  // Terminal events
  ACCEPTED_FINAL: "buyer.offer.accepted_final",
  UNDER_CONTRACT: "buyer.under_contract",
  
  // Rollback events
  WITHDRAWN: "buyer.offer.withdrawn",
  VOIDED: "buyer.offer.voided",
  EXPIRED: "buyer.offer.expired",
  ROLLBACK: "buyer.offer.rollback",
  
  // Compliance events
  COMPLIANCE_CHECK: "buyer.offer.compliance_check",
  COMPLIANCE_PASSED: "buyer.offer.compliance.passed",
  COMPLIANCE_FAILED: "buyer.offer.compliance.failed",
  
  // Provider sync events
  PROVIDER_STATUS_SYNCED: "buyer.offer.provider_status_synced",
  PROVIDER_DOCUMENTS_SYNCED: "buyer.offer.provider_documents_synced",
} as const

export type OfferLifecycleEvent = typeof OFFER_LIFECYCLE_EVENTS[keyof typeof OFFER_LIFECYCLE_EVENTS]

/**
 * Event metadata schemas
 */
export interface OfferEventMetadata {
  offer_id: string
  contact_id?: string
  listing_id?: string
  provider?: "dotloop" | "skyslope" | "formsimplicity"
  external_id?: string
  timestamp: string
  [key: string]: any
}

/**
 * State derivation: Infer offer lifecycle state from events
 */
export async function deriveOfferState(
  supabase: any,
  offerId: string
): Promise<"DRAFT" | "PENDING" | "ACCEPTED" | "REJECTED" | "COUNTERED" | "EXPIRED" | "WITHDRAWN"> {
  const { data: events } = await supabase
    .from("activities")
    .select("activity_type, created_at")
    .eq("metadata->>offer_id", offerId)
    .order("created_at", { ascending: false })

  if (!events || events.length === 0) return "DRAFT"

  // Check for terminal states first
  const latestEvent = events[0].activity_type

  if (latestEvent === OFFER_LIFECYCLE_EVENTS.UNDER_CONTRACT) return "ACCEPTED"
  if (latestEvent === OFFER_LIFECYCLE_EVENTS.WITHDRAWN) return "WITHDRAWN"
  if (latestEvent === OFFER_LIFECYCLE_EVENTS.VOIDED) return "WITHDRAWN"
  if (latestEvent === OFFER_LIFECYCLE_EVENTS.EXPIRED) return "EXPIRED"
  if (latestEvent === OFFER_LIFECYCLE_EVENTS.SELLER_REJECTED) return "REJECTED"
  if (latestEvent === OFFER_LIFECYCLE_EVENTS.SELLER_COUNTERED) return "COUNTERED"
  if (latestEvent === OFFER_LIFECYCLE_EVENTS.ACCEPTED_FINAL) return "ACCEPTED"

  // Check if submitted (pending seller response)
  const submitted = events.find((e: { activity_type: string; created_at: string }) =>
    e.activity_type === OFFER_LIFECYCLE_EVENTS.SUBMITTED_TO_SELLER
  )
  if (submitted) return "PENDING"

  return "DRAFT"
}

/**
 * Multi-offer conflict detection
 */
export async function detectConflictingOffers(
  supabase: any,
  contactId: string,
  listingId: string,
  excludeOfferId?: string
): Promise<{ hasConflict: boolean; conflictingOffers: string[] }> {
  const { data: offers } = await supabase
    .from("offers")
    .select("id")
    .eq("contact_id", contactId)
    .eq("listing_id", listingId)
    .neq("id", excludeOfferId || "")

  if (!offers || offers.length === 0) {
    return { hasConflict: false, conflictingOffers: [] }
  }

  // Check if any are in PENDING state
  const conflicting = []
  for (const offer of offers) {
    const state = await deriveOfferState(supabase, offer.id)
    if (state === "PENDING") {
      conflicting.push(offer.id)
    }
  }

  return {
    hasConflict: conflicting.length > 0,
    conflictingOffers: conflicting
  }
}
