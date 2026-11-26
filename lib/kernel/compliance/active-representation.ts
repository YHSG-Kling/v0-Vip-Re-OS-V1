/**
 * lib/kernel/compliance/active-representation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * "Agreement / active deal = consent."
 *
 * A contact who has an open transaction, a signed buyer-broker agreement, a
 * fully-signed listing agreement, or a live offer has an established
 * representation relationship — the agreement itself carries the consent to
 * communicate (E-SIGN/UETA + the contact is an active client of the brokerage).
 * Both compliance gates (the kernel content gate and the dispatch suppression
 * gate) treat this as implied TCPA consent so the servicing team can always
 * reach a client who is actively in a deal, even if the standalone
 * `contacts.tcpa_consent` flag was never set.
 *
 * This is a point-lookup helper (LIMIT 1 per source, indexed) and is only
 * invoked on the block path — i.e. when the explicit consent flag is absent
 * and the channel is consent-gated (sms/phone) — so it adds no cost to the
 * common, already-consented send.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

/** Transaction statuses that mean a deal is open (not closed/lost). */
const OPEN_TRANSACTION_STATUSES = ["active", "under_contract", "closing"] as const
/** Offer statuses that mean the offer is live (not draft/rejected/withdrawn). */
const ACTIVE_OFFER_STATUSES = ["submitted", "accepted", "countered"] as const

export async function hasActiveRepresentation(
  supabase: SupabaseClient,
  contactId: string | null | undefined,
  brokerageId: string
): Promise<boolean> {
  if (!contactId) return false

  // 1. Open transaction with the contact as any party (in-house client, buyer, or seller).
  const { data: txn } = await supabase
    .from("transactions")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .in("status", OPEN_TRANSACTION_STATUSES as unknown as string[])
    .or(
      `contact_id.eq.${contactId},buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`
    )
    .limit(1)
  if (txn && txn.length > 0) return true

  // 2. Signed (active) buyer-broker agreement.
  const { data: bba } = await supabase
    .from("buyer_broker_agreements")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("buyer_contact_id", contactId)
    .eq("status", "active")
    .limit(1)
  if (bba && bba.length > 0) return true

  // 3. Fully-signed listing agreement (seller side).
  const { data: la } = await supabase
    .from("listing_agreements")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("seller_contact_id", contactId)
    .eq("esign_status", "fully_signed")
    .limit(1)
  if (la && la.length > 0) return true

  // 4. Live offer authored for this contact.
  const { data: off } = await supabase
    .from("offers")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("contact_id", contactId)
    .in("status", ACTIVE_OFFER_STATUSES as unknown as string[])
    .limit(1)
  if (off && off.length > 0) return true

  return false
}

// ═══════════════════════════════════════════════════════════════════════════
// WAVE 156 (lane 156N): A REPRESENTATION AGREEMENT SUPPORTS SERVICING, NOT MARKETING
// ═══════════════════════════════════════════════════════════════════════════
//
// The header above says "Agreement / active deal = consent", and both gates (lib/kernel/compliance.ts Gate 2 and
// lib/kernel/communication-compliance.ts RULE 6/7) applied it to EVERY sms/phone/voicemail send, whatever the send was for.
// So a fully signed listing agreement, by itself, cleared an automated CAMPAIGN text, and the dispatch-side purpose gate
// (lib/providers/dispatch.ts, CAMPAIGN_SMS_REFUSING_BASES) defers `no_record` to exactly that gate.
//
// The rule now: the representation relationship may stand in for a missing `contacts.tcpa_consent` only for SERVICING
// that representation (deadlines, showings, signatures, closing logistics; one-to-one conversation; recipient-initiated
// transactional messages). A `campaign` send is marketing and needs its own channel-specific consent evidence. Opt-outs,
// DNC and the suppression list are untouched: they block servicing too, exactly as before.
//
// An UNSTATED purpose keeps the previous behavior (servicing), because the gates cannot tell an urgent closing text from a
// drip when the caller does not say, and refusing every unstated send would cut off the servicing contact the owner asked
// to preserve. Which callers must state `campaign` is an integrator / counsel item, listed in
// docs/legal/TCPA-REPRESENTATION-CONSENT-COUNSEL-MEMO-DRAFT.md.

import type { ChannelPurpose } from "@/lib/providers/dispatch"

/** The one channel-purpose vocabulary (lib/providers/dispatch.ts ChannelPurpose), re-exported for the gates as a TYPE. */
export type RepresentationSendPurpose = ChannelPurpose

/** The purposes a representation relationship may serve as consent for. Everything not listed is marketing. */
export const REPRESENTATION_SERVICING_PURPOSES: ReadonlySet<ChannelPurpose> = new Set<ChannelPurpose>(["conversation", "update", "transactional"])

/** PURE. May an active representation stand in for missing TCPA consent for a send of this purpose? */
export function representationConsentCovers(purpose: ChannelPurpose | null | undefined): boolean {
  if (purpose === null || purpose === undefined) return true
  return REPRESENTATION_SERVICING_PURPOSES.has(purpose)
}
