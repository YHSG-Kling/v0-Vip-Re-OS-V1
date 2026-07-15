import { type NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { createServiceClient } from "@/lib/supabase/service"
import {
  finalizeVoiceCockpitPacket,
  finalizeLegacyEsignArtifacts,
} from "@/lib/esign-webhooks/finalize-packet"

// ─────────────────────────────────────────────────────────────────────────────
// SKYSLOPE WEBHOOK HANDLER
//
// SkySlope sends transaction + signature events to this endpoint. We care
// about the signed/completed events — when every signer has signed an
// envelope. SkySlope signs the webhook body with HMAC-SHA256 using the secret
// configured in SkySlope Admin → API Settings → Webhooks. The signature is
// sent as `X-SkySlope-Signature` (hex digest, no prefix).
//
// Active dependencies:
//   - SKYSLOPE_WEBHOOK_SECRET env var must be set, OR the handler rejects with 401.
//   - lib/integrations/providers/provider-resolver.ts must implement
//     SkySlopeProvider (currently throws "not yet implemented") before
//     dispatch_transaction_packet can send envelopes via SkySlope. Until
//     then, no envelope IDs get stamped onto our documents/buyer_broker_agreements
//     and this webhook will match zero rows — the handler is a no-op safely.
//
// Once both are wired, the webhook flips voice-cockpit packets +
// legacy offers/listing_agreements in the same shape as the Dotloop +
// DocuSign handlers (via the shared finalize-packet helper).
// ─────────────────────────────────────────────────────────────────────────────

function verifySkyslopeSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.SKYSLOPE_WEBHOOK_SECRET
  if (!secret) {
    console.warn("[skyslope-webhook] SKYSLOPE_WEBHOOK_SECRET not set — rejecting request")
    return false
  }
  if (!signatureHeader) return false

  const computed = createHmac("sha256", secret).update(rawBody, "utf-8").digest("hex")
  try {
    const a = Buffer.from(computed, "hex")
    const b = Buffer.from(signatureHeader, "hex")
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()

  const signatureHeader = request.headers.get("x-skyslope-signature")
  if (!verifySkyslopeSignature(rawBody, signatureHeader)) {
    return NextResponse.json({ error: "Invalid or missing webhook signature" }, { status: 401 })
  }

  try {
    const body = JSON.parse(rawBody)
    // Use service client — no user session in webhook; RLS would block writes
    // to documents / BBA tables without current_user_brokerage_id.
    const supabase = createServiceClient()

    // SkySlope events of interest:
    //   - "transaction.signed"           single document signed (per-doc)
    //   - "transaction.completed"        envelope fully executed
    //   - "envelope.completed"           alias used in some Connect versions
    // We process completion events; per-doc signed events are ignored to avoid
    // partial-state flips inside a multi-document envelope.
    // SCHEMA ADAPTATION: documented shapes are direct paths; new shapes adapt
    // via taught aliases (drift, ledgered) or QUARANTINE — never lost.
    const { adaptPayload, ESIGN_COMPLETION_CONTRACTS } = await import("@/lib/kernel/schema-adaptation")
    const adapted = adaptPayload(ESIGN_COMPLETION_CONTRACTS.skyslope, body)
    const event  = String(adapted.canonical.event ?? "").toLowerCase()
    const status = String(adapted.canonical.status ?? "").toLowerCase()
    const envelopeId = adapted.ok ? String(adapted.canonical.envelope_id) : null

    const isCompleted =
      event === "transaction.completed"
      || event === "envelope.completed"
      || status === "completed"
      || status === "fully_signed"

    if (isCompleted && !envelopeId) {
      const { quarantineDriftedPayload } = await import("@/lib/kernel/ingress-continuity")
      const q = await quarantineDriftedPayload(supabase as any, { connector: "skyslope", source: "esign_completion", raw: body, missing: adapted.missingRequired, eventType: event || status })
      return NextResponse.json({ received: true, quarantined: true, ref: q.ref })
    }
    if (!isCompleted || !envelopeId) {
      return NextResponse.json({ received: true, action: "ignored", event, status })
    }
    if (adapted.driftRepairs > 0) {
      const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
      await recordSelfHeal(supabase as any, {
        brokerageId: null, domain: "data_flow", subject: envelopeId, action: "adapt_payload", outcome: "healed",
        detail: { flow: "schema_drift", connector: "skyslope", repairs: adapted.repairs.filter((r) => r.kind !== "direct").slice(0, 12) },
      })
    }

    const voice  = await finalizeVoiceCockpitPacket(supabase as any, envelopeId, "skyslope")
    const legacy = await finalizeLegacyEsignArtifacts(supabase as any, envelopeId)

    // INGRESS CONTINUITY: park an unmatched envelope as a dead letter for the
    // daily reconciler — never lost behind this 200.
    const { ensureEsignIngressContinuity } = await import("@/lib/kernel/ingress-continuity")
    await ensureEsignIngressContinuity(supabase as any, { provider: "skyslope", envelopeId })

    return NextResponse.json({
      received:    true,
      envelopeId,
      docs_signed: voice.docs_signed,
      bba_signed:  voice.bba_signed,
      legacy,
    })
  } catch (error: any) {
    console.error("[skyslope-webhook] Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
