import { type NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { evaluateEnvelopeExecution, resolveEnvelopeBrokerageId } from "@/lib/forms/esign-execution-loop"

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTISIGN WEBHOOK HANDLER  (Lone Wolf Authentisign)
//
// Authentisign / Lone Wolf signs the webhook body with HMAC-SHA256 using the
// secret configured in the Lone Wolf developer console. The signature is sent
// as `X-Authentisign-Signature` (base64-encoded digest).
//
// Active dependencies:
//   - AUTHENTISIGN_WEBHOOK_SECRET env var must be set, or the handler rejects with 401.
//   - lib/integrations/providers/authentisign-provider.ts (registered in
//     provider-resolver.ts) is the sending side. When a brokerage's
//     platform_credentials row has provider=authentisign, the canonical
//     `send for e-sign` workflow dispatches via AuthentisignProvider, which
//     produces the signingId that lands in our `voice_cockpit_envelopes` and
//     legacy `offers / listing_agreements` tables — this webhook then flips
//     them through the shared finalize-packet helper, same shape as the
//     DocuSign + Dotloop + SkySlope handlers.
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
    // Use service client — no user session in webhook; RLS would block writes
    // to documents / buyer_broker_agreements without a current_user_brokerage_id.
    const supabase = createServiceClient()

    // Authentisign envelope events:
    //   - "signing.completed"   all signers have signed
    //   - "signing.declined"    a signer declined (not handled here yet)
    //   - "signing.expired"     envelope expired (not handled here yet)
    // SCHEMA ADAPTATION: documented shapes are direct paths; new shapes adapt
    // via taught aliases (drift, ledgered) or QUARANTINE — never lost.
    const { adaptPayload, ESIGN_COMPLETION_CONTRACTS } = await import("@/lib/kernel/schema-adaptation")
    const { rememberShape } = await import("@/lib/kernel/schema-memory")
    await rememberShape(supabase as any, { connector: "authentisign", entity: "envelope_event", raw: body })
    const adapted = adaptPayload(ESIGN_COMPLETION_CONTRACTS.authentisign, body)
    const event  = String(adapted.canonical.event ?? "").toLowerCase()
    const status = String(adapted.canonical.status ?? "").toLowerCase()
    const envelopeId = adapted.ok ? String(adapted.canonical.envelope_id) : null

    const isCompleted =
      event === "signing.completed"
      || status === "completed"
      || status === "signed"

    if (isCompleted && !envelopeId) {
      const { quarantineDriftedPayload } = await import("@/lib/kernel/ingress-continuity")
      const q = await quarantineDriftedPayload(supabase as any, { connector: "authentisign", source: "esign_completion", raw: body, missing: adapted.missingRequired, eventType: event || status })
      return NextResponse.json({ received: true, quarantined: true, ref: q.ref })
    }
    if (!isCompleted || !envelopeId) {
      return NextResponse.json({ received: true, action: "ignored", event, status })
    }
    if (adapted.driftRepairs > 0) {
      const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
      await recordSelfHeal(supabase as any, {
        brokerageId: null, domain: "data_flow", subject: envelopeId, action: "adapt_payload", outcome: "healed",
        detail: { flow: "schema_drift", connector: "authentisign", repairs: adapted.repairs.filter((r) => r.kind !== "direct").slice(0, 12) },
      })
    }

    // PROVIDER-AGNOSTIC LOOP-EXECUTION GATE (wave 47 lane FA — see
    // lib/forms/esign-execution-loop.ts). Authentisign's own completion event
    // only proves ONE signing session finished; the gate reads every
    // client_documents / transaction_documents row tracked for the matched
    // transaction/listing and only finalizes when ALL of them are signed —
    // otherwise it signals compliance_officer → deal_coordinator instead of
    // finalizing early.
    const brokerageId = await resolveEnvelopeBrokerageId(supabase as any, envelopeId)
    const execution = brokerageId
      ? await evaluateEnvelopeExecution(supabase as any, {
          brokerageId,
          providerSource: "authentisign",
          externalEnvelopeId: envelopeId,
        })
      : null

    // INGRESS CONTINUITY: park an unmatched envelope as a dead letter for the
    // daily reconciler — never lost behind this 200.
    const { ensureEsignIngressContinuity } = await import("@/lib/kernel/ingress-continuity")
    await ensureEsignIngressContinuity(supabase as any, { provider: "authentisign", envelopeId })

    return NextResponse.json({
      received:   true,
      envelopeId,
      evaluated:  execution?.evaluated ?? false,
      fully_executed: execution?.fullyExecuted ?? false,
      ready_writes_applied: execution?.readyWritesApplied ?? false,
      signal_published: execution?.signalPublished ?? false,
    })
  } catch (error: any) {
    console.error("[authentisign-webhook] Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
