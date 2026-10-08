"use server"

/**
 * Record seller response on a buyer-signed offer.
 *
 * Called by a signed-in agent AFTER the seller has responded:
 *   - accepted  : seller signed the contract back. Pass the signed-PDF URL
 *                 in documentUrl, or — when the executed contract was already
 *                 filed through app/api/offers/[offerId]/upload-document — its
 *                 documents.id in documentId, so the contract is on file.
 *   - countered : seller sent terms back. issueCounterOffer() is the right
 *                 path to capture the counter terms as a new offer row;
 *                 this action just marks the original offer 'countered'
 *                 and stores any uploaded counter PDF.
 *   - rejected  : seller declined. Terminal state for this offer.
 *
 * On 'accepted' the offer is fully executed, and the autonomous offer
 * compliance loop runs (lib/transactions/offer-compliance-loop.ts) — unless the
 * caller is the listing-side accept, which converts in the same request
 * (`callerConverts`). Either way the transaction is created only through the
 * bridge's gates.
 *
 * The ONE door for recording an executed contract: the buyer-side agent button
 * (app/components/offer/offer-agent-actions.tsx) and the listing-side accept
 * (app/actions/seller-offers.ts acceptOffer, for an outside buyer's agent's offer
 * on our listing) both come through here. The other writers of
 * fully_signed_contract_received_at are the e-sign completion webhooks
 * (lib/esign-webhooks/finalize-packet.ts, lib/forms/esign-execution-loop.ts) —
 * for paperwork that went out on OUR envelope; this is the door for paper that
 * did not.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { requireCaller } from "@/lib/auth/require-caller"
import { OFFER_EVENT } from "@/lib/buyer-offer/offer-lifecycle"
import {
  attestBuyerSignature,
  buyerSignatureRefusal,
  isOutsideOriginated,
} from "@/lib/buyer-offer/buyer-signature-evidence"

export interface RecordSellerResponseParams {
  offerId:     string
  /**
   * IGNORED — the acting user is the SESSION's (wave 93, lane 93D2). This is a
   * "use server" export, so it is a public HTTP endpoint (CLAUDE.md §4): it used
   * to take this id and the offer on faith, so any caller could record a seller
   * acceptance — and attest a buyer signature, and set off the compliance loop
   * that creates the transaction — on ANY tenant's offer under ANY user's name.
   * Kept on the type so existing callers compile; never read.
   */
  userId?:     string
  responseType: "accepted" | "countered" | "rejected"
  /** Storage URL of the seller-signed contract or counter PDF (when known). */
  documentUrl?: string
  /**
   * documents.id of the executed contract ALREADY FILED against this offer through
   * the offer document door (app/api/offers/[offerId]/upload-document — the signed
   * PDF lands as a documents row linked to the offer and is scanned there). Named
   * instead of `documentUrl` so the paperwork is not filed a second time: its
   * storage URL is recorded as the seller-response document, and the buyer-signature
   * attestation is made against exactly this document. Must be in the offer's
   * brokerage and linked to this offer, or the response is refused.
   */
  documentId?: string
  /**
   * Set ONLY by the listing-side accept (app/actions/seller-offers.ts acceptOffer),
   * which records the executed contract through this door and then creates the
   * transaction ITSELF in the same request, inside its winner/rollback/listing-stage
   * handling. Running the autonomous compliance loop here as well would create the
   * transaction first and the accept would then refuse on "transaction already
   * exists". Skipping the loop skips no gate: the bridge's offer gate and the
   * transaction-creation gate (lib/transactions/transaction-creation-gate.ts) run on
   * every creation regardless of door.
   */
  callerConverts?: boolean
  /** Optional free-form notes captured at response time. */
  notes?:       string
  /**
   * THE INBOUND LANE'S BUYER-SIGNATURE EVIDENCE.
   *
   * An offer written on an OUTSIDE buyer's agent's paperwork was signed on their
   * provider or on paper, so our e-sign webhook — the only writer of
   * `offers.buyer_signed_at` — never fires and the gate below refused it
   * FOREVER. The fix is not to drop the requirement: it is that such an offer has
   * a DIFFERENT, equally valid evidence source, and the person who holds the
   * executed contract states it on the record.
   *
   * Supply this when the buyer signed outside our envelope. It is recorded with
   * the attestor's name and the time, against the executed contract already on
   * file — see lib/buyer-offer/buyer-signature-evidence.ts. Never inferred, and
   * never taken from an AI's reading of a PDF.
   */
  buyerSignature?: {
    /** The date the buyer's signature bears, per the document in hand. */
    signedAt:    string
    /** The attestation, in the attestor's own words. */
    attestation: string
    /** documents.id of the executed contract, when the attestor names one. */
    documentId?: string | null
    /**
     * users.id of the person attesting, when it is not the acting user (a TC
     * recording on the listing agent's behalf must name WHO actually read the
     * contract). Defaults to `userId`.
     */
    attestorUserId?: string
  }
}

export interface RecordSellerResponseResult {
  success: boolean
  error?:  string
  /**
   * Set when the refusal is specifically "nothing has established the buyer's
   * signature, and our webhook never will for this offer". The surface should
   * prompt for `buyerSignature` rather than showing a dead end.
   */
  needs_buyer_signature_attestation?: boolean
}

export async function recordSellerResponse(
  params: RecordSellerResponseParams,
): Promise<RecordSellerResponseResult> {
  const { offerId, responseType, notes, buyerSignature, documentId, callerConverts } = params
  let documentUrl = params.documentUrl

  if (!isValidUUID(offerId)) {
    return { success: false, error: "Invalid IDs" }
  }
  if (!["accepted", "countered", "rejected"].includes(responseType)) {
    return { success: false, error: "Invalid responseType" }
  }
  if (documentId !== undefined && !isValidUUID(documentId)) {
    return { success: false, error: "Invalid document ID" }
  }

  // ── WHO IS CALLING — from the SESSION, never the body (CLAUDE.md §4) ───────
  // Gate first, then the service client. The tenant comparison is against the
  // OFFER's own brokerage_id below.
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.error }
  const userId = caller.userId

  const supabase = createServiceClient()

  // Resolve the offer + verify it is in the CALLER's brokerage (the session gate
  // above). The comment that stood here said "verify the actor is in the same
  // brokerage" while nothing did — and a session-less inbound-email caller was
  // never wired (no caller in the tree but the agent button). A webhook that
  // needs this door must resolve its own tenant and call a server-only core, not
  // this public endpoint (lane 93D2).
  // `error` is destructured: supabase-js RESOLVES a refused read, so `const
  // { data }` alone renders "the query was refused" and "there is no such offer"
  // identically — and a refused read here would send the caller down the
  // buyer-has-not-signed branch on an offer whose buyer HAS signed.
  const { data: offer, error: offerReadError } = await supabase
    .from("offers")
    // form_source / provider_envelope_id / offer_document_url are read for the
    // origin question below (was this paperwork ours?), not for the update.
    .select("id, brokerage_id, contact_id, agent_id, buyer_signed_at, esign_status, form_source, provider_envelope_id, offer_document_url")
    .eq("id", offerId)
    .maybeSingle()
  if (offerReadError) return { success: false, error: `Could not read the offer: ${offerReadError.message}` }
  // Another tenant's offer reads exactly like a missing one — nothing about it is
  // confirmed to the caller (lane 93D2).
  if (!offer || offer.brokerage_id !== caller.brokerageId) return { success: false, error: "Offer not found" }

  // ── THE EXECUTED CONTRACT ALREADY FILED THROUGH THE OFFER DOCUMENT DOOR ────
  // Resolved inside the offer's tenant and against THIS offer's link, read with
  // its error (§3). Its storage URL becomes the seller-response document; it is
  // NOT filed again below (the door already filed and scanned it).
  if (documentId) {
    const { data: filed, error: filedErr } = await supabase
      .from("documents")
      .select("id, storage_url, metadata")
      .eq("id", documentId)
      .eq("brokerage_id", offer.brokerage_id as string)
      .maybeSingle()
    if (filedErr) return { success: false, error: `Could not read the executed contract: ${filedErr.message}` }
    if (!filed) return { success: false, error: "The named executed contract is not in this brokerage's deal file." }
    const linkedOffer = ((filed.metadata as Record<string, unknown> | null) ?? {}).linked_offer_id
    if (linkedOffer !== offerId) {
      return { success: false, error: "The named document is not filed against this offer — upload the executed contract to this offer first." }
    }
    if (!filed.storage_url) return { success: false, error: "The named executed contract has no stored file." }
    documentUrl = filed.storage_url as string
  }

  // ── THE BUYER'S SIGNATURE — established, never assumed ────────────────────
  //
  // This gate is UNCHANGED in what it requires: no seller response is recorded
  // against an offer whose buyer signature is not established. "Both sides
  // signed" is settled law here.
  //
  // What changed is that there is now more than one way to ESTABLISH it. Until
  // this wave, `offers.buyer_signed_at` had exactly one writer — the webhook for
  // OUR OWN e-sign envelopes (lib/esign-webhooks/finalize-packet.ts). An offer
  // that arrived from an outside buyer's agent on an in-house listing was signed
  // on THEIR paperwork, so the webhook never fired, the column stayed NULL
  // forever, and this line refused that deal PERMANENTLY: the seller could never
  // accept it and it could never reach compliance.
  //
  // The other admissible evidence is a NAMED HUMAN attesting to the executed
  // contract already on file — recorded with who, when, which document, and the
  // date the signature bears. Never an AI's reading of the PDF; see the evidence
  // module's header for why.
  let buyerSignedAt = offer.buyer_signed_at as string | null
  if (!buyerSignedAt && buyerSignature) {
    const attested = await attestBuyerSignature({
      offerId,
      // The attestor is WHO READ THE CONTRACT — not necessarily the acting user.
      // users-class on both sides; never crossed with agents.id.
      attestorUserId: buyerSignature.attestorUserId ?? userId,
      signedAt:       buyerSignature.signedAt,
      attestation:    buyerSignature.attestation,
      // The executed contract this response names (lane 93D2) is the one attested to.
      documentId:     buyerSignature.documentId ?? documentId ?? null,
      client:         supabase,
    })
    if (!attested.success) {
      return { success: false, error: `The buyer-signature attestation was refused, so the seller response was NOT recorded: ${attested.error}` }
    }
    buyerSignedAt = attested.evidence?.signed_at ?? null
  }

  if (!buyerSignedAt) {
    // Actionable, not a dead end. For an offer whose paperwork was never ours,
    // "wait for the buyer's signature to land" is advice that can never come
    // true — the wording now names the evidence that CAN establish it.
    return {
      success: false,
      error: buyerSignatureRefusal(offer as any),
      needs_buyer_signature_attestation: isOutsideOriginated(offer as any),
    }
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
  // A contract named by documentId was ALREADY filed (and scanned) by the offer
  // document door — filing its URL again would put the same paper in the deal
  // file twice (lane 93D2).
  if (documentUrl && !documentId) {
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
  //
  // ── THE ONE SELLER-RESPONSE WRITER WITH A BUTTON IN FRONT OF IT ────────────
  // This action is what app/components/offer/offer-agent-actions.tsx:100 calls
  // (rendered by app/crm/contacts/[contactId]/offers/[offerId]/offer-actions-bar.tsx).
  // It used to write `entity_type:'offer'` with NO `entity_id`, under
  // `buyer.offer.seller_accepted | seller_rejected | seller_countered` — names
  // that appear in NO reader's vocabulary anywhere in the tree. So a seller
  // acceptance recorded through the UI reached neither
  // track-offer-lifecycle.ts:getOfferLifecycleState, nor
  // lib/buyer-offer/status-sync.ts:syncOfferStatus, nor the expiry sweep, nor
  // offer-lifecycle.ts:deriveOfferStateFromActivities: `is_terminal` stayed
  // false forever and the derived state never left DRAFT.
  //
  // Two things fixed, and only two:
  //   · the KEY — `entity_id` is the offer's id, which is what every reader
  //     joins on alongside `entity_type='offer'`.
  //   · the VOCABULARY — the canonical constant from
  //     lib/buyer-offer/offer-lifecycle.ts. Never a string literal: two writers
  //     of one event spelling it differently is the entire defect class.
  //
  // The human-readable prose is DELIBERATELY unchanged. "Seller accepted" is
  // what the agent's feed should say; it is the `activity_type` — the machine
  // vocabulary — that had to become canonical, not the title.
  //
  // activities.agent_id FKs agents(id); use agent_user_id for users(id).
  const RESPONSE_EVENT = {
    accepted:  OFFER_EVENT.ACCEPTED,
    rejected:  OFFER_EVENT.REJECTED,
    countered: OFFER_EVENT.COUNTERED,
  } as const

  // CHECKED, not fire-and-forget: this row is the ONLY record of the seller's
  // response the lifecycle can read. supabase-js RESOLVES a rejected insert, so
  // an unread { error } here is exactly how a seller acceptance can vanish while
  // the action reports success.
  const { error: lifecycleEventError } = await supabase.from("activities").insert({
    brokerage_id:   offer.brokerage_id,
    agent_user_id:  userId,
    agent_id:       offer.agent_id,
    contact_id:     offer.contact_id,
    entity_type:    "offer",
    entity_id:      offerId,
    activity_type:  RESPONSE_EVENT[responseType],
    title:          `Seller ${responseType}`,
    description:    notes ?? `Seller response recorded: ${responseType}` + (documentUrl ? ` (document attached)` : ""),
    notes:          JSON.stringify({ offer_id: offerId, responseType, documentUrl, source: "agent_action" }),
    metadata:       { offer_id: offerId, responseType, documentUrl, recorded_at: now },
    status:         "completed",
    priority:       responseType === "accepted" ? "high" : "medium",
  })

  if (lifecycleEventError) {
    // The offers row IS already updated — say so, so the agent doesn't re-record
    // and double-stamp — but this is a failure, because without this row the
    // offer's derived state never moves and (for 'accepted') the auto-execute
    // chain below has nothing to stand on.
    return {
      success: false,
      error: `The seller response was saved on the offer, but its lifecycle event could not be recorded (${lifecycleEventError.message}). The offer's derived state will not move and it will not convert — resolve this before continuing.`,
    }
  }

  // FULLY EXECUTED (seller accepted) → autonomously run the compliance scan + create the transaction
  // (under contract). No separate "submit to compliance" click — the loop completes itself. Self-
  // gating (no transaction on a failed scan) + idempotent. Best-effort; never blocks the response.
  // Entered through the offer compliance LOOP (lib/transactions/offer-compliance-loop.ts)
  // so this door records its verdict on offers.metadata.compliance_gate like every other
  // door; the loop calls the same autoExecuteFullySignedOffer this used to call directly.
  if (responseType === "accepted" && !callerConverts) {
    try {
      const { runOfferComplianceLoop } = await import("@/lib/transactions/offer-compliance-loop")
      await runOfferComplianceLoop(supabase as any, {
        brokerageId: offer.brokerage_id as string,
        offerId,
        trigger:     "agreement_executed",
        actorUserId: userId,
      })
    } catch (err: any) {
      console.error("[record-seller-response] auto-execute failed (non-fatal):", err?.message ?? err)
    }
  }

  return { success: true }
}
