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
import { OFFER_EVENT }          from "@/lib/buyer-offer/offer-lifecycle"
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
  // CHECKED, not fire-and-forget: supabase-js RESOLVES a rejected update, so an
  // unread { error } here silently drops the record of a LEGALLY EXECUTED seller
  // signature. Without seller_signed_at the webhook's "both sides signed" test
  // (finalizeMatchingOffer) never fires when the buyer signs, so a fully executed
  // counter never converts to a transaction. This is reported, never swallowed.
  const now = sellerSignedAt ?? new Date().toISOString()
  const { error: stampError } = await supabase
    .from("offers")
    .update({
      seller_signed_at:            now,
      seller_signed_document_url:  sellerSignedDocumentUrl ?? null,
      // The counter is now waiting for the buyer's signature. We use
      // 'partially_signed' since the seller's side is done.
      esign_status:                "partially_signed",
    })
    .eq("id", counterId)

  if (stampError) {
    return {
      success: false,
      // The counter row DOES exist — hand its id back so the agent/support can
      // finish the stamp rather than re-issuing a duplicate counter.
      counterOfferId: counterId,
      round,
      error: `Counter ${counterId} (round ${round}) was created, but the seller's signature could not be recorded on it (${stampError.message}). Do NOT send it to the buyer — the executed counter would not be detected. Re-record the seller signature.`,
    }
  }

  // Route the seller-signed PDF through the universal uploader so it lands
  // as a documents row with the classifier kicked off (counter_offer
  // classification + extracted fields like counter_price, signed-by parties).
  if (sellerSignedDocumentUrl) {
    try {
      const { uploadDocument } = await import("@/lib/documents/upload-document")
      await uploadDocument({
        brokerageId,
        storageUrl:   sellerSignedDocumentUrl,
        fileName:     `Counter offer (round ${round}) — seller signed`,
        documentType: "counter_offer",
        contactId:    (parentOffer.contact_id as string | null) ?? null,
        offerId:      counterId,
        metadata: {
          parent_offer_id:   parentOfferId,
          counter_offer_id:  counterId,
          source,
          counter_round:     round,
        },
      })
    } catch (err: any) {
      console.error("[record-seller-signed-counter] upload+scan failed (non-fatal):", err?.message ?? err)
    }
  }

  // Activity for the buyer-side agent's queue.
  // Best-effort BY DESIGN and safe to lose: this is a FEED entry, a duplicate
  // view of state already durable on the counter offer row (seller_signed_at,
  // seller_signed_document_url, esign_status) — and the load-bearing human alert
  // is the notifyComplianceFlag fan-out immediately below, which is checked via
  // its returned notified_count. Losing the feed row degrades the timeline, not
  // the deal. NOT silenced: sentinelWrite ledgers the loss to self_heal_events so
  // a feed that has quietly stopped recording counters shows up in the digest.
  //
  // THE KEY. This row carried the tenant but no `entity_id` — and `entity_id` is
  // NULLABLE, so it inserted fine and was invisible to every keyed reader. The
  // subject of this row is the NEW COUNTER offer (`notes.offer_id` and
  // `metadata.offer_id` already said `counterId`), so that is its entity_id.
  //
  // Its two activity_type values (`buyer.offer.counter.external_received` /
  // `.counter.seller_signed`) are PROVENANCE labels — which door the seller's
  // signature came through — and no reader knows them, so they cannot move the
  // parent's lifecycle on their own. They are kept as the human/audit record and
  // the canonical `buyer.offer.counter.received` is emitted separately below,
  // against the PARENT, which is the offer that has actually been countered.
  const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
  await sentinelWrite(supabase, supabase.from("activities").insert({
    brokerage_id:   brokerageId,
    agent_user_id:  raiserUserId,
    agent_id:       parentOffer.agent_id,
    contact_id:     parentOffer.contact_id,
    entity_type:    "offer",
    entity_id:      counterId,
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
  }), { table: "activities", flow: "record_seller_signed_counter", brokerageId })

  // ── THE PARENT'S LIFECYCLE EVENT ───────────────────────────────────────────
  // A seller-signed counter arriving IS the parent offer being countered, and
  // `buyer.offer.counter.received` is the canonical name for that (it is already
  // in lib/buyer-offer/status-sync.ts's map → offers.status='countered', and in
  // offer-lifecycle.ts's EVENT_TO_STATE → COUNTERED). Nothing in the tree ever
  // emitted it: `issueCounterOffer` moves the parent's `status` COLUMN but
  // writes no activity, so the parent's DERIVED state never left wherever it
  // was, and the expiry sweep kept treating a countered offer as live.
  //
  // Keyed to the PARENT offer — the counter row gets its own provenance row
  // above. CHECKED: this is the row the derivation reads.
  const { error: parentCounterEventError } = await supabase.from("activities").insert({
    brokerage_id:   brokerageId,
    agent_user_id:  raiserUserId,
    agent_id:       parentOffer.agent_id,
    contact_id:     parentOffer.contact_id,
    entity_type:    "offer",
    entity_id:      parentOfferId,
    activity_type:  OFFER_EVENT.COUNTER_RECEIVED,
    title:          `Counter received from seller (round ${round})`,
    description:    `Seller countered offer ${parentOfferId}; counter ${counterId} is on file and awaiting the buyer's signature.`,
    notes:          JSON.stringify({ offer_id: parentOfferId, counter_offer_id: counterId, round, source, seller_signed_at: now }),
    metadata:       { offer_id: parentOfferId, counter_offer_id: counterId, round, source, seller_signed_at: now },
    status:         "completed",
    priority:       "high",
  })
  if (parentCounterEventError) {
    console.error(
      `[record-seller-signed-counter] counter ${counterId} recorded, but the parent offer ${parentOfferId} could not be marked COUNTERED (${parentCounterEventError.message}) — its derived lifecycle state will not reflect this counter.`,
    )
  }

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
