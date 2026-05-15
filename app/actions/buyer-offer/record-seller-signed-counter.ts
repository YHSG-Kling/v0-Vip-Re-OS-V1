"use server"

/**
 * Record a seller-signed counter offer.
 *
 * Correct counter sequence: the SELLER signs the counter FIRST, then sends it
 * to the buyer's agent. When the buyer signs that counter envelope, the
 * counter is FULLY EXECUTED — no separate "seller signs back" step.
 *
 * This action handles both paths:
 *   - In-house listing (seller in our brokerage):
 *       Seller signs through provider OR seller's agent uploads the
 *       seller-signed PDF. Either way, the seller's signature timestamp +
 *       document URL are recorded BEFORE dispatching the buyer's envelope.
 *   - External listing (FSBO / other brokerage):
 *       The listing agent emails a seller-signed counter PDF back. Buyer's
 *       agent uploads it via this action with the (manually-transcribed for
 *       now; OCR is a follow-on) counter terms.
 *
 * What the action does:
 *   1. Delegates to lib/kernel/offers.ts issueCounterOffer to create the
 *      counter row + back-link to the parent via parent_offer_id (existing
 *      canonical creator).
 *   2. Stamps seller_signed_at + seller_signed_document_url on the new
 *      counter so the webhook can detect "both sides signed" when the
 *      buyer's signature lands later.
 *   3. Marks the parent offer status='countered' (issueCounterOffer
 *      already does this — kept here as defense in depth).
 *   4. Logs activity + notifications: agent (buyer-side) is told a counter
 *      came back and is ready for the buyer to sign.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID }          from "@/lib/validations"
import { notifyComplianceFlag } from "@/lib/notifications/notify-helpers"

export interface RecordSellerSignedCounterParams {
  /** The buyer's original offer (or prior counter) being countered. */
  parentOfferId: string
  /** users.id of the agent recording the counter (typically buyer-side). */
  raiserUserId:  string
  /** Path: 'external' (seller wet-signed PDF arrives by email) or 'in_house'
   *  (seller signed in-house via provider). */
  source:        "in_house" | "external"
  /** Counter terms the agent extracted from the seller's signed counter. */
  terms: {
    counterPrice?:    number
    closingDate?:     string
    contingencies?:   string[]
    possessionTerms?: string
    notes?:           string
  }
  /** Storage URL of the seller-signed counter PDF. Required for 'external'. */
  sellerSignedDocumentUrl?: string
  /** ISO timestamp the seller signed — defaults to now if not provided. */
  sellerSignedAt?: string
}

export interface RecordSellerSignedCounterResult {
  success:        boolean
  counterOfferId?: string
  round?:          number
  notifications_fired?: number
  error?:          string
}

export async function recordSellerSignedCounter(
  params: RecordSellerSignedCounterParams,
): Promise<RecordSellerSignedCounterResult> {
  const { parentOfferId, raiserUserId, source, terms, sellerSignedDocumentUrl, sellerSignedAt } = params

  if (!isValidUUID(parentOfferId) || !isValidUUID(raiserUserId)) {
    return { success: false, error: "Invalid IDs" }
  }
  if (source === "external" && !sellerSignedDocumentUrl) {
    return { success: false, error: "sellerSignedDocumentUrl required for external counters" }
  }

  const supabase = createServiceClient()

  const { data: parentOffer } = await supabase
    .from("offers")
    .select("id, brokerage_id, contact_id, agent_id, listing_id")
    .eq("id", parentOfferId)
    .maybeSingle()
  if (!parentOffer) return { success: false, error: "Parent offer not found" }

  // Resolve assigned agent for the brokerage scope + ownership
  const brokerageId = parentOffer.brokerage_id as string

  // Delegate to the canonical kernel counter creator (creates the new offer
  // row, sets parent_offer_id, increments current_round, marks parent
  // status='countered', emits OFFER_OS_COUNTERED kernel event).
  const { issueCounterOffer } = await import("@/lib/kernel/offers")
  const result = await issueCounterOffer({
    offerId:         parentOfferId,
    agentId:         (parentOffer.agent_id as string) ?? raiserUserId,
    brokerageId,
    counterPrice:    terms.counterPrice,
    closingDate:     terms.closingDate,
    contingencies:   terms.contingencies,
    possessionTerms: terms.possessionTerms,
    notes:           terms.notes,
  })
  if (!result.success || !result.data) {
    return { success: false, error: result.error ?? "Counter creation failed" }
  }
  const { counterId, round } = result.data

  // Stamp the seller-signed fields on the new counter row. The webhook
  // (finalizeMatchingOffer) reads seller_signed_at to detect "both sides
  // signed" the moment the buyer's signature lands.
  const now = sellerSignedAt ?? new Date().toISOString()
  await supabase
    .from("offers")
    .update({
      seller_signed_at:            now,
      seller_signed_document_url:  sellerSignedDocumentUrl ?? null,
      // The counter is now waiting for the buyer's signature. We use
      // 'partially_signed' since the seller's side is done.
      esign_status:                "partially_signed",
    })
    .eq("id", counterId)

  // Activity for the buyer-side agent's queue
  await supabase.from("activities").insert({
    brokerage_id:   brokerageId,
    agent_user_id:  raiserUserId,
    agent_id:       parentOffer.agent_id,
    contact_id:     parentOffer.contact_id,
    entity_type:    "offer",
    activity_type:  source === "external"
                     ? "buyer.offer.counter.external_received"
                     : "buyer.offer.counter.seller_signed",
    title:          `Counter received from seller${source === "external" ? " (external)" : ""}`,
    description:    `Round ${round} counter — seller has signed; awaiting buyer signature.`,
    notes:          JSON.stringify({
      offer_id:       counterId,
      parent_offer_id: parentOfferId,
      source,
      seller_signed_at: now,
      seller_signed_document_url: sellerSignedDocumentUrl ?? null,
    }),
    metadata: {
      offer_id:        counterId,
      parent_offer_id: parentOfferId,
      source,
      round,
      seller_signed_at: now,
    },
    status:    "completed",
    priority:  "high",
  })

  // Notification fan-out (medium severity → in-app bell only; deal is moving,
  // not a compliance issue, so no email/SMS noise).
  const { notified_count } = await notifyComplianceFlag(supabase as any, {
    brokerageId,
    agentUserId:   raiserUserId,
    transactionId: null,
    flag: {
      type:        "buyer.offer.counter.seller_signed",
      severity:    "medium",
      title:       `Seller-signed counter on file — buyer signature needed`,
      body:        `Round ${round} counter has come back from the seller side. Open the offer, review terms, and dispatch to the buyer for signature.`,
      entityType:  "offer",
      entityId:    counterId,
      offerId:     counterId,
    },
  })

  return {
    success: true,
    counterOfferId: counterId,
    round,
    notifications_fired: notified_count,
  }
}
