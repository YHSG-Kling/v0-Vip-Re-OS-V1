import { createServiceClient } from "@/lib/supabase/service"
import { ensureRequiredMilestones } from "./milestone-service"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { populateInitialParticipants } from "./participant-populator"

/**
 * Create transaction from accepted offer
 * Enforces: contract_date + compliance_passed_at gates
 */
export async function createTransactionFromOffer(params: {
  offerId: string
  brokerageId: string
  contractDate: string
  compliancePassedAt: string
  contractTerms: {
    earnestMoneyDue?: string
    inspectionDeadline?: string
    appraisalDeadline?: string
    financingDeadline?: string
    closingDate?: string
  }
}) {
  const supabase = createServiceClient()
  
  // Validate gates
  if (!params.contractDate) {
    throw new Error("[offer-bridge] contract_date required to create transaction")
  }
  
  if (!params.compliancePassedAt) {
    throw new Error("[offer-bridge] compliance_passed_at required to create transaction")
  }
  
  // Get offer details.
  // NOTE: buyer_agents table does NOT exist — use offer.agent_id directly.
  //       offer.buyer_id does NOT exist — live FK is offer.contact_id.
  // Also pull esign_provider + provider_envelope_id so we can stamp the transaction
  // with the canonical external-provider tracking columns (m106). Without this,
  // sync-from-provider can't pull documents for transactions whose provider isn't
  // Dotloop (which is the only one with a dedicated legacy column).
  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select("id, agent_id, contact_id, listing_id, offer_price, closing_date, property_address, earnest_money, earnest_money_due_at, earnest_money_due_days, esign_provider, provider_envelope_id")
    .eq("id", params.offerId)
    .maybeSingle()

  if (offerError || !offer) {
    throw new Error(`[offer-bridge] Offer not found: ${params.offerId}`)
  }

  // Resolve property address + seller_contact_id from listing if available
  let resolvedAddress = (offer as any).property_address ?? null
  let sellerContactId: string | null = null
  if ((offer as any).listing_id) {
    const { data: listing } = await supabase
      .from("listings")
      .select("address, city, state, seller_contact_id")
      .eq("id", (offer as any).listing_id)
      .maybeSingle()
    if (listing) {
      if (!resolvedAddress) {
        resolvedAddress = [listing.address, listing.city, listing.state].filter(Boolean).join(", ")
      }
      sellerContactId = (listing as any).seller_contact_id ?? null
    }
  }

  // Create transaction — use contact_id (not buyer_id) and agent_id (not buyer_agents join)
  // deal_name is NOT NULL on transactions; default to property_address (or
  // a synthetic name from offer id if address is somehow missing) so the
  // chain never fails the insert.
  const dealName = resolvedAddress
    ?? `Transaction ${params.offerId.slice(0, 8)}`
  const { data: transaction, error: txnError } = await supabase
    .from("transactions")
    .insert({
      brokerage_id:         params.brokerageId,
      agent_id:             (offer as any).agent_id,
      contact_id:           (offer as any).contact_id,   // live FK (not buyer_id)
      buyer_contact_id:     (offer as any).contact_id,
      seller_contact_id:    sellerContactId,             // resolved from listing → enables seller-side close logic
      listing_id:           (offer as any).listing_id ?? null,
      offer_id:             params.offerId,
      deal_name:            dealName,
      property_address:     resolvedAddress,
      // Schema CHECK: deal_type ∈ {buyer, seller, dual}. Voice-cockpit + manual
      // offers create the BUYER side of the transaction; "purchase" was the
      // pre-existing value here and never matched the constraint.
      deal_type:            "buyer",
      purchase_price:       (offer as any).offer_price,
      contract_date:        params.contractDate,
      compliance_passed_at: params.compliancePassedAt,
      stage:                "UNDER_CONTRACT",
      status:               "under_contract",
      // m106 — generic provider tracking inherited from the source offer's envelope so
      // sync-from-provider can pull documents for this transaction regardless of
      // which provider the brokerage uses. Dotloop transactions also keep their
      // legacy dotloop_loop_id via the back-link from ai-offer-creation, but the
      // generic columns are now the single source of truth.
      external_provider_source:         (offer as any).esign_provider       ?? null,
      external_provider_transaction_id: (offer as any).provider_envelope_id ?? null,
      created_at:           new Date().toISOString(),
    })
    .select()
    .single()
  
  if (txnError || !transaction) {
    throw new Error(`[offer-bridge] Failed to create transaction: ${txnError?.message}`)
  }
  
  // Log contract date set event via kernel
  await transitionLifecycle({
    brokerageId: params.brokerageId,
    entityType:  "transaction",
    entityId:    transaction.id,
    fromState:   "offer_accepted",
    toState:     "UNDER_CONTRACT",
    actorUserId: "",
    actorRole:   "tc",
    eventType:   "contract_date.set",
    metadata:    {
      contract_date:       params.contractDate,
      compliance_passed_at: params.compliancePassedAt,
      created_from_offer:  params.offerId,
    },
  })
  
  // Earnest-money due date + title company come from the compliance review gate's contract read:
  // offers.earnest_money_due_at is the scanner-resolved calendar date (contract_date +
  // earnest_money_due_days); the title/escrow company is extracted onto the scanned signed contract
  // (documents.extracted_fields.title_company). These feed both the EMD milestone date and the
  // proactive "under contract" portal card.
  // TZ-safe: derive the calendar due date from the execution (contract) date + "N days from
  // execution" via pure UTC date arithmetic — NOT new Date(timestamptz).toISOString(), which would
  // shift a money-sensitive deadline by a day for non-UTC stored times. Fall back to the stored
  // value's literal date portion, then to any caller-provided term.
  const dueDays = (offer as any).earnest_money_due_days as number | null
  const earnestDueDate: string | undefined =
    (params.contractDate && typeof dueDays === "number")
      ? addDaysToDateString(params.contractDate.split("T")[0], dueDays)
      : (offer as any).earnest_money_due_at
        ? String((offer as any).earnest_money_due_at).slice(0, 10)
        : params.contractTerms.earnestMoneyDue ?? undefined
  let titleCompany: string | null = null
  try {
    const { data: doc } = await supabase
      .from("documents")
      .select("extracted_fields")
      .eq("contact_id", (offer as any).contact_id)
      .eq("classification", "signed_contract")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    titleCompany = ((doc?.extracted_fields as any)?.title_company as string) ?? null
  } catch { /* title company is best-effort enrichment */ }

  // ensureRequiredMilestones looks up dates by snake_case milestone_name key
  // e.g. contractTerms["closing_date"], contractTerms["inspection_deadline"]
  // Normalise camelCase keys from the offer bridge params before passing in
  const normalisedTerms: Record<string, string> = {}
  const { closingDate, inspectionDeadline, appraisalDeadline, financingDeadline } = params.contractTerms
  if (closingDate)        normalisedTerms["closing_date"]        = closingDate
  if (inspectionDeadline) normalisedTerms["inspection_deadline"] = inspectionDeadline
  if (appraisalDeadline)  normalisedTerms["appraisal_deadline"]  = appraisalDeadline
  if (financingDeadline)  normalisedTerms["financing_deadline"]  = financingDeadline
  if (earnestDueDate)     normalisedTerms["earnest_money_due"]   = earnestDueDate

  await ensureRequiredMilestones(
    transaction.id,
    params.brokerageId,
    normalisedTerms
  )
  
  // Back-link the offer to the created transaction
  await supabase
    .from("offers")
    .update({ transaction_id: transaction.id, updated_at: new Date().toISOString() })
    .eq("id", params.offerId)

  // Create first activity — Agent task (correct location, no changes) — activity_type: transaction_started
  await supabase.from("activities").insert({
    transaction_id: transaction.id,
    brokerage_id:   params.brokerageId,
    agent_id:       (offer as any).agent_id,  // buyer_agents table does NOT exist
    activity_type:  "transaction_started",
    title:          "Transaction Created - Schedule Inspection",
    description:    "Transaction is now under contract. Next step: schedule home inspection.",
    priority:       "high",
    status:         "pending",
    created_at:     new Date().toISOString(),
  })
  
  // Client-facing "under contract" card now flows through the canonical kernel template path
  // (idempotent + buyer/seller-aware) instead of a one-off direct transparency_updates write — this
  // is the single chokepoint all four accept flows share, so emitting here gives every flow the same
  // notification + sequence-enrollment + portal card. For the seller-accept path (which also emits
  // OFFER_ACCEPTED) the portal writer's idempotency collapses the two into one card. Best-effort:
  // never break transaction creation on a fan-out failure. Contract dates surface as their own
  // milestone cards (earnest money, inspection, closing) as the deal progresses.
  try {
    const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
    const { KernelEvent } = await import("@/lib/kernel/events")
    await emitTransactionEvent({
      event:       KernelEvent.OFFER_ACCEPTED,
      brokerageId: params.brokerageId,
      entityId:    transaction.id,
      actorUserId: "",
      metadata: {
        earnest_money_due:      earnestDueDate ?? null,
        earnest_money_due_days: (offer as any).earnest_money_due_days ?? null,
        title_company:          titleCompany,
        inspection_deadline:    params.contractTerms.inspectionDeadline ?? null,
        closing_date:           params.contractTerms.closingDate ?? null,
        created_from_offer:     params.offerId,
      },
    })
  } catch (err) {
    console.error("[offer-bridge] emitTransactionEvent(OFFER_ACCEPTED) failed", err)
  }

  // Auto-populate transaction_participants from offer + listing + brokerage
  // preferred-vendor directory. Never inserts placeholders — only rows for
  // which we can resolve real names/emails. Idempotent (skips when the
  // transaction already has any participants).
  try {
    await populateInitialParticipants(supabase as any, transaction.id, params.brokerageId)
  } catch (err: any) {
    // Failure here must not roll back the transaction. The agent can still
    // populate participants manually from the transaction UI.
    console.error("[offer-bridge] populateInitialParticipants failed (non-fatal):", err?.message ?? err)
  }

  return { success: true, transactionId: transaction.id }
}

/** Add N calendar days to a "YYYY-MM-DD" date string using pure UTC arithmetic (no local-timezone
 *  drift), returning "YYYY-MM-DD". */
function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number)
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().split("T")[0]
}
