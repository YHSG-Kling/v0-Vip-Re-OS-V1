import { type NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { createClient } from "@/lib/supabase/server"
import {
  finalizeVoiceCockpitPacket,
  finalizeLegacyEsignArtifacts,
} from "@/lib/esign-webhooks/finalize-packet"

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTISIGN WEBHOOK HANDLER  (Lone Wolf Authentisign)
//
// Authentisign / Lone Wolf signs the webhook body with HMAC-SHA256 using the
// secret configured in the Lone Wolf developer console. The signature is sent
// as `X-Authentisign-Signature` (base64-encoded digest).
//
// Active dependencies:
//   - AUTHENTISIGN_WEBHOOK_SECRET env var must be set, or the handler rejects with 401.
//   - lib/integrations/providers/provider-resolver.ts must implement an
//     AuthentisignProvider (not yet implemented) before
//     dispatch_transaction_packet can send envelopes via Authentisign. Until
//     then, this webhook will match zero rows — the handler is a no-op safely.
//
// Once both are wired, the webhook flips voice-cockpit packets +
// legacy offers/listing_agreements via the shared finalize-packet helper —
// same shape as the Dotloop + DocuSign + SkySlope handlers.
// ─────────────────────────────────────────────────────────────────────────────

function verifyAuthentisignSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.AUTHENTISIGN_WEBHOOK_SECRET
  if (!secret) {
    console.warn("[authentisign-webhook] AUTHENTISIGN_WEBHOOK_SECRET not set — rejecting request")
    return false
  }
  if (!signatureHeader) return false

  // Authentisign uses base64-encoded HMAC-SHA256.
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

  const signatureHeader = request.headers.get("x-authentisign-signature")
  if (!verifyAuthentisignSignature(rawBody, signatureHeader)) {
    return NextResponse.json({ error: "Invalid or missing webhook signature" }, { status: 401 })
  }

  try {
    const body = JSON.parse(rawBody)
    const supabase = await createClient()

    // Authentisign envelope events:
    //   - "signing.completed"   all signers have signed
    //   - "signing.declined"    a signer declined (not handled here yet)
    //   - "signing.expired"     envelope expired (not handled here yet)
    const event  = (body.event ?? body.eventType ?? "").toString().toLowerCase()
    const status = (body?.data?.status ?? body?.status ?? "").toString().toLowerCase()
    const envelopeId =
      body?.data?.signingId
      ?? body?.data?.envelopeId
      ?? body?.signingId
      ?? body?.envelopeId
      ?? null

    const isCompleted =
      event === "signing.completed"
      || status === "completed"
      || status === "signed"

    if (!isCompleted || !envelopeId) {
      return NextResponse.json({ received: true, action: "ignored", event, status })
    }

    const voice  = await finalizeVoiceCockpitPacket(supabase as any, envelopeId, "authentisign")
    const legacy = await finalizeLegacyEsignArtifacts(supabase as any, envelopeId)

    return NextResponse.json({
      received:    true,
      envelopeId,
      docs_signed: voice.docs_signed,
      bba_signed:  voice.bba_signed,
      legacy,
    })
  } catch (error: any) {
    console.error("[authentisign-webhook] Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
