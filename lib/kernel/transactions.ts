/**
 * lib/kernel/transactions.ts
 *
 * Transaction OS — Offer-to-Transaction Compliance Bridge.
 *
 * Business rule (enforced here and nowhere else):
 *   A transaction is created ONLY when the offer is accepted AND compliance passes.
 *   If accepted but not compliant → explicit HOLD state. No silent stranded offers.
 *
 * Column contracts (live schema):
 *   offers:        contact_id (not buyer_id), offer_price, responded_at (not accepted_at)
 *   transactions:  purchase_price (not contract_price), buyer_contact_id, compliance_passed_at
 *   activities:    buyer.offer.compliance.passed (compliance gate signal)
 *
 * No 'use server' — this is a library module, not a Server Action entrypoint.
 * Every function returns { success, error?, data? } — never throws.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent }         from "@/lib/kernel/events"
import { processKernelEvent }  from "@/lib/kernel/notification-engine"
import { isValidUUID }         from "@/lib/validations"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface KernelTxResult<T = unknown> {
  success:    boolean
  error?:     string
  data?:      T
}

export interface OfferComplianceState {
  offerId:              string
  passed:               boolean
  complianceEventId?:   string
  complianceTimestamp?: string
  holdReason?:          string
}

export interface AcceptOfferConditionallyInput {
  offerId:     string
  agentId:     string
  brokerageId: string
  listingId:   string
}

export interface AcceptOfferConditionallyResult {
  offerId:       string
  accepted:      boolean
  complianceState: OfferComplianceState
  /** Populated only when compliance passes and transaction is created. */
  transactionId?: string
  holdReason?:    string
}

export interface CreateTransactionInput {
  offerId:            string
  brokerageId:        string
  agentId:            string
  listingId:          string
  contactId:          string
  offerPrice:         number
  closingDate?:       string
  compliancePassedAt: string
  contractDate:       string
  inspectionPeriodDays?:   number
  financingContingencyDays?: number
  appraisalContingencyDays?: number
  earnestMoney?:      number
}

export interface SeedMilestonesInput {
  transactionId: string
  brokerageId:   string
  contractDate:  string
  contractTerms: {
    closingDate?:        string
    inspectionDeadline?: string
    appraisalDeadline?:  string
    financingDeadline?:  string
    earnestMoneyDue?:    string
  }
}

// ─── HELPER: emit lifecycle_events + kernel notification ──────────────────────

async function emitTransactionEvent(params: {
  event:       KernelEvent
  brokerageId: string
  entityId:    string
  actorUserId: string
  metadata?:   Record<string, unknown>
}): Promise<void> {
  const supabase = createServiceClient()
  const { event, brokerageId, entityId, actorUserId, metadata } = params

  await supabase.from("lifecycle_events").insert({
    brokerage_id:  brokerageId,
    entity_type:   "transaction",
    entity_id:     entityId,
    event_type:    event,
    actor_user_id: actorUserId,
    metadata:      metadata ?? {},
  }).catch(() => {})

  await processKernelEvent({
    event,
    brokerageId,
    entityType: "transaction",
    entityId,
  }).catch(() => {})
}

// ─── 1. EVALUATE OFFER COMPLIANCE ────────────────────────────────────────────
/**
 * Checks whether a compliance.passed activity exists for the offer.
 * Source of truth: activities table, entity_type='offer', entity_id=offerId,
 * activity_type='buyer.offer.compliance.passed'.
 *
 * Does NOT accept/reject the offer — read-only.
 */
export async function evaluateOfferCompliance(
  offerId: string
): Promise<KernelTxResult<OfferComplianceState>> {
  if (!isValidUUID(offerId)) {
    return { success: false, error: "Invalid offer ID" }
  }

  const supabase = createServiceClient()

  const { data: event, error } = await supabase
    .from("activities")
    .select("id, created_at")
    .eq("entity_type", "offer")
    .eq("entity_id", offerId)
    .eq("activity_type", "buyer.offer.compliance.passed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return { success: false, error: error.message }

  const state: OfferComplianceState = {
    offerId,
    passed:               !!event,
    complianceEventId:    event?.id,
    complianceTimestamp:  event?.created_at ?? undefined,
    holdReason:           event
      ? undefined
      : "Offer has not passed compliance review (buyer.offer.compliance.passed not found)",
  }

  return { success: true, data: state }
}

// ─── 2. ACCEPT OFFER CONDITIONALLY ───────────────────────────────────────────
/**
 * The canonical acceptance gate:
 *   1. Runs evaluateOfferCompliance().
 *   2. If NOT compliant → writes hold state, returns blockerType='compliance_hold'.
 *   3. If compliant → marks offer accepted + creates transaction shell.
 *
 * Rule: offer.status is ONLY written to 'accepted' from this function.
 * Rule: transaction is ONLY created from createTransactionFromCompliantAcceptedOffer().
 */
export async function acceptOfferConditionally(
  params: AcceptOfferConditionallyInput
): Promise<KernelTxResult<AcceptOfferConditionallyResult>> {
  const { offerId, agentId, brokerageId, listingId } = params

  if (!isValidUUID(offerId) || !isValidUUID(agentId)) {
    return { success: false, error: "Invalid IDs" }
  }

  // Step 1: Compliance gate
  const complianceResult = await evaluateOfferCompliance(offerId)
  if (!complianceResult.success || !complianceResult.data) {
    return { success: false, error: complianceResult.error ?? "Compliance check failed" }
  }

  const complianceState = complianceResult.data

  if (!complianceState.passed) {
    // Write hold state to transaction_compliance_log so it is visible in UI
    const supabase = createServiceClient()
    await supabase.from("transaction_compliance_log").insert({
      brokerage_id:   brokerageId,
      check_type:     "offer_acceptance_gate",
      check_label:    "Compliance Bridge — Offer Acceptance Blocked",
      status:         "blocked",
      failure_reason: complianceState.holdReason ?? "compliance.passed event not found",
      is_blocking:    true,
      checked_at:     new Date().toISOString(),
      created_at:     new Date().toISOString(),
    }).catch(() => {})

    return {
      success: true,   // not a system error — a business hold
      data: {
        offerId,
        accepted:        false,
        complianceState,
        holdReason:      complianceState.holdReason,
      },
    }
  }

  // Step 2: Accept the offer (write to DB)
  const supabase = createServiceClient()

  const { error: acceptError } = await supabase
    .from("offers")
    .update({
      status:           "accepted",
      responded_at:     new Date().toISOString(),
      is_winning_offer: true,
      winning_offer:    true,
      updated_at:       new Date().toISOString(),
    })
    .eq("id", offerId)

  if (acceptError) return { success: false, error: acceptError.message }

  // Reject all other pending/countered offers on same listing
  await supabase
    .from("offers")
    .update({
      is_winning_offer: false,
      winning_offer:    false,
      updated_at:       new Date().toISOString(),
    })
    .eq("listing_id", listingId)
    .neq("id", offerId)

  // Step 3: Create transaction
  const { data: offerRow } = await supabase
    .from("offers")
    .select("contact_id, offer_price, closing_date, inspection_period_days, financing_contingency_days, appraisal_contingency_days, earnest_money, earnest_money_amount")
    .eq("id", offerId)
    .maybeSingle()

  if (!offerRow) return { success: false, error: "Offer data unavailable after acceptance" }

  const contractDate = new Date().toISOString().split("T")[0]
  const txResult = await createTransactionFromCompliantAcceptedOffer({
    offerId,
    brokerageId,
    agentId,
    listingId,
    contactId:          (offerRow as any).contact_id,
    offerPrice:         (offerRow as any).offer_price,
    closingDate:        (offerRow as any).closing_date ?? undefined,
    compliancePassedAt: complianceState.complianceTimestamp ?? new Date().toISOString(),
    contractDate,
    inspectionPeriodDays:    (offerRow as any).inspection_period_days ?? undefined,
    financingContingencyDays: (offerRow as any).financing_contingency_days ?? undefined,
    appraisalContingencyDays: (offerRow as any).appraisal_contingency_days ?? undefined,
    earnestMoney:       (offerRow as any).earnest_money ?? (offerRow as any).earnest_money_amount ?? undefined,
  })

  if (!txResult.success) {
    // Hard rollback — revert offer status so it is not stranded
    await supabase
      .from("offers")
      .update({ status: "submitted", responded_at: null, is_winning_offer: false, winning_offer: false, updated_at: new Date().toISOString() })
      .eq("id", offerId)
    return { success: false, error: `Transaction creation failed — acceptance rolled back: ${txResult.error}` }
  }

  return {
    success: true,
    data: {
      offerId,
      accepted:        true,
      complianceState,
      transactionId:   txResult.data?.transactionId,
    },
  }
}

// ─── 3. CREATE TRANSACTION FROM COMPLIANT ACCEPTED OFFER ─────────────────────
/**
 * Creates the transaction shell. Only called from acceptOfferConditionally().
 * Delegates to lib/transactions/offer-bridge.ts for milestone seeding.
 *
 * Rule: compliance_passed_at must be provided — enforces the contract gate.
 * Rule: Does NOT call offer-bridge.ts buyer_agents join (removed in Task 1).
 */
export async function createTransactionFromCompliantAcceptedOffer(
  params: CreateTransactionInput
): Promise<KernelTxResult<{ transactionId: string }>> {
  const { offerId, brokerageId, agentId, listingId, contactId,
          offerPrice, closingDate, compliancePassedAt, contractDate,
          inspectionPeriodDays, financingContingencyDays, appraisalContingencyDays, earnestMoney } = params

  if (!compliancePassedAt) {
    return { success: false, error: "compliance_passed_at required to create transaction (compliance bridge gate)" }
  }
  if (!contractDate) {
    return { success: false, error: "contract_date required to create transaction" }
  }

  try {
    const { createTransactionFromOffer } = await import("@/lib/transactions/offer-bridge")
    const result = await createTransactionFromOffer({
      offerId,
      brokerageId,
      contractDate,
      compliancePassedAt,
      contractTerms: {
        closingDate,
        inspectionDeadline: inspectionPeriodDays
          ? new Date(Date.now() + inspectionPeriodDays * 86400000).toISOString().split("T")[0]
          : undefined,
        financingDeadline: financingContingencyDays
          ? new Date(Date.now() + financingContingencyDays * 86400000).toISOString().split("T")[0]
          : undefined,
        appraisalDeadline: appraisalContingencyDays
          ? new Date(Date.now() + appraisalContingencyDays * 86400000).toISOString().split("T")[0]
          : undefined,
        earnestMoneyDue: earnestMoney
          ? new Date(Date.now() + 3 * 86400000).toISOString().split("T")[0]
          : undefined,
      },
    })

    if (!result.transactionId) {
      return { success: false, error: "offer-bridge did not return a transactionId" }
    }

    // Write compliance log entry confirming bridge succeeded
    const supabase = createServiceClient()
    await supabase.from("transaction_compliance_log").insert({
      brokerage_id:   brokerageId,
      transaction_id: result.transactionId,
      check_type:     "offer_acceptance_gate",
      check_label:    "Compliance Bridge — Transaction Created",
      status:         "passed",
      is_blocking:    false,
      checked_at:     new Date().toISOString(),
      created_at:     new Date().toISOString(),
    }).catch(() => {})

    return { success: true, data: { transactionId: result.transactionId } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─── 4. SEED TRANSACTION MILESTONES ─────────────────────────────────────────
/**
 * Seeds milestones from the brokerage default template.
 * Called by offer-bridge internally, but exposed here for idempotent retry.
 * Guards against duplicate seeding: checks if milestones already exist first.
 */
export async function seedTransactionMilestones(
  params: SeedMilestonesInput
): Promise<KernelTxResult<{ count: number }>> {
  const { transactionId, brokerageId, contractDate, contractTerms } = params
  if (!isValidUUID(transactionId)) return { success: false, error: "Invalid transaction ID" }

  const supabase = createServiceClient()

  // Idempotency guard — don't re-seed if milestones already exist
  const { count } = await supabase
    .from("transaction_milestones")
    .select("id", { count: "exact", head: true })
    .eq("transaction_id", transactionId)
    .then(r => ({ count: r.count ?? 0 }))

  if (count > 0) {
    return { success: true, data: { count } }
  }

  // Load default brokerage template
  const { data: template } = await supabase
    .from("transaction_milestone_templates")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("is_default", true)
    .maybeSingle()

  if (!template?.id) {
    return { success: true, data: { count: 0 } }  // no template configured — not an error
  }

  const { data: items } = await supabase
    .from("milestone_template_items")
    .select("title, description, milestone_type, days_from_contract")
    .eq("template_id", template.id)

  if (!items?.length) return { success: true, data: { count: 0 } }

  const baseDate = new Date(contractDate)
  const rows = items.map(item => ({
    transaction_id:    transactionId,
    brokerage_id:      brokerageId,
    title:             item.title,
    milestone_name:    item.title,
    description:       item.description ?? null,
    milestone_type:    item.milestone_type ?? null,
    target_date:       item.days_from_contract
      ? new Date(baseDate.getTime() + item.days_from_contract * 86400000).toISOString().split("T")[0]
      : null,
    is_client_visible: false,
    status:            "pending",
    created_at:        new Date().toISOString(),
  }))

  const { error } = await supabase.from("transaction_milestones").insert(rows)
  if (error) return { success: false, error: error.message }

  return { success: true, data: { count: rows.length } }
}

// ─── 5. LINK OFFER TO TRANSACTION ────────────────────────────────────────────
/**
 * Back-links an offer to a transaction after creation.
 * Idempotent: no-op if offer.transaction_id is already set.
 */
export async function linkOfferToTransaction(params: {
  offerId:       string
  transactionId: string
}): Promise<KernelTxResult<{ linked: boolean }>> {
  const { offerId, transactionId } = params
  if (!isValidUUID(offerId) || !isValidUUID(transactionId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  const { data: offer } = await supabase
    .from("offers")
    .select("id, transaction_id")
    .eq("id", offerId)
    .maybeSingle()

  if (!offer) return { success: false, error: "Offer not found" }
  if ((offer as any).transaction_id) return { success: true, data: { linked: false } }  // already linked

  const { error } = await supabase
    .from("offers")
    .update({ transaction_id: transactionId, updated_at: new Date().toISOString() })
    .eq("id", offerId)

  if (error) return { success: false, error: error.message }
  return { success: true, data: { linked: true } }
}

// ─── 6. EMIT OFFER ACCEPTED EVENT ────────────────────────────────────────────
/**
 * Emits OFFER_ACCEPTED lifecycle event + kernel notification.
 * Called after offer status is written to 'accepted'.
 */
export async function emitOfferAcceptedEvent(params: {
  offerId:      string
  listingId:    string
  brokerageId:  string
  agentId:      string
  offerPrice:   number
}): Promise<KernelTxResult<void>> {
  const { offerId, listingId, brokerageId, agentId, offerPrice } = params

  try {
    await emitTransactionEvent({
      event:       KernelEvent.OFFER_ACCEPTED,
      brokerageId,
      entityId:    offerId,
      actorUserId: agentId,
      metadata:    { listing_id: listingId, offer_price: offerPrice },
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─── 7. EMIT TRANSACTION INITIATED EVENT ─────────────────────────────────────
/**
 * Emits TRANSACTION_CREATED (or LISTING_UNDER_CONTRACT) lifecycle event.
 * Called after transaction shell is created.
 */
export async function emitTransactionInitiatedEvent(params: {
  transactionId: string
  offerId:       string
  listingId:     string
  brokerageId:   string
  agentId:       string
}): Promise<KernelTxResult<void>> {
  const { transactionId, offerId, listingId, brokerageId, agentId } = params

  try {
    await emitTransactionEvent({
      event:       KernelEvent.LISTING_UNDER_CONTRACT,
      brokerageId,
      entityId:    transactionId,
      actorUserId: agentId,
      metadata:    { offer_id: offerId, listing_id: listingId, source: "compliance_bridge" },
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─── LOAD COMPLIANCE BRIDGE STATUS (for UI) ───────────────────────────────────
/**
 * Single read to power the ComplianceBridgePanel UI:
 *   - offer status
 *   - compliance state
 *   - linked transaction (if any)
 *   - blocking log entries
 */
export async function loadComplianceBridgeStatus(offerId: string): Promise<KernelTxResult<{
  offerStatus:     string | null
  complianceState: OfferComplianceState
  transactionId:   string | null
  transactionStatus: string | null
  blockerEntries:  Array<{ id: string; failure_reason: string | null; checked_at: string | null }>
}>> {
  if (!isValidUUID(offerId)) return { success: false, error: "Invalid offer ID" }

  const supabase = createServiceClient()

  const [offerResult, complianceResult, blockerResult] = await Promise.all([
    supabase
      .from("offers")
      .select("id, status, transaction_id")
      .eq("id", offerId)
      .maybeSingle(),

    evaluateOfferCompliance(offerId),

    supabase
      .from("transaction_compliance_log")
      .select("id, failure_reason, checked_at")
      .eq("check_type", "offer_acceptance_gate")
      .eq("status", "blocked")
      .order("checked_at", { ascending: false })
      .limit(5),
  ])

  const offer        = offerResult.data
  const compState    = complianceResult.data ?? { offerId, passed: false }
  const blockers     = blockerResult.data ?? []
  const txId         = (offer as any)?.transaction_id ?? null

  let transactionStatus: string | null = null
  if (txId) {
    const { data: tx } = await supabase
      .from("transactions")
      .select("status")
      .eq("id", txId)
      .maybeSingle()
    transactionStatus = (tx as any)?.status ?? null
  }

  return {
    success: true,
    data: {
      offerStatus:      (offer as any)?.status ?? null,
      complianceState:  compState,
      transactionId:    txId,
      transactionStatus,
      blockerEntries:   blockers,
    },
  }
}
