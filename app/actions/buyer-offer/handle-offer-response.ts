"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { checkCompliancePassed, syncOfferStatus } from "@/lib/buyer-offer"

interface HandleOfferResponseParams {
  offerId: string
  response: "accepted" | "rejected" | "countered"
  userId: string
  counterTerms?: Record<string, any>
  rejectionReason?: string
}

export async function handleOfferResponse(params: HandleOfferResponseParams) {
  const { offerId, response, userId, counterTerms, rejectionReason } = params

  if (!isValidUUID(offerId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  // Get offer and validate
  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select("id, contact_id, listing_id, transaction_id")
    .eq("id", offerId)
    .single()

  if (offerError || !offer) {
    return { success: false, error: "Offer not found" }
  }

  // Resolve brokerage_id once for all inserts
  const { data: agentRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", userId)
    .maybeSingle()
  const brokerageId = agentRow?.brokerage_id ?? null

  // finalTransactionId is set during the accepted path and used in the return value
  let finalTransactionId: string | null = null

  // COMPLIANCE GATE (ABSOLUTE): Must pass before acceptance
  if (response === "accepted") {
    const compliancePassed = await checkCompliancePassed(offerId)
    if (!compliancePassed) {
      // Emit block event
      await supabase.from("activities").insert({
        brokerage_id: brokerageId,
        agent_id: userId,
        contact_id: offer.contact_id,
        activity_type: "buyer.offer.block",
        title: "Offer acceptance blocked: compliance gate failed",
        description: "Cannot accept offer: compliance.passed event not found",
        notes: JSON.stringify({ offer_id: offerId, reason: "compliance_gate_failed", attempted_action: "accept_offer" }),
        status: "completed",
        entity_type: "contact",
      })

      return {
        success: false,
        error: "Cannot accept offer: compliance.passed event not found",
        blockerType: "compliance_gate"
      }
    }

    // Emit acceptance events
    await supabase.from("activities").insert([
      {
        brokerage_id: brokerageId,
        agent_id: userId,
        contact_id: offer.contact_id,
        activity_type: "buyer.offer.accepted",
        title: "Offer accepted",
        description: `Offer ${offerId} accepted`,
        notes: JSON.stringify({ offer_id: offerId }),
        status: "completed",
        entity_type: "contact",
      },
      {
        brokerage_id: brokerageId,
        agent_id: userId,
        contact_id: offer.contact_id,
        activity_type: "buyer.under_contract",
        title: "Buyer under contract",
        description: `Buyer moved to under contract status`,
        notes: JSON.stringify({ buyer_id: offer.contact_id, offer_id: offerId, listing_id: offer.listing_id, transaction_id: offer.transaction_id }),
        status: "completed",
        entity_type: "contact",
        transaction_id: offer.transaction_id ?? null,
      }
    ])

    // ── Transaction shell creation ─────────────────────────────────────────
    // If the offer has no linked transaction yet, create one now. An accepted
    // offer must never be stranded without a transaction record.
    finalTransactionId = offer.transaction_id

    if (!finalTransactionId) {
      const { data: listing } = await supabase
        .from("listings")
        .select("id, address, city, state, list_price")
        .eq("id", offer.listing_id)
        .maybeSingle()

      const { data: newTransaction, error: txErr } = await supabase
        .from("transactions")
        .insert({
          brokerage_id:     brokerageId,
          agent_id:         userId,
          buyer_contact_id: offer.contact_id,
          listing_id:       offer.listing_id ?? null,
          offer_id:         offerId,
          status:           "active",
          deal_type:        "purchase",
          deal_name:        listing?.address
            ? `${listing.address} — ${new Date().getFullYear()}`
            : `Offer ${offerId.slice(0, 8)}`,
          contract_date:    new Date().toISOString().split("T")[0],
          created_at:       new Date().toISOString(),
          updated_at:       new Date().toISOString(),
        })
        .select("id")
        .single()

      if (!txErr && newTransaction) {
        finalTransactionId = newTransaction.id

        // Back-link the offer to the new transaction
        await supabase
          .from("offers")
          .update({ transaction_id: finalTransactionId })
          .eq("id", offerId)

        // Seed default milestones from the brokerage template if one exists
        const { data: template } = await supabase
          .from("transaction_milestone_templates")
          .select("id")
          .eq("brokerage_id", brokerageId)
          .eq("is_default", true)
          .maybeSingle()

        if (template?.id) {
          const { data: items } = await supabase
            .from("milestone_template_items")
            .select("title, description, milestone_type, days_from_contract")
            .eq("template_id", template.id)

          if (items?.length) {
            const contractDate = new Date()
            await supabase
              .from("transaction_milestones")
              .insert(
                items.map((item) => ({
                  transaction_id:  finalTransactionId,
                  brokerage_id:    brokerageId,
                  title:           item.title,
                  milestone_name:  item.title,
                  description:     item.description ?? null,
                  milestone_type:  item.milestone_type ?? null,
                  target_date:     item.days_from_contract
                    ? new Date(contractDate.getTime() + item.days_from_contract * 86400000)
                        .toISOString()
                        .split("T")[0]
                    : null,
                  is_client_visible: false,
                  status:          "pending",
                }))
              )
              .catch(() => {})
          }
        }

        // Notify agent of the newly opened transaction
        if (userId) {
          await supabase
            .from("notifications")
            .insert({
              user_id:     userId,
              brokerage_id: brokerageId,
              type:         "transaction_opened",
              title:        "Transaction opened from accepted offer",
              body:         listing?.address
                ? `Accepted offer at ${listing.address}`
                : "Offer accepted — transaction created",
              entity_type:  "transaction",
              entity_id:    finalTransactionId,
            })
            .catch(() => {})
        }
      }
    }

    // Emit transaction lifecycle event using finalTransactionId
    if (finalTransactionId) {
      await supabase.from("activities").insert({
        brokerage_id:  brokerageId,
        agent_id:      userId,
        contact_id:    offer.contact_id,
        activity_type: "transaction.lifecycle.initiated",
        title:         "Transaction lifecycle initiated",
        description:   "Transaction initiated from accepted offer",
        notes: JSON.stringify({
          transaction_id: finalTransactionId,
          source:         "buyer_offer_engine",
          offer_id:       offerId,
        }),
        status:         "completed",
        entity_type:    "transaction",
        transaction_id: finalTransactionId,
      })
    }

  } else if (response === "rejected") {
    // Emit rejection event
    await supabase.from("activities").insert({
      brokerage_id: brokerageId,
      agent_id: userId,
      contact_id: offer.contact_id,
      activity_type: "buyer.offer.rejected",
      title: "Offer rejected",
      description: rejectionReason ?? `Offer ${offerId} rejected`,
      notes: JSON.stringify({ offer_id: offerId, reason: rejectionReason }),
      status: "completed",
      entity_type: "contact",
    })
  } else if (response === "countered") {
    // Emit counter event
    await supabase.from("activities").insert({
      brokerage_id: brokerageId,
      agent_id: userId,
      contact_id: offer.contact_id,
      activity_type: "buyer.offer.counter.received",
      title: "Counter offer received",
      description: `Counter offer received for offer ${offerId}`,
      notes: JSON.stringify({ offer_id: offerId, counter_terms: counterTerms }),
      status: "pending",
      entity_type: "contact",
    })
  }

  // Sync status
  await syncOfferStatus(offerId)

  return {
    success:       true,
    response,
    transactionId: finalTransactionId ?? null,
    message:       `Offer ${response}`,
  }
}
