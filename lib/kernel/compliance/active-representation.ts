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
