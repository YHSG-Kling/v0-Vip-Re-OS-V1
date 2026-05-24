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
import { logEventAndTrigger }  from "@/lib/events"
import { notifyEsignSigned }   from "@/lib/notifications/notify-helpers"
import { downloadSignedPackage } from "./download-signed-package"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"

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
 * record that the BUYER has signed. The envelope carries the buyer as the
 * only signer — buyer-sign is NOT the same as a fully-executed contract.
 *
 * Critical flow correction:
 *   - For external (out-of-brokerage) listings: the agent must still forward
 *     the buyer-signed offer to the listing agent and wait for the seller's
 *     response (accept / counter / reject).
 *   - The seller's response (counter terms or fully-signed contract) is
 *     captured later via recordSellerResponse() — manually by the agent or
 *     automatically from inbound email ingestion.
 *   - Only AFTER the agent reviews + explicitly signals "submit to compliance"
 *     do we run compliance.passed → ACCEPTED → convertOfferToTransaction.
 *
 * So this function does NOT:
 *   - emit buyer.offer.compliance.passed
 *   - emit buyer.offer.accepted (the lifecycle stays in PENDING/AWAITING_SELLER)
 *   - call createTransactionFromOffer
 *
 * It DOES:
 *   - flip offer.esign_status to 'partially_signed' (schema-allowed value;
 *     only the buyer-side signature has landed)
 *   - stamp buyer_signed_at + esign_provider
 *   - emit buyer.offer.buyer_signed activity so the agent's queue surfaces
 *     "forward to listing agent and await response" as the next step.
 */
async function finalizeMatchingOffer(
  supabase: SupabaseClient,
  envelopeId: string,
  provider: ESignProviderName,
): Promise<void> {
  const now = new Date().toISOString()

  const { data: matchedOffer } = await supabase
    .from("offers")
    .select("id, brokerage_id, agent_id, contact_id, transaction_id, esign_status, seller_signed_at, seller_signed_document_url, parent_offer_id, current_round")
    .eq("provider_envelope_id", envelopeId)
    .maybeSingle()

  if (!matchedOffer) return
  if (matchedOffer.transaction_id) return  // already converted — idempotent
  if (matchedOffer.esign_status === "fully_signed") return  // already past this step

  // Counter case: when seller_signed_at is already set, the buyer's signature
  // landing means BOTH sides have signed → the counter is FULLY EXECUTED.
  // No separate "seller signs back" step. The combined original offer +
  // signed counter is the executed contract.
  const isCounterFullyExecuted = !!matchedOffer.seller_signed_at

  if (isCounterFullyExecuted) {
    await supabase
      .from("offers")
      .update({
        esign_status:                     "fully_signed",
        buyer_signed_at:                  now,
        fully_signed_contract_received_at: now,
        esign_completed_at:               now,
        esign_provider:                   provider,
        status:                           "accepted",
      })
      .eq("id", matchedOffer.id)
  } else {
    // Standard buyer-first path (original offer, not yet seller-countered):
    // mark buyer side as signed; seller side still pending the agent's
    // forward-and-await workflow.
    await supabase
      .from("offers")
      .update({
        esign_status:    "partially_signed",
        buyer_signed_at: now,
        esign_provider:  provider,
      })
      .eq("id", matchedOffer.id)
  }

  // Activity for the agent's queue (left feed) + notification for the bell.
  // matchedOffer.agent_id holds agents.id which is what activities.agent_id FKs.
  // The notification bell, by contrast, targets users.id — we resolve it via
  // the agents table join so both surfaces fire together.
  const agentId = (matchedOffer.agent_id as string | null) ?? null
  if (agentId) {
    const { data: activityRow } = await supabase.from("activities").insert({
      brokerage_id:  matchedOffer.brokerage_id,
      agent_id:      agentId,           // agents(id) FK
      contact_id:    matchedOffer.contact_id,
      entity_type:   "offer",
      activity_type: isCounterFullyExecuted
                       ? "buyer.offer.counter.fully_executed"
                       : "buyer.offer.buyer_signed",
      title:         isCounterFullyExecuted
                       ? "Counter fully executed — both sides signed"
                       : "Buyer signed the offer",
      description:   isCounterFullyExecuted
                       ? `Buyer signed counter envelope ${envelopeId} via ${provider}. Seller already signed (${matchedOffer.seller_signed_at}). Counter is fully executed — review and submit to compliance.`
                       : `Buyer signed envelope ${envelopeId} via ${provider}. Forward to listing agent and await seller response.`,
      notes:         JSON.stringify({ offer_id: matchedOffer.id, envelopeId, provider, signed_at: now, counter_fully_executed: isCounterFullyExecuted }),
      metadata:      { offer_id: matchedOffer.id, envelopeId, provider, signed_at: now, counter_fully_executed: isCounterFullyExecuted },
      status:        "completed",
      priority:      "high",
    }).select("id").maybeSingle()

    // Resolve agents.id → users.id for the notification recipient
    const { data: agentRow } = await supabase
      .from("agents")
      .select("user_id")
      .eq("id", agentId)
      .maybeSingle()

    if (agentRow?.user_id) {
      await notifyEsignSigned(supabase, {
        brokerageId:  matchedOffer.brokerage_id as string,
        agentUserId:  agentRow.user_id as string,
        offerId:      matchedOffer.id as string,
        envelopeId,
        provider,
        activityId:   activityRow?.id ?? null,
      })
    }
  }

  // Pull every signed document from the provider into our `documents` table
  // so the deal file is complete + the executed contract is downloadable from
  // Supabase storage. Each downloaded PDF fires the classifier (signed_contract /
  // counter_offer / addendum / disclosure / etc.) and links to offer + contact
  // (+ transaction when present).
  try {
    await downloadSignedPackage(supabase, {
      envelopeId,
      provider,
      matchedOffer: {
        id:             matchedOffer.id as string,
        brokerage_id:   matchedOffer.brokerage_id as string,
        contact_id:     (matchedOffer.contact_id as string | null) ?? null,
        agent_id:       (matchedOffer.agent_id   as string | null) ?? null,
        transaction_id: (matchedOffer.transaction_id as string | null) ?? null,
      },
    })
  } catch (err: any) {
    console.error("[finalize-packet] downloadSignedPackage failed (non-fatal):", err?.message ?? err)
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
    // Listing agreement signed → "coming soon" (pre-listing), NOT live-on-MLS.
    // Run through the KERNEL (service client — webhooks have no session) so the
    // LISTING_AGREEMENT_SIGNED event + automation fire. MLS_ACTIVE is set later
    // by the execution engine. Guard to pre-signature stages (no regression).
    const { data: listingRow } = await supabase
      .from("listings")
      .select("lifecycle_stage, brokerage_id")
      .eq("id", matchedAgreement.listing_id)
      .maybeSingle()
    if (listingRow?.brokerage_id && ["LEAD", "LISTING_AGREEMENT_INITIATED"].includes((listingRow as any).lifecycle_stage)) {
      await transitionLifecycle({
        brokerageId: (listingRow as any).brokerage_id,
        entityType:  "listing_stage_machine",
        entityId:    matchedAgreement.listing_id,
        fromState:   (listingRow as any).lifecycle_stage,
        toState:     "LISTING_AGREEMENT_SIGNED",
        actorUserId: null,
        eventType:   "listing_agreement_signed",
        metadata:    { agreementId: matchedAgreement.id, envelopeId, source: "webhook" },
      }, supabase)
      await supabase
        .from("listings")
        .update({ status: "coming_soon", stage_entered_at: now })
        .eq("id", matchedAgreement.listing_id)
    }
  }

  return {
    legacy_offers:   matchedOffer ? 1 : 0,
    legacy_listings: matchedAgreement ? 1 : 0,
  }
}
