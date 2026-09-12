import { type NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { logEventAndTrigger } from "@/lib/events"
import { evaluateEnvelopeExecution } from "@/lib/forms/esign-execution-loop"

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

      // ── LOOP-LEVEL SIGNATURE-ANCHOR EXECUTION (closes the tagged→signed→verified
      //    loop, lib/forms/esign-anchor-eval.ts::evalAnchorExecution) ───────────
      //
      // A dotloop `document.signed` event fires ONCE PER DOCUMENT, not once per
      // loop. Every downstream "this deal's paperwork is ready" action — the
      // offer's esign_status, the listing agreement's fully_executed_at, the
      // voice-cockpit packet finalize — used to fire on the loop_id match alone,
      // with NO check that every document in a multi-document loop had actually
      // signed. The FIRST signer in a three-signature loop was enough to mark
      // the whole packet "fully signed."
      //
      // TOMBSTONE (wave 47 lane FA, orphan doctrine §1.1 — merged onto a
      // survivor): the inline gate + the three ready-writes (offer stamp,
      // listing-agreement stamp, finalizeVoiceCockpitPacket) that used to live
      // here are now lib/forms/esign-execution-loop.ts::evaluateEnvelopeExecution
      // — the SAME gate, generalized so DocuSign/SkySlope/Authentisign/
      // Brokermint/FormSimplicity tenants (owner ruling 2026-09-09: the
      // provider comes from the tenant's SETTINGS, never assumed) get the exact
      // same "every tracked document must be signed" invariant, not a
      // Dotloop-only one. Also wired: app/api/webhooks/{docusign,skyslope,
      // authentisign}/route.ts and lib/transactions/esign-doc-sync-sweep.ts
      // (the autonomous half for Brokermint/FormSimplicity, which have no
      // webhook at all).
      const execution = await evaluateEnvelopeExecution(supabase as any, {
        brokerageId: (doc?.brokerage_id as string | null) ?? "",
        providerSource: "dotloop",
        externalEnvelopeId: loop_id,
        transactionId: (doc?.transaction_id as string | null) ?? null,
      })
      const loopFullyExecuted = execution.evaluated && execution.fullyExecuted

      if (!error && doc) {
        // Complete the signature packet keyed to THIS client_documents row —
        // the portal Sign button gates on it (owner rule: gone the moment ink lands).
        await supabase
          .from("signature_requests")
          .update({ request_status: "completed", completed_at: now })
          .eq("document_id", doc.id)
          .is("completed_at", null)
          .then(() => {}, () => {})

        if (loopFullyExecuted && doc.transaction_id) {
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

      // TOMBSTONE (wave 47 lane FA): the offer stamp, listing_agreement stamp
      // and finalizeVoiceCockpitPacket call that used to live here — each
      // gated on loopFullyExecuted, matching offers via the dead
      // `esign_provider = loop_id` comparison (esign_provider is CHECK-
      // constrained to provider NAMES, scripts/check-vocabularies.ts — that
      // comparison could never match a real loop id) — now happen INSIDE
      // evaluateEnvelopeExecution above (lib/forms/esign-execution-loop.ts,
      // applyReadyWrites), matched correctly via offers.provider_envelope_id.
      // execution.readyWritesApplied / execution.signalPublished report what
      // it did; nothing further to do here for this event.
      if (loop_id) {
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
