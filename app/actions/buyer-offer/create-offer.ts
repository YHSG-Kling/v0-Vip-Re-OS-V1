"use server"

/**
 * System 7.1A - Buyer Offer Execution Engine
 * Domain 1: Offer Draft Creation
 * 
 * Creates buyer offer draft with multi-offer governance
 */

import { createServiceClient } from "@/lib/supabase/service"
import { checkFinancialVerification } from "@/lib/buyer-lifecycle"
import { isValidUUID } from "@/lib/validations"

const MAX_PENDING_OFFERS = 3 // Configurable limit

export interface CreateOfferParams {
  buyerId: string
  propertyAddress: string
  propertyMlsId?: string
  userId: string
  expirationHours?: number // Default 72
}

export interface CreateOfferResult {
  success: boolean
  offerId?: string
  error?: string
  errorCode?: string
}

/**
 * Create buyer offer draft
 */
export async function createBuyerOffer(
  params: CreateOfferParams
): Promise<CreateOfferResult> {
  const { buyerId, propertyAddress, propertyMlsId, userId, expirationHours = 72 } = params

  // Validate inputs
  if (!isValidUUID(buyerId)) {
    return { success: false, error: "Invalid buyer ID", errorCode: "invalid_buyer_id" }
  }

  if (!propertyAddress || propertyAddress.trim().length === 0) {
    return { success: false, error: "Property address is required", errorCode: "missing_property_address" }
  }

  const supabase = createServiceClient()

  // Check buyer exists and is active
  const { data: buyer, error: buyerError } = await supabase
    .from("contacts")
    .select("id, name, status")
    .eq("id", buyerId)
    .single()

  if (buyerError || !buyer) {
    return { success: false, error: "Buyer not found", errorCode: "buyer_not_found" }
  }

  if (buyer.status !== "active") {
    return { success: false, error: "Buyer is not active", errorCode: "buyer_not_active" }
  }

  // Check financial verification
  const financialVerification = await checkFinancialVerification({ contactId: buyerId })
  if (!financialVerification.isVerified) {
    return {
      success: false,
      error: "Buyer must be financially verified before creating offers",
      errorCode: "not_financially_verified",
    }
  }

  // Check multi-offer governance
  const { data: pendingOffers, error: countError } = await supabase
    .from("activities")
    .select("id")
    .eq("entity_type", "contact")
    .eq("contact_id", buyerId)
    .eq("activity_type", "buyer.offer.draft.created")
    .order("created_at", { ascending: false })

  if (countError) {
    console.error("[buyer-offer] Error checking pending offers:", countError)
  }

  // Count pending offers (not accepted, rejected, withdrawn, expired, or voided)
  const terminatingEvents = [
    "buyer.offer.accepted",
    "buyer.offer.rejected",
    "buyer.offer.withdrawn",
    "buyer.offer.expired",
    "buyer.offer.voided",
  ]

  let pendingCount = 0
  if (pendingOffers) {
    for (const offer of pendingOffers) {
      // Check if this offer has a terminating event
      const { data: terminatingEvent } = await supabase
        .from("activities")
        .select("id")
        .eq("entity_type", "contact")
        .eq("contact_id", buyerId)
        .in("activity_type", terminatingEvents)
        .limit(1)
        .maybeSingle()

      if (!terminatingEvent) {
        pendingCount++
      }
    }
  }

  if (pendingCount >= MAX_PENDING_OFFERS) {
    return {
      success: false,
      error: `Maximum ${MAX_PENDING_OFFERS} pending offers exceeded`,
      errorCode: "max_pending_offers_exceeded",
    }
  }

  // Calculate expiration date
  const expirationDate = new Date()
  expirationDate.setHours(expirationDate.getHours() + expirationHours)

  // Generate offer ID
  const offerId = crypto.randomUUID()

  // Resolve brokerage_id for the agent
  const { data: agentBrokerage } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", userId)
    .maybeSingle()

  // Emit buyer.offer.draft.created event
  const { error: eventError } = await supabase.from("activities").insert({
    brokerage_id: agentBrokerage?.brokerage_id ?? null,
    agent_id: userId,
    contact_id: buyerId,
    activity_type: "buyer.offer.draft.created",
    title: `Offer draft created: ${propertyAddress}`,
    description: `Offer draft created for ${propertyAddress}`,
    notes: JSON.stringify({
      offer_id: offerId,
      property_address: propertyAddress,
      property_mls_id: propertyMlsId || null,
      buyer_offer_count: pendingCount + 1,
      expiration_date: expirationDate.toISOString(),
      status: "draft",
    }),
    status: "pending",
    entity_type: "contact",
  })

  if (eventError) {
    console.error("[buyer-offer] Error creating offer draft:", eventError)
    return {
      success: false,
      error: "Failed to create offer draft",
      errorCode: "database_error",
    }
  }

  return {
    success: true,
    offerId,
  }
}

/**
 * Get pending offer count for buyer
 */
export async function getPendingOfferCount(buyerId: string): Promise<number> {
  if (!isValidUUID(buyerId)) {
    return 0
  }

  const supabase = createServiceClient()

  const { data: offers } = await supabase
    .from("activities")
    .select("id, notes")
    .eq("entity_type", "contact")
    .eq("contact_id", buyerId)
    .eq("activity_type", "buyer.offer.draft.created")
    .order("created_at", { ascending: false })

  if (!offers) return 0

  const terminatingEvents = [
    "buyer.offer.accepted",
    "buyer.offer.rejected",
    "buyer.offer.withdrawn",
    "buyer.offer.expired",
    "buyer.offer.voided",
  ]

  let pendingCount = 0

  for (const offer of offers) {
    const { data: terminatingEvent } = await supabase
      .from("activities")
      .select("id")
      .eq("entity_type", "contact")
      .eq("contact_id", buyerId)
      .in("activity_type", terminatingEvents)
      .limit(1)
      .maybeSingle()

    if (!terminatingEvent) {
      pendingCount++
    }
  }

  return pendingCount
}
