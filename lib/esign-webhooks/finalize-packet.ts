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

  return {
    docs_signed: (matchedDocs ?? []).length,
    bba_signed:  matchedBBA ? 1 : 0,
    envelopeId,
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

  return {
    legacy_offers:   matchedOffer ? 1 : 0,
    legacy_listings: matchedAgreement ? 1 : 0,
  }
}
