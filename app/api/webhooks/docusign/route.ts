import { type NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { createClient } from "@/lib/supabase/server"
import { logEventAndTrigger } from "@/lib/events"

// ─────────────────────────────────────────────────────────────────────────────
// DOCUSIGN CONNECT WEBHOOK HANDLER
//
// DocuSign Connect sends envelope status changes to this endpoint. We care
// about envelope-completed events (envelope.status = "completed" / "Completed"),
// which fire when every signer has signed. The webhook header
// `X-DocuSign-Signature-1` carries an HMAC-SHA256 of the raw body using the
// secret configured in DocuSign Admin → Connect → Integrations.
//
// Storage envelope ID: in our system, dispatchTransactionPacket stamps the
// envelope ID onto:
//   - documents.metadata.signature_request_id  (the offer / listing-agreement)
//   - buyer_broker_agreements.signature_request_id (the BBA row)
// This webhook reverses the lookup to flip statuses when the envelope completes.
//
// Mirrors the Dotloop webhook handler (app/api/webhooks/dotloop/route.ts) so
// the voice-cockpit dispatch chain works the same way regardless of which
// provider the agent has configured in Settings → Integrations.
// ─────────────────────────────────────────────────────────────────────────────

function verifyDocusignSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.DOCUSIGN_WEBHOOK_SECRET
  if (!secret) {
    console.warn("[docusign-webhook] DOCUSIGN_WEBHOOK_SECRET not set — rejecting request")
    return false
  }
  if (!signatureHeader) return false

  // DocuSign computes HMAC-SHA256 over the raw body and base64-encodes the digest.
  // The header value is the raw base64 string (no prefix).
  const computed = createHmac("sha256", secret).update(rawBody, "utf-8").digest("base64")
  try {
    const a = Buffer.from(computed)
    const b = Buffer.from(signatureHeader)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()

  const signatureHeader = request.headers.get("x-docusign-signature-1")
  if (!verifyDocusignSignature(rawBody, signatureHeader)) {
    return NextResponse.json({ error: "Invalid or missing webhook signature" }, { status: 401 })
  }

  try {
    const body = JSON.parse(rawBody)
    const supabase = await createClient()

    // DocuSign Connect JSON shape:
    //   { event: "envelope-completed", data: { envelopeId, envelopeSummary: { status, ... } } }
    //   (or the older XML-derived shape — we accept both common forms)
    const event = (body.event ?? body.Event ?? "").toString().toLowerCase()
    const envelopeId =
      body?.data?.envelopeId
      ?? body?.envelopeId
      ?? body?.data?.envelopeSummary?.envelopeId
      ?? null
    const envelopeStatus = (
      body?.data?.envelopeSummary?.status
      ?? body?.envelopeStatus
      ?? ""
    ).toString().toLowerCase()

    const isCompleted =
      event === "envelope-completed"
      || event === "recipient-completed"
      || envelopeStatus === "completed"

    if (!isCompleted || !envelopeId) {
      // We log non-completion events but don't take action on them.
      return NextResponse.json({ received: true, action: "ignored", event, envelopeStatus })
    }

    const now = new Date().toISOString()

    // ── Voice-cockpit staged artifacts ──────────────────────────────────────
    // dispatch_transaction_packet bundles BBA + offer (or either alone) into
    // ONE provider envelope. dispatchTransactionPacket stamps the SAME
    // envelopeId on both rows; reversing the lookup here flips them in sync.

    // Documents (offer or listing-agreement) matched by metadata jsonb path
    const { data: matchedDocs } = await supabase
      .from("documents")
      .select("id, document_type, contact_id, brokerage_id, metadata")
      .filter("metadata->>signature_request_id", "eq", envelopeId)

    for (const docRow of (matchedDocs ?? [])) {
      const existingMeta = (docRow.metadata as Record<string, unknown>) ?? {}
      await supabase
        .from("documents")
        .update({
          status: "signed",
          metadata: {
            ...existingMeta,
            signed_at:           now,
            signed_via:          "docusign",
            signed_envelope_id:  envelopeId,
          },
        })
        .eq("id", docRow.id)

      await logEventAndTrigger({
        brokerage_id: docRow.brokerage_id as string,
        event_type:   "voice_cockpit.packet.signed",
        user_id:      (docRow.contact_id as string | null) ?? "",
        payload:      { documentId: docRow.id, documentType: docRow.document_type, envelopeId, provider: "docusign" },
        source:       "webhook",
        dedupe_key:   `voice-packet-signed-${docRow.id}`,
      } as any)
    }

    // BBA row matched by signature_request_id column
    const { data: matchedBBA } = await supabase
      .from("buyer_broker_agreements")
      .select("id, brokerage_id, buyer_contact_id")
      .eq("signature_request_id", envelopeId)
      .maybeSingle()

    if (matchedBBA) {
      await supabase
        .from("buyer_broker_agreements")
        .update({
          status:        "active",
          signed_at:     now,
          signed_method: "docusign",
        })
        .eq("id", matchedBBA.id)

      await logEventAndTrigger({
        brokerage_id: matchedBBA.brokerage_id as string,
        event_type:   "buyer_broker_agreement.signed",
        user_id:      matchedBBA.buyer_contact_id as string,
        payload:      { agreementId: matchedBBA.id, envelopeId, provider: "docusign" },
        source:       "webhook",
        dedupe_key:   `bba-signed-${matchedBBA.id}`,
      } as any)
    }

    // ── Legacy offers table (pre-voice-cockpit dispatch path) ───────────────
    // Same pattern as the Dotloop handler for the legacy offer / listing
    // agreement rows that store the provider ref directly.
    const { data: matchedOffer } = await supabase
      .from("offers")
      .select("id, contact_id")
      .eq("esign_provider", envelopeId)
      .maybeSingle()
    if (matchedOffer) {
      await supabase
        .from("offers")
        .update({ esign_status: "fully_signed", esign_completed_at: now })
        .eq("id", matchedOffer.id)
    }

    const { data: matchedAgreement } = await supabase
      .from("listing_agreements")
      .select("id, listing_id")
      .eq("provider_ref", envelopeId)
      .maybeSingle()
    if (matchedAgreement) {
      await supabase
        .from("listing_agreements")
        .update({ esign_status: "fully_signed", fully_executed_at: now })
        .eq("id", matchedAgreement.id)
      await supabase
        .from("listings")
        .update({ current_stage: "active", stage_entered_at: now })
        .eq("id", matchedAgreement.listing_id)
        .in("current_stage", ["prep", "pre_listing", "coming_soon"])
    }

    return NextResponse.json({
      received: true,
      envelopeId,
      docs_signed: (matchedDocs ?? []).length,
      bba_signed: matchedBBA ? 1 : 0,
    })
  } catch (error: any) {
    console.error("[docusign-webhook] Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
