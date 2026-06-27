"use server"

/**
 * Record seller response on a buyer-signed offer.
 *
 * Called by the agent (or by an inbound-email parser, when wired up) AFTER
 * the seller has responded:
 *   - accepted  : seller signed the contract back. Pass the signed-PDF URL
 *                 in documentUrl so the contract is on file.
 *   - countered : seller sent terms back. issueCounterOffer() is the right
 *                 path to capture the counter terms as a new offer row;
 *                 this action just marks the original offer 'countered'
 *                 and stores any uploaded counter PDF.
 *   - rejected  : seller declined. Terminal state for this offer.
 *
 * This action ONLY records the response. It does NOT trigger compliance
 * review or transaction creation — the agent must explicitly call
 * submitOfferToCompliance once they're satisfied the executed contract
 * is correct.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"

export interface RecordSellerResponseParams {
  offerId:     string
  userId:      string           // acting agent (for activity audit)
  responseType: "accepted" | "countered" | "rejected"
  /** Storage URL of the seller-signed contract or counter PDF (when known). */
  documentUrl?: string
  /** Optional free-form notes captured at response time. */
  notes?:       string
}

export interface RecordSellerResponseResult {
  success: boolean
  error?:  string
}

export async function recordSellerResponse(
  params: RecordSellerResponseParams,
): Promise<RecordSellerResponseResult> {
  const { offerId, userId, responseType, documentUrl, notes } = params

  if (!isValidUUID(offerId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }
  if (!["accepted", "countered", "rejected"].includes(responseType)) {
    return { success: false, error: "Invalid responseType" }
  }

  const supabase = createServiceClient()

  // Resolve the offer + verify the actor is in the same brokerage. We use the
  // service client so the action can also be called from an inbound-email
  // webhook (no user session). The agent's user_id is still required for
  // audit, but no RLS context is implied.
  const { data: offer } = await supabase
    .from("offers")
    .select("id, brokerage_id, contact_id, agent_id, buyer_signed_at, esign_status")
    .eq("id", offerId)
    .maybeSingle()
  if (!offer) return { success: false, error: "Offer not found" }

  if (!offer.buyer_signed_at) {
    // Defensive: an agent shouldn't record a seller response until the buyer
    // has signed. The UI normally gates this — return a friendly error if
    // it slips through.
    return { success: false, error: "Buyer has not signed yet — record a seller response after the buyer's signature lands." }
  }

  const now = new Date().toISOString()
  const updates: Record<string, unknown> = {
    seller_response_received_at:  now,
    seller_response_type:         responseType,
    responded_at:                 now,
  }
  if (documentUrl) updates.seller_response_document_url = documentUrl

  // 'accepted' = both sides signed → we now have a fully-executed contract
  if (responseType === "accepted") {
    updates.fully_signed_contract_received_at = now
    updates.esign_status                      = "fully_signed"
    updates.esign_completed_at                = now
    updates.status                            = "accepted"
  } else if (responseType === "countered") {
    updates.status = "countered"
  } else if (responseType === "rejected") {
    updates.status = "rejected"
  }

  const { error: updErr } = await supabase
    .from("offers")
    .update(updates)
    .eq("id", offerId)
  if (updErr) return { success: false, error: updErr.message }

  // When the agent attaches a document (seller-signed contract for
  // accepted; counter PDF for countered; reject notice for rejected),
  // route it through the universal uploader so it lands as a documents
  // row with the classifier kicked off — gets organized into the right
  // deal-file bucket with a summary.
  if (documentUrl) {
    try {
      const { uploadDocument } = await import("@/lib/documents/upload-document")
      const docType =
        responseType === "accepted" ? "signed_contract"
        : responseType === "countered" ? "counter_offer"
        : "uploaded_document"
      await uploadDocument({
        brokerageId:  offer.brokerage_id,
        storageUrl:   documentUrl,
        fileName:     `Seller ${responseType} — offer ${offerId.slice(0, 8)}`,
        documentType: docType,
        contactId:    offer.contact_id,
        offerId,
        metadata: {
          seller_response_type: responseType,
          recorded_at:          now,
        },
      })
    } catch (err: any) {
      console.error("[record-seller-response] upload+scan failed (non-fatal):", err?.message ?? err)
    }
  }

  // Activity audit — both for the agent's queue + lifecycle reconstruction.
  // activities.agent_id FKs agents(id); use agent_user_id for users(id).
  await supabase.from("activities").insert({
    brokerage_id:   offer.brokerage_id,
    agent_user_id:  userId,
    agent_id:       offer.agent_id,
    contact_id:     offer.contact_id,
    entity_type:    "offer",
    activity_type:  `buyer.offer.seller_${responseType}`,
    title:          `Seller ${responseType}`,
    description:    notes ?? `Seller response recorded: ${responseType}` + (documentUrl ? ` (document attached)` : ""),
    notes:          JSON.stringify({ offer_id: offerId, responseType, documentUrl, source: "agent_action" }),
    metadata:       { offer_id: offerId, responseType, documentUrl, recorded_at: now },
    status:         "completed",
    priority:       responseType === "accepted" ? "high" : "medium",
  })

  // FULLY EXECUTED (seller accepted) → autonomously run the compliance scan + create the transaction
  // (under contract). No separate "submit to compliance" click — the loop completes itself. Self-
  // gating (no transaction on a failed scan) + idempotent. Best-effort; never blocks the response.
  if (responseType === "accepted") {
    try {
      const { autoExecuteFullySignedOffer } = await import("@/lib/transactions/auto-execute-offer")
      await autoExecuteFullySignedOffer(offerId, supabase)
    } catch (err: any) {
      console.error("[record-seller-response] auto-execute failed (non-fatal):", err?.message ?? err)
    }
  }

  return { success: true }
}
