"use server"

/**
 * Submit a fully-executed offer to compliance review.
 *
 * This is the EXPLICIT agent trigger that gates the transaction auto-create
 * chain. No automation (not even the e-sign webhook) advances an offer past
 * this point without the agent clicking "submit to compliance" — the agent
 * is responsible for verifying the executed contract is correct before
 * compliance is logged + a transaction is created.
 *
 * Preconditions:
 *   - Offer exists in the agent's brokerage.
 *   - Buyer has signed (offers.buyer_signed_at IS NOT NULL).
 *   - Seller has accepted (offers.seller_response_type = 'accepted' AND
 *     offers.fully_signed_contract_received_at IS NOT NULL).
 *   - No prior transaction has been created (offers.transaction_id IS NULL).
 *
 * What this action does on success:
 *   1. Stamps offers.ready_for_compliance_at + offers.compliance_passed_at
 *   2. Inserts buyer.offer.compliance.passed activity (audit trail)
 *   3. Inserts buyer.offer.accepted activity (lifecycle state → ACCEPTED)
 *   4. Calls createTransactionFromOffer to create the transaction, seed
 *      milestones + deadlines, populate participants
 *
 * Returns the new transaction_id when success.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID }          from "@/lib/validations"
import { createTransactionFromOffer } from "@/lib/transactions"
import { auditOfferDocuments }       from "@/lib/compliance/required-documents"
import { scanOfferPacketCompleteness } from "@/lib/workflow/intelligence/scan-offer-packet"
import { notifyComplianceFlag }       from "@/lib/notifications/notify-helpers"

export interface SubmitToComplianceParams {
  offerId: string
  userId:  string
  /** Optional override for the contract date — defaults to today. */
  contractDate?: string
}

export interface SubmitToComplianceResult {
  success:        boolean
  transaction_id?: string
  error?:         string
  /** When refused: which brokerage-required documents are missing (blocking). */
  missing_required?: string[]
  /** When refused: which packet fields/signatures/initials are missing. */
  packet_blockers?:  Array<{ flagType: string; severity: string; title: string }>
}

export async function submitOfferToCompliance(
  params: SubmitToComplianceParams,
): Promise<SubmitToComplianceResult> {
  const { offerId, userId, contractDate } = params

  if (!isValidUUID(offerId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  // 1. Load the offer with everything we need to enforce the gate + create
  //    the transaction. Counters have parent_offer_id set + seller_signed_at
  //    rather than seller_response_type='accepted', so we accept either path
  //    to "executed contract on file".
  const { data: offer } = await supabase
    .from("offers")
    .select("id, brokerage_id, contact_id, agent_id, transaction_id, parent_offer_id, offer_type, buyer_signed_at, seller_signed_at, seller_response_type, fully_signed_contract_received_at, ready_for_compliance_at, compliance_passed_at, closing_date, inspection_period_days, appraisal_contingency_days, financing_contingency_days, earnest_money, listing_id, property_address")
    .eq("id", offerId)
    .maybeSingle()
  if (!offer) return { success: false, error: "Offer not found" }

  if (offer.transaction_id) {
    return { success: false, error: "Offer already converted to a transaction" }
  }
  if (!offer.buyer_signed_at) {
    return { success: false, error: "Buyer has not signed yet — cannot submit to compliance" }
  }

  // Two valid paths to "executed contract on file":
  //   A) Buyer-first original offer: seller_response_type='accepted' AND
  //      fully_signed_contract_received_at set (agent uploaded seller-signed PDF).
  //   B) Seller-first counter: seller_signed_at is set AND buyer signed the
  //      counter envelope (fully_signed_contract_received_at stamped by the
  //      webhook automatically when both sides signed).
  const executedViaResponse = offer.seller_response_type === "accepted" && !!offer.fully_signed_contract_received_at
  const executedViaCounter  = !!offer.seller_signed_at && !!offer.fully_signed_contract_received_at
  if (!executedViaResponse && !executedViaCounter) {
    return { success: false, error: "Executed contract not on file yet — seller hasn't accepted (record seller response) or signed counter (record seller-signed counter)" }
  }

  const now = new Date().toISOString()
  const finalContractDate = contractDate ?? now.slice(0, 10)

  // 1.5 — Pre-flight compliance gate. Two checks BEFORE we stamp anything:
  //   A) Brokerage-required documents — the broker's onboarding checklist.
  //      Resolution cascade: agent → team → brokerage. Blocking misses
  //      refuse the submit; warning misses are returned but pass through.
  //   B) Packet completeness scan — walks documents.content.filledPacket
  //      for missing signatures / initials / fields. Any blockers refuse.
  // On refusal we fan out compliance flags so the agent + TC see why.
  const { data: actingUser } = await supabase
    .from("users")
    .select("team_id")
    .eq("id", userId)
    .maybeSingle()
  const teamId = (actingUser?.team_id as string | null) ?? null

  // Resolve the property's state so the audit applies the correct state-specific
  // required documents (in-house → listing.state; outside property → parse the
  // 2-letter state from the address). Without this the audit can't scope by state.
  let stateCode: string | null = null
  if (offer.listing_id) {
    const { data: listingRow } = await supabase
      .from("listings").select("state").eq("id", offer.listing_id as string).maybeSingle()
    stateCode = (listingRow?.state as string | null) ?? null
  }
  if (!stateCode && offer.property_address) {
    const m = String(offer.property_address).match(/,\s*([A-Za-z]{2})\s*\d{5}(?:-\d{4})?\b/)
    stateCode = m ? m[1].toUpperCase() : null
  }

  const audit = await auditOfferDocuments(supabase as any, {
    offerId,
    brokerageId:  offer.brokerage_id as string,
    contactId:    offer.contact_id as string | null,
    agentUserId:  userId,
    teamId,
    dealType:     "buyer",
    stateCode,
  })

  const packetScan = await scanOfferPacketCompleteness({
    offerId,
    raiserUserId: userId,
  })

  const hasBlockingMissing = audit.missing_blocking.length > 0
  const hasPacketBlockers  = packetScan.blockers && packetScan.blockers.length > 0

  // Owner's rule: any missing item — document, signature or initial — notifies
  // the TC AND/OR the listing agent. The TC comes from the brokerage roster
  // inside notifyComplianceFlag; the two deal-specific people have to be
  // resolved here, because only this function knows the offer and its listing.
  //
  //   · the OFFER's agent — offers.agent_id is an agents.id, so it is RESOLVED
  //     to a users.id, never substituted. It differs from `userId` whenever a
  //     TC or broker submits on the agent's behalf, and in that case the agent
  //     was previously told nothing at all.
  //   · the LISTING agent — the other side of an in-house deal, who has just as
  //     much at stake in a missing seller signature.
  //
  // NOTE: no MLS number is read or required anywhere on this path. Per the
  // owner's ruling the MLS number belongs to the listing-launch checkpoint, not
  // to accepting an offer, and nothing here consults it.
  const dealRecipients: (string | null)[] = []
  if (offer.agent_id) {
    const { data: offerAgent } = await supabase
      .from("agents").select("user_id").eq("id", offer.agent_id as string).maybeSingle()
    dealRecipients.push((offerAgent?.user_id as string | null) ?? null)
  }
  if (offer.listing_id) {
    const { data: listingRow } = await supabase
      .from("listings").select("agent_id").eq("id", offer.listing_id as string).maybeSingle()
    if (listingRow?.agent_id) {
      const { data: listingAgent } = await supabase
        .from("agents").select("user_id").eq("id", listingRow.agent_id as string).maybeSingle()
      dealRecipients.push((listingAgent?.user_id as string | null) ?? null)
    }
  }

  if (hasBlockingMissing || hasPacketBlockers) {
    // Fan out a critical compliance flag so the agent + TC + compliance_officer
    // all see the unblock work clearly in their bells (high/critical severity
    // routes through multi-channel: in-app + email + SMS-on-consent).
    const summaryBits: string[] = []
    if (hasBlockingMissing) summaryBits.push(`${audit.missing_blocking.length} required document(s) missing`)
    if (hasPacketBlockers)  summaryBits.push(`${packetScan.blockers.length} packet blocker(s)`)
    await notifyComplianceFlag(supabase as any, {
      brokerageId: offer.brokerage_id as string,
      agentUserId: userId,
      alsoNotifyUserIds: dealRecipients,
      flag: {
        type:        "compliance.submit_blocked",
        severity:    "high",
        title:       `Submit to compliance blocked: ${summaryBits.join(", ")}`,
        body:        `Missing required: ${audit.missing_blocking.join(", ") || "(none)"}.\nPacket blockers: ${packetScan.blockers.slice(0, 5).map(b => b.title).join("; ") || "(none)"}.`,
        entityType:  "offer",
        entityId:    offerId,
        offerId,
      },
    })

    return {
      success: false,
      error: `Cannot submit to compliance — ${summaryBits.join(" and ")}. Fix the listed items first.`,
      missing_required: audit.missing_blocking,
      packet_blockers: packetScan.blockers.map(b => ({
        flagType: b.flagType, severity: b.severity, title: b.title,
      })),
    }
  }

  // 1.6 — WARNING-level misses still get told to somebody.
  //
  // Owner's rule is "whether or not a doc is required or a warning, any missing
  // item … needs to be a notification to the TC and/or the listing agent". Only
  // the BLOCKING path notified anyone; a settings-marked warning passed through
  // in total silence, which made the required/warning switch a choice between
  // "stops the deal" and "nobody ever hears about it".
  const warningDocs  = audit.missing_warning ?? []
  const packetWarns  = packetScan.warnings ?? []
  if (warningDocs.length > 0 || packetWarns.length > 0) {
    const warnBits: string[] = []
    if (warningDocs.length > 0) warnBits.push(`${warningDocs.length} optional document(s) missing`)
    if (packetWarns.length > 0) warnBits.push(`${packetWarns.length} packet warning(s)`)
    await notifyComplianceFlag(supabase as any, {
      brokerageId: offer.brokerage_id as string,
      agentUserId: userId,
      alsoNotifyUserIds: dealRecipients,
      flag: {
        // medium → in-app bell only. A warning must be visible without
        // becoming an email + SMS on every deal.
        type:       "compliance.submit_warnings",
        severity:   "medium",
        title:      `Submitted with warnings: ${warnBits.join(", ")}`,
        body:       `Missing (warning): ${warningDocs.join(", ") || "(none)"}.\nPacket warnings: ${packetWarns.slice(0, 5).map(w => w.title).join("; ") || "(none)"}.`,
        entityType: "offer",
        entityId:   offerId,
        offerId,
      },
    })
  }

  // 2. Stamp readiness + compliance pass on the offer.
  await supabase
    .from("offers")
    .update({
      ready_for_compliance_at: now,
      compliance_passed_at:    now,
    })
    .eq("id", offerId)

  // 3. Activities: compliance.passed + accepted. Both follow the convention
  //    used by track-offer-lifecycle.ts — offer_id stored in notes JSON.
  // activities.agent_id FKs agents(id); use agent_user_id for users(id).
  await supabase.from("activities").insert({
    brokerage_id:   offer.brokerage_id,
    agent_user_id:  userId,
    agent_id:       offer.agent_id,
    contact_id:     offer.contact_id,
    entity_type:    "offer",
    activity_type:  "buyer.offer.compliance.passed",
    title:          "Compliance gate passed",
    description:    `Agent submitted offer ${offerId} to compliance review. Executed contract on file.`,
    notes:          JSON.stringify({ offer_id: offerId, source: "agent_submit_to_compliance" }),
    metadata:       { offer_id: offerId, submitted_at: now },
    status:         "completed",
    priority:       "high",
  })

  await supabase.from("activities").insert({
    brokerage_id:   offer.brokerage_id,
    agent_user_id:  userId,
    agent_id:       offer.agent_id,
    contact_id:     offer.contact_id,
    entity_type:    "contact",
    activity_type:  "buyer.offer.accepted",
    title:          "Offer accepted — under contract",
    description:    `Offer ${offerId} is fully executed; transitioning to UNDER_CONTRACT.`,
    notes:          JSON.stringify({ offer_id: offerId, previous_state: "PENDING", new_state: "ACCEPTED", source: "agent_submit_to_compliance" }),
    status:         "completed",
  })

  // 4. Create the transaction — same canonical creator the legacy chain
  //    used. Seeds milestones + deadlines, populates participants (buyer,
  //    buyer_agent, seller, seller_agent — never lender/title/inspector).
  const fromContract = (days: number | null | undefined) =>
    days ? new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10) : undefined

  try {
    const result = await createTransactionFromOffer({
      offerId,
      brokerageId:         offer.brokerage_id as string,
      contractDate:        finalContractDate,
      compliancePassedAt:  now,
      contractTerms: {
        // earnestMoneyDue is a DATE term (milestone target), not the deposit amount —
        // passing String(offer.earnest_money) here fed "$5000" into the earnest-money
        // milestone date. Leave it unset: the bridge derives the real due date from
        // contract_date + offers.earnest_money_due_days / earnest_money_due_at.
        inspectionDeadline:  fromContract(offer.inspection_period_days as number | null),
        appraisalDeadline:   fromContract(offer.appraisal_contingency_days as number | null),
        financingDeadline:   fromContract(offer.financing_contingency_days as number | null),
        closingDate:         (offer.closing_date as string | null) ?? undefined,
      },
    })
    if (!result?.success || !result.transactionId) {
      return { success: false, error: "Transaction creation failed in offer-bridge" }
    }

    // No supersede cascade. The original offer is always the parent root and
    // stays part of the executed contract; counters AMEND it, they don't
    // replace it. The has_counter checkbox on the parent (set by
    // issueCounterOffer) is the UI signal. The compliance package reads the
    // full chain via parent_offer_id from the counter back to the original.
    return { success: true, transaction_id: result.transactionId }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Transaction creation threw" }
  }
}
