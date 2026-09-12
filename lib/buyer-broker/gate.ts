/**
 * Buyer Broker Agreement (BBA) gate — NAR August 2024 settlement.
 *
 * Per NAR's Real Estate Buyer Agency Agreement requirement, a SIGNED BBA
 * must exist before the buyer is shown property or before an offer is
 * drafted on their behalf.
 *
 * This module is the single canonical gate. Callers:
 *   - app/actions/showings.ts:requestShowing
 *   - app/actions/buyer-offer/create-offer.ts:createBuyerOffer
 *
 * Fails CLOSED on errors — better to block a legitimate showing than to
 * expose the brokerage to a $5K–$50K NAR violation.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface BBAGateResult {
  /** false = caller MUST NOT proceed with the showing/offer */
  allowed:        boolean
  reason?:        string
  agreementId?:   string
  agreementType?: "exclusive" | "non_exclusive" | "showing_only" | "open"
  expiresAt?:     string | null
  /** When false, a NAR violation would occur if caller proceeds */
  narCompliant:   boolean
}

/**
 * Check whether a buyer has an ACTIVE BBA with the given agent.
 *
 * Returns allowed=true only when:
 *   - row exists in buyer_broker_agreements with status='active'
 *   - signed_at is not null
 *   - expiration_date is null OR in the future
 *   - matches the agent_id (or agent_id is null in showing_only/open scope)
 *
 * Buyer can have BBAs with multiple agents simultaneously, but each
 * (buyer, agent) pair is unique-active by index.
 */
export async function requireActiveBBA(params: {
  buyerContactId:   string
  agentId:          string
  /** When provided, also ensures the BBA was issued by this brokerage. */
  brokerageId?:     string
  /** When true, allow showing_only or open agreement types. */
  showingOnly?:     boolean
}): Promise<BBAGateResult> {
  if (!params.buyerContactId || !params.agentId) {
    return { allowed: false, reason: "buyer or agent id missing", narCompliant: false }
  }

  try {
    const svc = createServiceClient()
    let q = svc
      .from("buyer_broker_agreements")
      .select("id, agreement_type, expiration_date, signed_at, status, brokerage_id")
      .eq("buyer_contact_id", params.buyerContactId)
      .eq("agent_id", params.agentId)
      .eq("status", "active")
      .not("signed_at", "is", null)

    if (params.brokerageId) q = q.eq("brokerage_id", params.brokerageId)

    const { data, error } = await q.maybeSingle()
    if (error) {
      console.error("[bba-gate] read failed:", error)
      return { allowed: false, reason: "BBA verification failed (read error)", narCompliant: false }
    }
    if (!data) {
      return {
        allowed:      false,
        reason:       "No active buyer broker agreement signed with this agent. NAR 2024 settlement requires a signed BBA before showings or offers.",
        narCompliant: false,
      }
    }

    // Expiration check (date comparison, not timestamp — BBAs expire end-of-day)
    if (data.expiration_date) {
      const today = new Date().toISOString().slice(0, 10)
      if (data.expiration_date < today) {
        return {
          allowed:      false,
          reason:       `BBA expired on ${data.expiration_date} — needs renewal before further showings/offers.`,
          narCompliant: false,
          agreementId:  data.id as string,
          expiresAt:    data.expiration_date,
        }
      }
    }

    return {
      allowed:       true,
      agreementId:   data.id as string,
      agreementType: data.agreement_type as BBAGateResult["agreementType"],
      expiresAt:     data.expiration_date,
      narCompliant:  true,
    }
  } catch (err: any) {
    console.error("[bba-gate] exception:", err)
    return { allowed: false, reason: "BBA verification failed", narCompliant: false }
  }
}

// TOMBSTONE (orphan tranche 3): getActiveBBASummary deleted — a non-blocking
// read variant no surface called. The live survivors split its job more
// completely: requireActiveBBA above is the blocking gate (wired from
// showings, self-book, voice tools and the AI-ISA converter), and
// app/actions/buyer-broker-agreements.ts:getBBAForBuyerAction is the UI read
// (wired from app/components/contact/buyer-broker-agreement-panel.tsx),
// returning the FULL agreement history — active state included — where this
// summary returned a single trimmed row.
