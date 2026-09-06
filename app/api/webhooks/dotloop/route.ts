import { type NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { logEventAndTrigger } from "@/lib/events"
import { finalizeVoiceCockpitPacket } from "@/lib/esign-webhooks/finalize-packet"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { OFFER_AUDIT_EVENT } from "@/lib/buyer-offer/offer-lifecycle"

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
    // Use service client — no user session in webhook; RLS would block writes
    // to client_documents without current_user_brokerage_id.
    const supabase = createServiceClient()

    // SCHEMA ADAPTATION: dotloop's event + refs normalize through the declared
    // contract; an event we can't read QUARANTINES instead of being dropped.
    const { adaptPayload, DOTLOOP_EVENT_CONTRACT } = await import("@/lib/kernel/schema-adaptation")
    const { rememberShape } = await import("@/lib/kernel/schema-memory")
    await rememberShape(supabase as any, { connector: "dotloop", entity: "loop_event", raw: body })
    const adapted = adaptPayload(DOTLOOP_EVENT_CONTRACT, body)
    if (!adapted.ok) {
      const { quarantineDriftedPayload } = await import("@/lib/kernel/ingress-continuity")
      const q = await quarantineDriftedPayload(supabase as any, { connector: "dotloop", source: "dotloop_event", raw: body, missing: adapted.missingRequired, eventType: null })
      return NextResponse.json({ received: true, quarantined: true, ref: q.ref })
    }
    const loopEvent = String(adapted.canonical.event ?? "")
    const canonLoopId = (adapted.canonical.loop_id as string | null) ?? null
    const canonDocumentId = (adapted.canonical.document_id as string | null) ?? null
    const canonStatus = (adapted.canonical.status as string | null) ?? null
    if (adapted.driftRepairs > 0) {
      const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
      await recordSelfHeal(supabase as any, {
        brokerageId: null, domain: "data_flow", subject: `dotloop:${canonLoopId ?? canonDocumentId ?? "event"}`, action: "adapt_payload", outcome: "healed",
        detail: { flow: "schema_drift", connector: "dotloop", repairs: adapted.repairs.filter((r) => r.kind !== "direct").slice(0, 12) },
      })
    }

    if (loopEvent === "document.signed") {
      // A signed-doc event without its refs is unreadable — quarantine, never guess.
      if (!canonDocumentId || !canonLoopId) {
        const { quarantineDriftedPayload } = await import("@/lib/kernel/ingress-continuity")
        const q = await quarantineDriftedPayload(supabase as any, { connector: "dotloop", source: "dotloop_event", raw: body, missing: [!canonDocumentId ? "document_id" : "", !canonLoopId ? "loop_id" : ""].filter(Boolean), eventType: loopEvent })
        return NextResponse.json({ received: true, quarantined: true, ref: q.ref })
      }
      const document_id = canonDocumentId
      const loop_id = canonLoopId
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
        // Complete the signature packet keyed to THIS client_documents row —
        // the portal Sign button gates on it (owner rule: gone the moment ink lands).
        await supabase
          .from("signature_requests")
          .update({ request_status: "completed", completed_at: now })
          .eq("document_id", doc.id)
          .is("completed_at", null)
          .then(() => {}, () => {})

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
            event_type: OFFER_AUDIT_EVENT.ESIGN_COMPLETED,
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

          // Listing agreement signed → the listing becomes "coming soon"
          // (pre-listing). Run the stage change through the KERNEL (service
          // client, since a webhook has no user session) so the
          // LISTING_AGREEMENT_SIGNED kernel event + its automation fire — the
          // prior raw UPDATE bypassed that, and logEventAndTrigger threw on the
          // empty brokerage_id. Going live on the MLS is a later, separate step
          // (MLS_READY → MLS_ACTIVE). Only advance from pre-signature stages.
          const { data: listingRow } = await supabase
            .from("listings")
            .select("lifecycle_stage, brokerage_id")
            .eq("id", matchedAgreement.listing_id)
            .maybeSingle()

          if (listingRow?.brokerage_id && listingRow.lifecycle_stage === "LISTING_AGREEMENT_INITIATED") {
            await transitionLifecycle({
              brokerageId: listingRow.brokerage_id,
              entityType:  "listing_stage_machine",
              entityId:    matchedAgreement.listing_id,
              fromState:   listingRow.lifecycle_stage,
              toState:     "LISTING_AGREEMENT_SIGNED",
              actorUserId: null,
              eventType:   "listing_agreement_signed",
              metadata:    { agreementId: matchedAgreement.id, loop_id, provider: "dotloop", source: "webhook" },
            }, supabase)

            // stage_entered_at is the stage machine's clock; listings.status is NOT written here —
            // transitionLifecycle synced it (listing_signed) from the shared map one call above.
            await supabase
              .from("listings")
              .update({ stage_entered_at: now })
              .eq("id", matchedAgreement.listing_id)
            // ── THE COMPLIANCE LOOP'S FIRST RUN (owner ruling 2026-09-05) ─────────
            // The executed agreement is where compliance STARTS. The kernel transition above
            // already stamped `listing_signed` through the shared map; the explicit
            // `status: coming_soon` write that stood here overwrote it and declared the
            // gate passed before it had run. Now the loop runs the ONE gate: a pass walks the
            // listing to COMING_SOON_PREP (status coming_soon), a fail names what is missing
            // to the TC, the compliance officer and the agent, and every later upload
            // re-enters it. Non-fatal — the webhook has already recorded the signature.
            try {
              const { runListingComplianceLoop } = await import("@/lib/listings/listing-compliance-loop")
              await runListingComplianceLoop(supabase as any, {
                brokerageId: listingRow.brokerage_id, listingId: matchedAgreement.listing_id, trigger: "agreement_executed", actorUserId: null,
              })
            } catch (err: any) {
              console.error("[dotloop] listing compliance loop failed (non-fatal):", err?.message ?? err)
            }
          }
        }

        // ── Esign completion: voice-cockpit staged artifacts ─────────────────
        // Shared helper handles the documents + buyer_broker_agreements flip
        // and kernel event emission. Every provider webhook calls this so the
        // dispatch chain converges regardless of which provider the agent uses.
        await finalizeVoiceCockpitPacket(supabase as any, loop_id, "dotloop")

        // INGRESS CONTINUITY: park an unmatched loop as a dead letter for the
        // daily reconciler — never lost behind this 200.
        const { ensureEsignIngressContinuity } = await import("@/lib/kernel/ingress-continuity")
        await ensureEsignIngressContinuity(supabase as any, { provider: "dotloop", envelopeId: loop_id ?? null })
      }
    }

    if (loopEvent === "loop.status.updated" && canonLoopId && canonStatus) {
      await supabase
        .from("transactions")
        .update({ status: mapDotloopStatus(canonStatus) })
        .eq("external_provider_transaction_id", canonLoopId)
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
