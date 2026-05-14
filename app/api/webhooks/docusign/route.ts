import { type NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { createClient } from "@/lib/supabase/server"
import { finalizeVoiceCockpitPacket, finalizeLegacyEsignArtifacts } from "@/lib/esign-webhooks/finalize-packet"

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

    // Voice-cockpit packet + legacy artifacts — shared helpers handle both.
    const voice  = await finalizeVoiceCockpitPacket(supabase as any, envelopeId, "docusign")
    const legacy = await finalizeLegacyEsignArtifacts(supabase as any, envelopeId)

    return NextResponse.json({
      received:    true,
      envelopeId,
      docs_signed: voice.docs_signed,
      bba_signed:  voice.bba_signed,
      legacy,
    })
  } catch (error: any) {
    console.error("[docusign-webhook] Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
