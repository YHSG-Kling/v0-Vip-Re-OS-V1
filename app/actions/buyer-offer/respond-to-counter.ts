"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { checkCompliancePassed, syncOfferStatus } from "@/lib/buyer-offer"

interface RespondToCounterParams {
  offerId: string
  response: "accept" | "reject" | "counter_back"
  userId: string
  counterTerms?: Record<string, any>
  rejectionReason?: string
}

export async function respondToCounter(params: RespondToCounterParams) {
  const { offerId, response, userId, counterTerms, rejectionReason } = params

  if (!isValidUUID(offerId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  // Get offer
  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select("id, contact_id, listing_id, transaction_id")
    .eq("id", offerId)
    .single()

  if (offerError || !offer) {
    return { success: false, error: "Offer not found" }
  }

  // Count counter rounds (max 5)
  const { data: counterEvents } = await supabase
    .from("activities")
    .select("id")
    .eq("contact_id", offer.contact_id)
    .in("activity_type", ["buyer.offer.counter.received", "buyer.offer.counter.submitted"])

  if (counterEvents && counterEvents.length >= 5 && response === "counter_back") {
    return {
      success: false,
      error: "Maximum counter rounds (5) exceeded"
    }
  }

  // Resolve brokerage_id once
  const { data: agentRowC } = await supabase.from("users").select("brokerage_id").eq("id", userId).maybeSingle()
  const brokerageIdC = agentRowC?.brokerage_id ?? null

  // COMPLIANCE GATE: Must pass before accepting counter
  if (response === "accept") {
    const compliancePassed = await checkCompliancePassed(offerId)
    if (!compliancePassed) {
      await supabase.from("activities").insert({
        brokerage_id: brokerageIdC,
        agent_id: userId,
        contact_id: offer.contact_id,
        activity_type: "buyer.offer.block",
        title: "Counter acceptance blocked: compliance gate failed",
        description: "Cannot accept counter: compliance.passed event not found",
        notes: JSON.stringify({ offer_id: offerId, reason: "compliance_gate_failed", attempted_action: "accept_counter" }),
        status: "completed",
        entity_type: "contact",
      })

      return {
        success: false,
        error: "Cannot accept counter: compliance.passed event not found",
        blockerType: "compliance_gate"
      }
    }

    // Emit counter acceptance
    await supabase.from("activities").insert([
      {
        brokerage_id: brokerageIdC,
        agent_id: userId,
        contact_id: offer.contact_id,
        activity_type: "buyer.offer.counter.accepted",
        title: "Counter offer accepted",
        description: `Counter accepted for offer ${offerId}`,
        notes: JSON.stringify({ offer_id: offerId }),
        status: "completed",
        entity_type: "contact",
      },
      {
        brokerage_id: brokerageIdC,
        agent_id: userId,
        contact_id: offer.contact_id,
        activity_type: "buyer.offer.accepted",
        title: "Offer accepted via counter",
        description: `Offer ${offerId} accepted via counter`,
        notes: JSON.stringify({ offer_id: offerId }),
        status: "completed",
        entity_type: "contact",
      },
      {
        brokerage_id: brokerageIdC,
        agent_id: userId,
        contact_id: offer.contact_id,
        activity_type: "buyer.under_contract",
        title: "Buyer under contract",
        description: "Buyer moved to under contract via counter acceptance",
        notes: JSON.stringify({ buyer_id: offer.contact_id, offer_id: offerId, transaction_id: offer.transaction_id }),
        status: "completed",
        entity_type: "contact",
        transaction_id: offer.transaction_id ?? null,
      }
    ])

    // Transaction handoff
    if (offer.transaction_id) {
      await supabase.from("activities").insert({
        brokerage_id: brokerageIdC,
        agent_id: userId,
        contact_id: offer.contact_id,
        activity_type: "transaction.lifecycle.initiated",
        title: "Transaction lifecycle initiated",
        description: "Transaction initiated from counter acceptance",
        notes: JSON.stringify({ transaction_id: offer.transaction_id, source: "buyer_offer_counter_acceptance", offer_id: offerId }),
        status: "completed",
        entity_type: "transaction",
        transaction_id: offer.transaction_id,
      })
    }
  } else if (response === "reject") {
    await supabase.from("activities").insert({
      brokerage_id: brokerageIdC,
      agent_id: userId,
      contact_id: offer.contact_id,
      activity_type: "buyer.offer.counter.rejected",
      title: "Counter offer rejected",
      description: rejectionReason ?? `Counter rejected for offer ${offerId}`,
      notes: JSON.stringify({ offer_id: offerId, reason: rejectionReason }),
      status: "completed",
      entity_type: "contact",
    })
  } else if (response === "counter_back") {
    await supabase.from("activities").insert({
      brokerage_id: brokerageIdC,
      agent_id: userId,
      contact_id: offer.contact_id,
      activity_type: "buyer.offer.counter.submitted",
      title: "Counter back submitted",
      description: `Counter back submitted for offer ${offerId}`,
      notes: JSON.stringify({ offer_id: offerId, counter_terms: counterTerms }),
      status: "pending",
      entity_type: "contact",
    })
  }

  // Sync status
  await syncOfferStatus(offerId)

  return { success: true, response }
}
