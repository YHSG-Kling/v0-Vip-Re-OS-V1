"use server"

/**
 * System 7.1A - Buyer Offer Execution Engine
 * Domain 1: Offer Draft Creation
 * 
 * Creates buyer offer draft with multi-offer governance
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { checkFinancialVerification } from "@/lib/buyer-lifecycle"
import { isValidUUID } from "@/lib/validations"
import { requireActiveBBA } from "@/lib/buyer-broker/gate"

const MAX_PENDING_OFFERS = 3 // Configurable limit

export interface CreateOfferParams {
  /**
   * CRM contact ID of the buyer (contacts.id).
   * Buyers in the platform are ALWAYS modelled as CRM contacts — there is no
   * separate buyer entity. `offers.buyer_id` FKs `contacts.id`. Kept as
   * `buyerId` here for backwards compatibility with existing callers; treat
   * it as a contact_id in all downstream logic.
   */
  buyerId: string
  /** Alias of buyerId for new callers that want unambiguous naming. */
  buyerContactId?: string
  propertyAddress: string
  propertyMlsId?: string
  userId?: string  // ignored — derived from session
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
  // Auth gate — previously trusted params.userId for the agent attribution,
  // letting any caller forge offers under any agent's identity.
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { success: false, error: "Unauthorized", errorCode: "unauthorized" }
  const { data: callerRow } = await authClient
    .from("users")
    .select("brokerage_id")
    .eq("id", authUser.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) {
    return { success: false, error: "Unauthorized", errorCode: "unauthorized" }
  }
  const userId = authUser.id
  const callerBrokerageId = callerRow.brokerage_id

  const buyerContactId = params.buyerContactId ?? params.buyerId
  const { propertyAddress, propertyMlsId, expirationHours = 72 } = params

  if (!isValidUUID(buyerContactId)) {
    return { success: false, error: "Invalid buyer contact ID", errorCode: "invalid_buyer_id" }
  }

  if (!propertyAddress || propertyAddress.trim().length === 0) {
    return { success: false, error: "Property address is required", errorCode: "missing_property_address" }
  }

  const supabase = createServiceClient()

  // Check buyer exists, is active, AND belongs to caller's brokerage
  const { data: buyer, error: buyerError } = await supabase
    .from("contacts")
    .select("id, name, status, brokerage_id")
    .eq("id", buyerContactId)
    .single()

  if (buyer && buyer.brokerage_id !== callerBrokerageId) {
    return { success: false, error: "Forbidden", errorCode: "forbidden" }
  }

  if (buyerError || !buyer) {
    return { success: false, error: "Buyer not found", errorCode: "buyer_not_found" }
  }

  if (buyer.status !== "active") {
    return { success: false, error: "Buyer is not active", errorCode: "buyer_not_active" }
  }

  // Check financial verification
  const financialVerification = await checkFinancialVerification({ contactId: buyerContactId })
  if (!financialVerification.isVerified) {
    return {
      success: false,
      error: "Buyer must be financially verified before creating offers",
      errorCode: "not_financially_verified",
    }
  }

  // NAR 2024 Settlement: signed Buyer Broker Agreement required before
  // drafting an offer. Resolve buyer's agent and gate.
  const { data: buyerAgentRow } = await supabase
    .from("contacts")
    .select("agent_id")
    .eq("id", buyerContactId)
    .maybeSingle()
  if (buyerAgentRow?.agent_id) {
    const bbaGate = await requireActiveBBA({
      buyerContactId: buyerContactId,
      agentId:        buyerAgentRow.agent_id,
    })
    if (!bbaGate.allowed) {
      return {
        success: false,
        error: bbaGate.reason ?? "Active Buyer Broker Agreement required (NAR 2024 settlement)",
        errorCode: "bba_required",
      }
    }
  }

  // Check multi-offer governance
  const { data: pendingOffers, error: countError } = await supabase
    .from("activities")
    .select("id")
    .eq("entity_type", "contact")
    .eq("contact_id", buyerContactId)
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
        .eq("contact_id", buyerContactId)
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

  // Emit buyer.offer.draft.created event — brokerage from session
  const { error: eventError } = await supabase.from("activities").insert({
    brokerage_id: callerBrokerageId,
    agent_id: userId,
    contact_id: buyerContactId,
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
 * Get pending offer count for buyer.
 * @param buyerContactId CRM contact id of the buyer (contacts.id).
 */
export async function getPendingOfferCount(buyerContactId: string): Promise<number> {
  if (!isValidUUID(buyerContactId)) {
    return 0
  }

  const supabase = createServiceClient()

  const { data: offers } = await supabase
    .from("activities")
    .select("id, notes")
    .eq("entity_type", "contact")
    .eq("contact_id", buyerContactId)
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
      .eq("contact_id", buyerContactId)
      .in("activity_type", terminatingEvents)
      .limit(1)
      .maybeSingle()

    if (!terminatingEvent) {
      pendingCount++
    }
  }

  return pendingCount
}
