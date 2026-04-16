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
