// lib/forms/esign-execution-loop.ts
//
// THE PROVIDER-AGNOSTIC E-SIGN EXECUTION LOOP — the one place that answers
// "is this deal's whole signature packet actually done", regardless of which
// e-sign provider the tenant's Settings → Integrations connects.
//
// OWNER RULING (2026-09-09): "dotloop is not the only esign provider available
// and the users transaction and esign providers are found in the settings of
// which provider they use." The provider is ALWAYS resolved from tenant/
// transaction/listing settings (lib/integrations/providers/provider-resolver.ts,
// lib/kernel/forms.ts:resolveTransactionFormsProvider) — never assumed.
//
// EXTRACTED (wave 47 lane FA, orphan doctrine §1.1 — DUPLICATE merged onto a
// survivor) from app/api/webhooks/dotloop/route.ts's inline
// "LOOP-LEVEL SIGNATURE-ANCHOR EXECUTION" block (wave 46 lane EC). That block
// solved a REAL defect for Dotloop only: a Dotloop loop's `document.signed`
// event fires ONCE PER DOCUMENT, and without a loop-completeness gate, the
// FIRST signer in a multi-document loop flipped the offer's esign_status, the
// listing agreement's fully_executed_at, and the voice-cockpit packet finalize
// all to "fully signed." The exact same shape of bug exists for every OTHER
// provider once a transaction or listing tracks MORE THAN ONE envelope (a
// purchase agreement envelope plus a later addendum envelope, say) — DocuSign/
// SkySlope/Authentisign's own "envelope completed" event only proves ONE
// envelope finished, not that every envelope this deal is tracking has. This
// module generalizes the same invariant across every provider's tracked-
// document lane instead of leaving it Dotloop-only.
//
// TRACKED-DOCUMENT SOURCES (both read, never branched on provider name):
//   · client_documents   — the Dotloop-era table; also carries transaction_id
//     and listing_id, so it is scoped generically, not by a `dotloop_*` column.
//   · transaction_documents — the m106/m614 provider-agnostic sync target
//     (lib/transactions/sync-from-provider.ts), covering the transaction lane
//     AND the m614 listing lane (pre-contract packets sent before a
//     `transactions` row exists).
//
// READY-WRITES fire ONLY when evalAnchorExecution reports every tracked
// document signed. Otherwise a manager signal tells deal_coordinator the loop
// is still partial — never silence, per CLAUDE.md §4 "fail closed."
//
// Exercised by scripts/esign-anchor-simulator.ts.

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { evalAnchorExecution, type FormAnchorStatus, type AnchorExecutionResult } from "./esign-anchor-eval"
import { logEventAndTrigger } from "@/lib/events"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { OFFER_AUDIT_EVENT } from "@/lib/buyer-offer/offer-lifecycle"

type AnySupabase = SupabaseClient<any, any, any>

export interface EvaluateEnvelopeExecutionInput {
  brokerageId: string
  /** The tenant's configured provider for this loop — resolved from settings
   *  (provider-resolver.ts / resolveTransactionFormsProvider), never assumed. */
  providerSource: string
  /** The provider's own loop/envelope id, when the caller has one (every
   *  webhook has this). Used to (a) scope client_documents rows tracked under
   *  it and (b) resolve transactionId/listingId when the caller doesn't
   *  already know them. */
  externalEnvelopeId?: string | null
  /** Known parent — pass when the caller already has it (the sweep always
   *  does; a webhook usually has to resolve it below). */
  transactionId?: string | null
  listingId?: string | null
}

export interface EvaluateEnvelopeExecutionResult {
  /** false = nothing tracked was found for this loop yet (a fresh sync, or a
   *  loop with no client_documents/transaction_documents rows). Distinct from
   *  "found but incomplete" — no writes and no signal fire either way. */
  evaluated: boolean
  fullyExecuted: boolean
  execResult: AnchorExecutionResult | null
  transactionId: string | null
  listingId: string | null
  matchedOfferId: string | null
  matchedAgreementId: string | null
  readyWritesApplied: boolean
  signalPublished: boolean
}

const NOT_FOUND: EvaluateEnvelopeExecutionResult = {
  evaluated: false, fullyExecuted: false, execResult: null,
  transactionId: null, listingId: null, matchedOfferId: null, matchedAgreementId: null,
  readyWritesApplied: false, signalPublished: false,
}

/**
 * resolveEnvelopeBrokerageId — a webhook has an envelope/loop id and nothing
 * else (no session, no tenant context). Provider-assigned envelope ids are
 * effectively globally unique, so this looks the id up UNSCOPED across the
 * four tables evaluateEnvelopeExecution itself matches against, and returns
 * whichever row's brokerage_id it finds first. Null when nothing matches at
 * all — the caller's cue that there is genuinely nothing to gate or finalize
 * (same as today: the underlying finalize helpers would find zero rows too).
 */
export async function resolveEnvelopeBrokerageId(
  supabase: AnySupabase,
  envelopeId: string,
): Promise<string | null> {
  const { data: offer } = await supabase
    .from("offers").select("brokerage_id").eq("provider_envelope_id", envelopeId).maybeSingle()
  if ((offer as any)?.brokerage_id) return (offer as any).brokerage_id

  const { data: txn } = await supabase
    .from("transactions").select("brokerage_id").eq("external_provider_transaction_id", envelopeId).maybeSingle()
  if ((txn as any)?.brokerage_id) return (txn as any).brokerage_id

  const { data: agreement } = await supabase
    .from("listing_agreements").select("brokerage_id").eq("provider_ref", envelopeId).maybeSingle()
  if ((agreement as any)?.brokerage_id) return (agreement as any).brokerage_id

  const { data: listing } = await supabase
    .from("listings").select("brokerage_id").eq("external_provider_transaction_id", envelopeId).maybeSingle()
  return (listing as any)?.brokerage_id ?? null
}

/**
 * evaluateEnvelopeExecution — the loop-completeness gate, provider-agnostic.
 *
 * 1. Resolve transactionId/listingId (when not already known) from the
 *    envelope id, against the SAME columns finalize-packet.ts already
 *    matches on: offers.provider_envelope_id, listing_agreements.provider_ref,
 *    transactions/listings.external_provider_transaction_id (m106/m614).
 * 2. Read every tracked document for that loop from BOTH client_documents and
 *    transaction_documents (never just one — a deal can carry rows in either
 *    depending on when/how it was tracked).
 * 3. Call evalAnchorExecution — pure, no I/O.
 * 4. Fully executed → the three ready-writes (offer stamp, listing-agreement
 *    stamp + lifecycle transition, finalizeVoiceCockpitPacket). Otherwise →
 *    publish `esign_loop_partially_signed` to deal_coordinator.
 *
 * Never throws past this function — every provider webhook and the sweep call
 * this inside their own best-effort wrapper, and a signature webhook must
 * still return 200 even when this gate's own writes fail.
 */
export async function evaluateEnvelopeExecution(
  supabase: AnySupabase,
  input: EvaluateEnvelopeExecutionInput,
): Promise<EvaluateEnvelopeExecutionResult> {
  const envelopeId = input.externalEnvelopeId ?? null
  let transactionId = input.transactionId ?? null
  let listingId = input.listingId ?? null
  let matchedOfferId: string | null = null
  let matchedAgreementId: string | null = null

  // ── 1. Resolve parents from the envelope id when the caller didn't already
  //       know them (the webhook case — the sweep always passes them). ──────
  if (envelopeId) {
    if (!transactionId) {
      const { data: offerByEnvelope } = await supabase
        .from("offers")
        .select("id, transaction_id")
        .eq("provider_envelope_id", envelopeId)
        .maybeSingle()
      if (offerByEnvelope) {
        matchedOfferId = (offerByEnvelope as any).id ?? null
        transactionId = (offerByEnvelope as any).transaction_id ?? transactionId
      }
      if (!transactionId) {
        const { data: txnByEnvelope } = await supabase
          .from("transactions")
          .select("id")
          .eq("brokerage_id", input.brokerageId)
          .eq("external_provider_transaction_id", envelopeId)
          .maybeSingle()
        transactionId = (txnByEnvelope as any)?.id ?? null
      }
    }
    if (!listingId) {
      const { data: agreementByEnvelope } = await supabase
        .from("listing_agreements")
        .select("id, listing_id")
        .eq("provider_ref", envelopeId)
        .maybeSingle()
      if (agreementByEnvelope) {
        matchedAgreementId = (agreementByEnvelope as any).id ?? null
        listingId = (agreementByEnvelope as any).listing_id ?? listingId
      }
      if (!listingId) {
        const { data: listingByEnvelope } = await supabase
          .from("listings")
          .select("id")
          .eq("brokerage_id", input.brokerageId)
          .eq("external_provider_transaction_id", envelopeId)
          .maybeSingle()
        listingId = (listingByEnvelope as any)?.id ?? null
      }
    }
  }

  if (!envelopeId && !transactionId && !listingId) {
    // Nothing to scope the read by at all — refuse rather than guess.
    return NOT_FOUND
  }

  // ── 2. Read every tracked document for this loop from BOTH sources. ──────
  const clientDocFilters: string[] = []
  if (envelopeId) clientDocFilters.push(`dotloop_loop_id.eq.${envelopeId}`)
  if (transactionId) clientDocFilters.push(`transaction_id.eq.${transactionId}`)
  if (listingId) clientDocFilters.push(`listing_id.eq.${listingId}`)

  const [clientDocsRes, txnDocsRes] = await Promise.all([
    clientDocFilters.length > 0
      ? supabase
          .from("client_documents")
          .select("id, document_name, status, transaction_id")
          .eq("brokerage_id", input.brokerageId)
          .or(clientDocFilters.join(","))
      : Promise.resolve({ data: [], error: null } as any),
    transactionId || listingId
      ? supabase
          .from("transaction_documents")
          .select("id, doc_label, status")
          .eq("brokerage_id", input.brokerageId)
          .eq("provider_source", input.providerSource)
          .or(
            [transactionId ? `transaction_id.eq.${transactionId}` : null, listingId ? `listing_id.eq.${listingId}` : null]
              .filter(Boolean)
              .join(","),
          )
      : Promise.resolve({ data: [], error: null } as any),
  ])

  if (clientDocsRes.error) {
    // Fail closed (§4): a read that could not run must never be read as
    // "nothing outstanding" — refuse rather than fabricate a clean verdict.
    console.error(`[esign-execution-loop] client_documents read refused for envelope ${envelopeId ?? "?"}: ${clientDocsRes.error.message}`)
    return NOT_FOUND
  }
  if (txnDocsRes.error) {
    console.error(`[esign-execution-loop] transaction_documents read refused for envelope ${envelopeId ?? "?"}: ${txnDocsRes.error.message}`)
    return NOT_FOUND
  }

  // Every row tracked under a loop/envelope or a synced transaction/listing
  // packet was, by construction, sent for a signature — so it carries at
  // least one anchor. anchorCount is 1 per tracked document (coarse but
  // honest — the finer per-tag count is the still-open thread esign-anchor-
  // eval.ts's own header names; this closes the coarser, still-real loop).
  const forms: FormAnchorStatus[] = [
    ...((clientDocsRes.data ?? []) as any[]).map((d) => ({
      formKey: (d.document_name as string | null) ?? (d.id as string),
      anchorCount: 1,
      signed: d.status === "signed",
    })),
    ...((txnDocsRes.data ?? []) as any[]).map((d) => ({
      formKey: (d.doc_label as string | null) ?? (d.id as string),
      anchorCount: 1,
      signed: d.status === "signed",
    })),
  ]

  if (forms.length === 0) {
    // Nothing tracked yet for this loop — e.g. the first sync hasn't landed.
    // Not an incomplete loop; there is no loop to be incomplete.
    return { ...NOT_FOUND, transactionId, listingId, matchedOfferId, matchedAgreementId }
  }

  const execResult = evalAnchorExecution(forms)
  const fullyExecuted = execResult.allExecuted

  let readyWritesApplied = false
  let signalPublished = false

  if (fullyExecuted) {
    readyWritesApplied = await applyReadyWrites(supabase, {
      brokerageId: input.brokerageId,
      providerSource: input.providerSource,
      envelopeId,
      transactionId,
      listingId,
      matchedOfferId,
      matchedAgreementId,
    })
  } else if (transactionId || listingId) {
    // Signal deal_coordinator rather than leaving the partial loop silent —
    // best-effort, must never fail the caller (a webhook must still 200).
    try {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      const entityType = transactionId ? "transaction" : "listing"
      const entityId = transactionId ?? (listingId as string)
      const res = await publishManagerSignal(
        {
          brokerageId: input.brokerageId,
          fromManager: "compliance_officer",
          toManager: "deal_coordinator",
          signalType: "esign_loop_partially_signed",
          message: `${input.providerSource} loop ${envelopeId ?? entityId}: ${execResult.incomplete.length} form(s) still unsigned — ${execResult.reasons.join("; ")}`,
          entityType,
          entityId,
          payload: { envelopeId, provider: input.providerSource, incomplete: execResult.incomplete },
        },
        supabase as any,
      )
      signalPublished = res.ok
    } catch (err) {
      console.error("[esign-execution-loop] partial-loop signal to deal_coordinator failed (non-blocking):", err)
    }
  }

  return {
    evaluated: true,
    fullyExecuted,
    execResult,
    transactionId,
    listingId,
    matchedOfferId,
    matchedAgreementId,
    readyWritesApplied,
    signalPublished,
  }
}

/**
 * The three ready-writes, fired ONLY once evaluateEnvelopeExecution has
 * proven every tracked document in the loop is signed. Byte-for-byte the
 * same three writes app/api/webhooks/dotloop/route.ts used to make inline —
 * generalized off the envelope id instead of Dotloop's loop_id, and matched
 * on `offers.provider_envelope_id` (the canonical envelope reference every
 * provider's submit-for-signature path stamps — app/actions/buyer-offer/
 * submit-for-signature.ts:396's own comment: "not on esign_provider — that's
 * the platform name") rather than the dead `offers.esign_provider = loop_id`
 * comparison the inline block used (esign_provider is CHECK-constrained to
 * provider NAMES — scripts/check-vocabularies.ts — so that comparison could
 * never match a real loop id; this is the fix, not a behavior change anyone
 * depended on).
 */
async function applyReadyWrites(
  supabase: AnySupabase,
  ctx: {
    brokerageId: string
    providerSource: string
    envelopeId: string | null
    transactionId: string | null
    listingId: string | null
    matchedOfferId: string | null
    matchedAgreementId: string | null
  },
): Promise<boolean> {
  const now = new Date().toISOString()
  let wroteSomething = false

  // ── Esign completion: offers ────────────────────────────────────────────
  const offerSelect = "id, contact_id, brokerage_id, transaction_id, buyer_signed_at, seller_signed_at, fully_signed_contract_received_at, esign_status"
  const offerLookup = ctx.matchedOfferId
    ? supabase.from("offers").select(offerSelect).eq("id", ctx.matchedOfferId).maybeSingle()
    : ctx.envelopeId
      ? supabase.from("offers").select(offerSelect).eq("provider_envelope_id", ctx.envelopeId).maybeSingle()
      : ctx.transactionId
        ? supabase.from("offers").select(offerSelect).eq("transaction_id", ctx.transactionId).maybeSingle()
        : Promise.resolve({ data: null } as any)
  const { data: matchedOffer } = await offerLookup

  if (matchedOffer && (matchedOffer as any).esign_status !== "fully_signed") {
    wroteSomething = true
    const { error: offerStampError } = await supabase
      .from("offers")
      .update({
        esign_status:                      "fully_signed",
        esign_completed_at:                now,
        buyer_signed_at:                   (matchedOffer as any).buyer_signed_at ?? now,
        seller_signed_at:                  (matchedOffer as any).seller_signed_at ?? now,
        fully_signed_contract_received_at: (matchedOffer as any).fully_signed_contract_received_at ?? now,
      })
      .eq("id", (matchedOffer as any).id)
    if (offerStampError) console.error(`[esign-execution-loop] offer ${(matchedOffer as any).id} fully-signed stamp refused: ${offerStampError.message}`)

    await logEventAndTrigger({
      brokerage_id: (matchedOffer as any).brokerage_id ?? "",
      event_type: OFFER_AUDIT_EVENT.ESIGN_COMPLETED,
      user_id:    (matchedOffer as any).contact_id,
      payload:    { offerId: (matchedOffer as any).id, envelopeId: ctx.envelopeId, provider: ctx.providerSource },
      source:     "webhook",
      dedupe_key: `offer-esign-complete-${(matchedOffer as any).id}`,
    } as any)

    if (!offerStampError && (matchedOffer as any).brokerage_id) {
      try {
        const { runOfferComplianceLoop } = await import("@/lib/transactions/offer-compliance-loop")
        await runOfferComplianceLoop(supabase as any, {
          brokerageId: (matchedOffer as any).brokerage_id as string,
          offerId:     (matchedOffer as any).id as string,
          trigger:     "agreement_executed",
          actorUserId: null,
        })
      } catch (err) {
        console.error("[esign-execution-loop] offer compliance loop failed (non-fatal):", (err as Error).message)
      }
    }
  }

  // ── Esign completion: listing_agreements ────────────────────────────────
  const agreementSelect = "id, listing_id, fully_executed_at"
  const agreementLookup = ctx.matchedAgreementId
    ? supabase.from("listing_agreements").select(agreementSelect).eq("id", ctx.matchedAgreementId).maybeSingle()
    : ctx.envelopeId
      ? supabase.from("listing_agreements").select(agreementSelect).eq("provider_ref", ctx.envelopeId).maybeSingle()
      : ctx.listingId
        ? supabase.from("listing_agreements").select(agreementSelect).eq("listing_id", ctx.listingId).maybeSingle()
        : Promise.resolve({ data: null } as any)
  const { data: matchedAgreement } = await agreementLookup

  if (matchedAgreement && !(matchedAgreement as any).fully_executed_at) {
    wroteSomething = true
    await supabase
      .from("listing_agreements")
      .update({ esign_status: "fully_signed", fully_executed_at: now })
      .eq("id", (matchedAgreement as any).id)

    const { data: listingRow } = await supabase
      .from("listings")
      .select("lifecycle_stage, brokerage_id")
      .eq("id", (matchedAgreement as any).listing_id)
      .maybeSingle()

    if ((listingRow as any)?.brokerage_id && (listingRow as any).lifecycle_stage === "LISTING_AGREEMENT_INITIATED") {
      await transitionLifecycle({
        brokerageId: (listingRow as any).brokerage_id,
        entityType:  "listing_stage_machine",
        entityId:    (matchedAgreement as any).listing_id,
        fromState:   (listingRow as any).lifecycle_stage,
        toState:     "LISTING_AGREEMENT_SIGNED",
        actorUserId: null,
        eventType:   "listing_agreement_signed",
        metadata:    { agreementId: (matchedAgreement as any).id, envelopeId: ctx.envelopeId, provider: ctx.providerSource, source: "esign-execution-loop" },
      }, supabase)

      await supabase
        .from("listings")
        .update({ stage_entered_at: now })
        .eq("id", (matchedAgreement as any).listing_id)

      try {
        const { runListingComplianceLoop } = await import("@/lib/listings/listing-compliance-loop")
        await runListingComplianceLoop(supabase as any, {
          brokerageId: (listingRow as any).brokerage_id, listingId: (matchedAgreement as any).listing_id, trigger: "agreement_executed", actorUserId: null,
        })
      } catch (err: any) {
        console.error("[esign-execution-loop] listing compliance loop failed (non-fatal):", err?.message ?? err)
      }
    }
  }

  // ── Esign completion: voice-cockpit staged artifacts ────────────────────
  // The shared helper handles the documents + buyer_broker_agreements flip
  // and kernel event emission; every provider converges on it here rather
  // than each webhook calling it unconditionally on its own envelope-
  // completed event (which is what let a not-yet-fully-tracked transaction's
  // packet finalize early for DocuSign/SkySlope/Authentisign before this
  // gate existed).
  const finalizeId = ctx.envelopeId
  if (finalizeId) {
    try {
      const { finalizeVoiceCockpitPacket } = await import("@/lib/esign-webhooks/finalize-packet")
      await finalizeVoiceCockpitPacket(supabase as any, finalizeId, ctx.providerSource as any)
      wroteSomething = true
    } catch (err) {
      console.error("[esign-execution-loop] finalizeVoiceCockpitPacket failed (non-fatal):", err)
    }
  }

  return wroteSomething
}
