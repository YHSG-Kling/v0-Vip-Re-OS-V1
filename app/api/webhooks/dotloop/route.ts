import { type NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { createClient } from "@/lib/supabase/server"
import { logEventAndTrigger } from "@/lib/events"

// ─────────────────────────────────────────────────────────────────────────────
// DOTLOOP WEBHOOK HANDLER
// HMAC-SHA256 signature verified against DOTLOOP_WEBHOOK_SECRET env var.
// Dotloop sends: X-Dotloop-Signature: sha256=<hex>
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies the Dotloop HMAC-SHA256 signature.
 * Header format: X-Dotloop-Signature: sha256=<hex digest>
 */
function verifyDotloopSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.DOTLOOP_WEBHOOK_SECRET
  if (!secret) {
    console.warn("[dotloop-webhook] DOTLOOP_WEBHOOK_SECRET is not set — rejecting request")
    return false
  }

  if (!signatureHeader) return false

  const expectedPrefix = "sha256="
  if (!signatureHeader.startsWith(expectedPrefix)) return false

  const receivedHex = signatureHeader.slice(expectedPrefix.length)
  const computed = createHmac("sha256", secret).update(rawBody, "utf-8").digest("hex")

  try {
    return timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(receivedHex, "hex"))
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  // Read raw body before parsing so the signature can be verified
  const rawBody = await request.text()

  const signatureHeader = request.headers.get("x-dotloop-signature")
  if (!verifyDotloopSignature(rawBody, signatureHeader)) {
    return NextResponse.json({ error: "Invalid or missing webhook signature" }, { status: 401 })
  }

  try {
    const body = JSON.parse(rawBody)
    const supabase = await createClient()

    if (body.event === "document.signed") {
      const { document_id, loop_id } = body.data
      const now = new Date().toISOString()

      // Update document status on client_documents
      const { data: doc, error } = await supabase
        .from("client_documents")
        .update({
          status: "signed",
          signed_at: now,
        })
        .eq("dotloop_document_id", document_id)
        .select()
        .single()

      if (!error && doc) {
        // Check if all documents in the loop are signed
        const { data: allDocs } = await supabase
          .from("client_documents")
          .select("status")
          .eq("dotloop_loop_id", loop_id)

        const allSigned = allDocs?.every((d) => d.status === "signed")

        if (allSigned && doc.transaction_id) {
          // Legacy event
          await logEventAndTrigger({
            event_type: "transaction.documents_complete",
            user_id: doc.contact_id,
            payload: {
              transactionId: doc.transaction_id,
              loopId: loop_id,
            },
            source: "webhook",
            dedupe_key: `docs-complete-${doc.transaction_id}`,
          } as any)

          // Normalized provider event
          await logEventAndTrigger({
            event_type: "provider.signatures.complete",
            user_id: doc.contact_id,
            payload: {
              transactionId: doc.transaction_id,
              external_id: loop_id,
              provider: "dotloop",
            },
            source: "webhook",
            dedupe_key: `provider-sigs-complete-${doc.transaction_id}`,
          } as any)
        }
      }

      // ── Esign completion: offers ──────────────────────────────────────────────
      // If this loop_id matches an offer's esign_provider ref, mark it fully signed
      if (loop_id) {
        const { data: matchedOffer } = await supabase
          .from("offers")
          .select("id, contact_id")
          .eq("esign_provider", loop_id)
          .maybeSingle()

        if (matchedOffer) {
          await supabase
            .from("offers")
            .update({
              esign_status:       "fully_signed",
              esign_completed_at: now,
            })
            .eq("id", matchedOffer.id)

          await logEventAndTrigger({
            brokerage_id: "",
            event_type: "buyer.offer.esign.completed",
            user_id:    matchedOffer.contact_id,
            payload:    { offerId: matchedOffer.id, loop_id, provider: "dotloop" },
            source:     "webhook",
            dedupe_key: `offer-esign-complete-${matchedOffer.id}`,
          } as any)
        }

        // ── Esign completion: listing_agreements ─────────────────────────────
        const { data: matchedAgreement } = await supabase
          .from("listing_agreements")
          .select("id, listing_id")
          .eq("provider_ref", loop_id)
          .maybeSingle()

        if (matchedAgreement) {
          await supabase
            .from("listing_agreements")
            .update({
              esign_status:      "fully_signed",
              fully_executed_at: now,
            })
            .eq("id", matchedAgreement.id)

          // Advance listing to active stage if still in prep
          await supabase
            .from("listings")
            .update({ current_stage: "active", stage_entered_at: now })
            .eq("id", matchedAgreement.listing_id)
            .in("current_stage", ["prep", "pre_listing", "coming_soon"])

          await logEventAndTrigger({
            brokerage_id: "",
            event_type: "listing.agreement.esign.completed",
            user_id:    matchedAgreement.listing_id,
            payload:    { listingId: matchedAgreement.listing_id, agreementId: matchedAgreement.id, loop_id, provider: "dotloop" },
            source:     "webhook",
            dedupe_key: `listing-agreement-esign-complete-${matchedAgreement.id}`,
          } as any)
        }

        // ── Esign completion: voice-cockpit staged artifacts ─────────────────
        // dispatch_transaction_packet bundles a BBA + offer (or either alone)
        // into ONE provider envelope (externalTransactionId === loop_id here).
        // The dispatch handler stamps the same loop_id onto:
        //   - documents.metadata.signature_request_id (the offer / listing-agreement document)
        //   - buyer_broker_agreements.signature_request_id (the BBA row)
        // Without this block the buyer can sign but our state machine never
        // hears about it — voice-cockpit dispatch was end-to-end broken.

        // Documents: flip ANY document whose metadata.signature_request_id matches
        const { data: matchedDocs } = await supabase
          .from("documents")
          .select("id, document_type, contact_id, brokerage_id, metadata")
          .filter("metadata->>signature_request_id", "eq", loop_id)

        for (const docRow of (matchedDocs ?? [])) {
          const existingMeta = (docRow.metadata as Record<string, unknown>) ?? {}
          await supabase
            .from("documents")
            .update({
              status: "signed",
              metadata: {
                ...existingMeta,
                signed_at:        now,
                signed_via:       "dotloop",
                signed_loop_id:   loop_id,
              },
            })
            .eq("id", docRow.id)

          await logEventAndTrigger({
            brokerage_id: docRow.brokerage_id as string,
            event_type:   "voice_cockpit.packet.signed",
            user_id:      (docRow.contact_id as string | null) ?? "",
            payload:      { documentId: docRow.id, documentType: docRow.document_type, loop_id, provider: "dotloop" },
            source:       "webhook",
            dedupe_key:   `voice-packet-signed-${docRow.id}`,
          } as any)
        }

        // BBA: flip the buyer_broker_agreements row to 'active' once signed
        const { data: matchedBBA } = await supabase
          .from("buyer_broker_agreements")
          .select("id, brokerage_id, buyer_contact_id")
          .eq("signature_request_id", loop_id)
          .maybeSingle()

        if (matchedBBA) {
          await supabase
            .from("buyer_broker_agreements")
            .update({
              status:        "active",
              signed_at:     now,
              signed_method: "dotloop",
            })
            .eq("id", matchedBBA.id)

          await logEventAndTrigger({
            brokerage_id: matchedBBA.brokerage_id as string,
            event_type:   "buyer_broker_agreement.signed",
            user_id:      matchedBBA.buyer_contact_id as string,
            payload:      { agreementId: matchedBBA.id, loop_id, provider: "dotloop" },
            source:       "webhook",
            dedupe_key:   `bba-signed-${matchedBBA.id}`,
          } as any)
        }
      }
    }

    if (body.event === "loop.status.updated") {
      const { loop_id, status } = body.data

      await supabase
        .from("transactions")
        .update({ status: mapDotloopStatus(status) })
        .eq("dotloop_loop_id", loop_id)
    }

    return NextResponse.json({ received: true })
  } catch (error: any) {
    console.error("[dotloop-webhook] Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

function mapDotloopStatus(dotloopStatus: string): string {
  const statusMap: Record<string, string> = {
    Active: "under_contract",
    Pending: "pending",
    Closed: "closed",
    Canceled: "cancelled",
  }
  return statusMap[dotloopStatus] || "pending"
}
