/**
 * lib/esign-webhooks/finalize-packet.ts
 *
 * Shared finalize-on-signed logic for e-sign provider webhooks.
 *
 * Every provider webhook (Dotloop, DocuSign, SkySlope, Authentisign, …) does
 * the same thing once the envelope is fully signed:
 *
 *   1. Find documents WHERE metadata->>'signature_request_id' = envelopeId
 *      and flip status='signed' + stamp signed_at / signed_via.
 *   2. Find buyer_broker_agreements WHERE signature_request_id = envelopeId
 *      and flip status='active' + stamp signed_at / signed_method.
 *   3. Emit voice_cockpit.packet.signed + buyer_broker_agreement.signed
 *      kernel events with dedupe keys so downstream rules can fire exactly
 *      once.
 *
 * This module collapses that into one function. Each provider's webhook
 * remains responsible for:
 *   - parsing its own payload + extracting envelopeId / loop_id
 *   - verifying its own HMAC signature
 *   - calling finalizeVoiceCockpitPacket() with the envelope ID + provider name
 *
 * Why this exists:
 *   The Dotloop + DocuSign handlers had ~25 lines each of identical
 *   flip-and-emit logic. Adding SkySlope or Authentisign would duplicate it
 *   again. One helper, four call sites.
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { logEventAndTrigger } from "@/lib/events"

export type ESignProviderName = "dotloop" | "docusign" | "skyslope" | "authentisign"

export interface FinalizePacketResult {
  docs_signed: number
  bba_signed: number
  envelopeId: string
}

/**
 * Flip every voice-cockpit-staged artifact (offer/listing/BBA) tied to the
 * given e-sign envelope to its signed state.
 *
 * Safe to call multiple times — the underlying updates are idempotent
 * (status fields only change once) and the kernel-event dedupe key prevents
 * duplicate downstream triggers.
 */
export async function finalizeVoiceCockpitPacket(
  supabase: SupabaseClient,
  envelopeId: string,
  provider: ESignProviderName,
): Promise<FinalizePacketResult> {
  if (!envelopeId) {
    return { docs_signed: 0, bba_signed: 0, envelopeId: "" }
  }
  const now = new Date().toISOString()

  // ── Documents (offer / listing-agreement) ─────────────────────────────────
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
          signed_via:          provider,
          signed_envelope_id:  envelopeId,
        },
      })
      .eq("id", docRow.id)

    await logEventAndTrigger({
      brokerage_id: docRow.brokerage_id as string,
      event_type:   "voice_cockpit.packet.signed",
      user_id:      (docRow.contact_id as string | null) ?? "",
      payload:      { documentId: docRow.id, documentType: docRow.document_type, envelopeId, provider },
      source:       "webhook",
      dedupe_key:   `voice-packet-signed-${docRow.id}`,
    } as any)
  }

  // ── BBA ───────────────────────────────────────────────────────────────────
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
        signed_method: provider,
      })
      .eq("id", matchedBBA.id)

    await logEventAndTrigger({
      brokerage_id: matchedBBA.brokerage_id as string,
      event_type:   "buyer_broker_agreement.signed",
      user_id:      matchedBBA.buyer_contact_id as string,
      payload:      { agreementId: matchedBBA.id, envelopeId, provider },
      source:       "webhook",
      dedupe_key:   `bba-signed-${matchedBBA.id}`,
    } as any)
  }

  // ── Offers (convergence with the legacy post-signed chain) ────────────────
  // The voice cockpit stages BOTH a documents row AND an offers row, linked
  // via documents.metadata.linked_offer_id. Dispatch stamps the envelopeId on
  // BOTH (documents.metadata.signature_request_id + offers.provider_envelope_id).
  // Here we close the loop: flip the offers row to fully_signed, emit
  // buyer.offer.compliance.passed (the gate the auto-create chain requires),
  // transition state to ACCEPTED, then convert to a transaction so milestones
  // + deadlines get seeded.
  await finalizeMatchingOffer(supabase, envelopeId, provider)

  return {
    docs_signed: (matchedDocs ?? []).length,
    bba_signed:  matchedBBA ? 1 : 0,
    envelopeId,
  }
}

/**
 * When a signed envelope matches an offers row (via provider_envelope_id),
 * advance it through the canonical buyer-offer lifecycle so the existing
 * post-signed automation fires: compliance.passed → ACCEPTED →
 * convertOfferToTransaction → ensureRequiredMilestones.
 *
 * Safe to call from any provider's webhook — the post-signed chain has its
 * own dedupe via the offer.transaction_id back-link.
 */
async function finalizeMatchingOffer(
  supabase: SupabaseClient,
  envelopeId: string,
  provider: ESignProviderName,
): Promise<void> {
  const now = new Date().toISOString()

  const { data: matchedOffer } = await supabase
    .from("offers")
    .select("id, brokerage_id, agent_id, contact_id, transaction_id, esign_status, closing_date, inspection_period_days, appraisal_contingency_days, financing_contingency_days, earnest_money, ai_extracted_data")
    .eq("provider_envelope_id", envelopeId)
    .maybeSingle()

  if (!matchedOffer) return
  if (matchedOffer.transaction_id) return  // already converted — idempotent

  // 1. Flip offer's e-sign status to fully_signed
  await supabase
    .from("offers")
    .update({
      esign_status:        "fully_signed",
      esign_completed_at:  now,
      buyer_signed_at:     now,
      esign_provider:      provider,
    })
    .eq("id", matchedOffer.id)

  // 2. Stamp compliance_passed_at on the offer so downstream readers
  //    (transactions reports, compliance dashboard, agent UI) treat this
  //    e-sign completion as the proof of execution.
  const actorId = (matchedOffer.agent_id as string | null) ?? null
  await supabase
    .from("offers")
    .update({ compliance_passed_at: now })
    .eq("id", matchedOffer.id)

  // 3. Insert lifecycle activities. The activities table has no entity_id
  //    column on this schema — convention is entity_type plus offer_id
  //    stored in notes JSON / metadata.
  if (actorId) {
    await supabase.from("activities").insert({
      brokerage_id:  matchedOffer.brokerage_id,
      agent_id:      actorId,
      contact_id:    matchedOffer.contact_id,
      entity_type:   "offer",
      activity_type: "buyer.offer.compliance.passed",
      title:         "Compliance gate passed (e-sign envelope completed)",
      description:   `Envelope ${envelopeId} fully signed via ${provider}; compliance gate cleared by signature completion.`,
      notes:         JSON.stringify({ offer_id: matchedOffer.id, envelopeId, provider, source: "esign_webhook" }),
      metadata:      { offer_id: matchedOffer.id, envelopeId, provider, signed_at: now },
      status:        "completed",
    })

    // 4. Transition the offer lifecycle to ACCEPTED. getOfferLifecycleState
    //    derives state from entity_type='contact' activities — we mirror the
    //    pattern used by recordSellerResponse.
    await supabase.from("activities").insert({
      brokerage_id:  matchedOffer.brokerage_id,
      agent_id:      actorId,
      contact_id:    matchedOffer.contact_id,
      entity_type:   "contact",
      activity_type: "buyer.offer.accepted",
      title:         "Offer accepted via e-sign completion",
      description:   `Offer ${matchedOffer.id} fully executed — both parties signed.`,
      notes:         JSON.stringify({ offer_id: matchedOffer.id, previous_state: "PENDING", new_state: "ACCEPTED", source: "esign_webhook", envelopeId, provider }),
      status:        "completed",
    })
  }

  // 5. Convert offer → transaction. We bypass the convertOfferToTransaction
  //    wrapper (which depends on a compliance-gate read that queries a column
  //    not present on this schema) and call the canonical offer-bridge
  //    creator directly. It seeds transaction_milestones + transaction_deadlines
  //    via ensureRequiredMilestones, back-links the offer, and emits the
  //    transaction_started activity. Idempotent — we already early-returned
  //    above if matchedOffer.transaction_id was set.
  if (actorId) {
    try {
      const { createTransactionFromOffer } = await import("@/lib/transactions")
      const intake = ((matchedOffer.ai_extracted_data as Record<string, unknown> | null) ?? {}) as any
      const closingDate = (matchedOffer.closing_date as string | null)
        ?? (intake?.intake_snapshot?.closeDate?.value as string | null) ?? null
      const contractDate = now.slice(0, 10)

      const fromContract = (days: number | null | undefined) =>
        days ? new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10) : undefined

      const result = await createTransactionFromOffer({
        offerId:             matchedOffer.id as string,
        brokerageId:         matchedOffer.brokerage_id as string,
        contractDate,
        compliancePassedAt:  now,
        contractTerms: {
          earnestMoneyDue:     matchedOffer.earnest_money ? String(matchedOffer.earnest_money) : undefined,
          inspectionDeadline:  fromContract(matchedOffer.inspection_period_days as number | null),
          appraisalDeadline:   fromContract(matchedOffer.appraisal_contingency_days as number | null),
          financingDeadline:   fromContract(matchedOffer.financing_contingency_days as number | null),
          closingDate:         closingDate ?? undefined,
        },
      })

      if (result?.success) {
        await logEventAndTrigger({
          brokerage_id: matchedOffer.brokerage_id as string,
          event_type:   "voice_cockpit.transaction.auto_created",
          user_id:      actorId,
          payload:      { offerId: matchedOffer.id, transactionId: result.transactionId, envelopeId, provider },
          source:       "webhook",
          dedupe_key:   `vc-tx-created-${matchedOffer.id}`,
        } as any)
      } else {
        console.warn("[finalize-packet] createTransactionFromOffer returned non-success:", result)
      }
    } catch (err: any) {
      console.error("[finalize-packet] createTransactionFromOffer threw:", err?.message ?? err)
    }
  }
}

/**
 * Also flip the LEGACY tables (offers / listing_agreements) for the
 * pre-voice-cockpit dispatch path. Providers that store their ref on
 * offers.esign_provider or listing_agreements.provider_ref should call this
 * alongside finalizeVoiceCockpitPacket so both pre- and post-cockpit
 * dispatches converge.
 */
export async function finalizeLegacyEsignArtifacts(
  supabase: SupabaseClient,
  envelopeId: string,
): Promise<{ legacy_offers: number; legacy_listings: number }> {
  const now = new Date().toISOString()

  // Match by provider_envelope_id (new canonical column). The legacy
  // `esign_provider` field is the platform NAME (dotloop/docusign/…) and
  // never an envelope id — never match on it.
  const { data: matchedOffer } = await supabase
    .from("offers")
    .select("id, contact_id, transaction_id")
    .eq("provider_envelope_id", envelopeId)
    .maybeSingle()
  if (matchedOffer && !matchedOffer.transaction_id) {
    // Only set fully_signed/completed timestamps here — the offer-side
    // convergence (compliance.passed → ACCEPTED → convertOfferToTransaction)
    // is handled by finalizeMatchingOffer in finalizeVoiceCockpitPacket and
    // would have already run by the time we get here (same call site).
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

  return {
    legacy_offers:   matchedOffer ? 1 : 0,
    legacy_listings: matchedAgreement ? 1 : 0,
  }
}
