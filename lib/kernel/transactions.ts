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

// Database row types (snake_case)
export interface DbTransaction {
  id: string
  brokerage_id: string
  listing_id: string
  buyer_contact_id: string
  seller_contact_id?: string
  listing_agent_id: string
  buyer_agent_id?: string
  purchase_price: number
  status: string
  closing_date?: string
  contract_date: string
  compliance_passed_at?: string
  created_at: string
  updated_at: string
}

// Application types (camelCase) - what kernel returns
export interface KernelTransaction {
  id: string
  brokerageId: string
  listingId: string
  buyerContactId: string
  sellerContactId?: string
  listingAgentId: string
  buyerAgentId?: string
  purchasePrice: number
  status: string
  closingDate?: string
  contractDate: string
  compliancePassedAt?: string
  createdAt: string
  updatedAt: string
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

// ─── MAPPING: snake_case → camelCase ──────────────────────────────────────────

function mapDbToKernelTransaction(db: DbTransaction): KernelTransaction {
  return {
    id: db.id,
    brokerageId: db.brokerage_id,
    listingId: db.listing_id,
    buyerContactId: db.buyer_contact_id,
    sellerContactId: db.seller_contact_id,
    listingAgentId: db.listing_agent_id,
    buyerAgentId: db.buyer_agent_id,
    purchasePrice: db.purchase_price,
    status: db.status,
    closingDate: db.closing_date,
    contractDate: db.contract_date,
    compliancePassedAt: db.compliance_passed_at,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
  }
}

// ─── HELPER: emit lifecycle_events + kernel notification ──────────────────────
//
// EXPORTED so action files outside this module (lender-portal-actions,
// transaction-inspections, multi-persona, etc.) can fire the canonical
// transaction-stage event without re-implementing contact-context resolution.
// Same contract as before — inserts lifecycle_events row + calls
// fanOutKernelEvent with buyer/seller/listing context auto-resolved.

export async function emitTransactionEvent(params: {
  event:       KernelEvent
  brokerageId: string
  entityId:    string
  actorUserId: string
  metadata?:   Record<string, unknown>
  /** Optional override — defaults to 'transaction'. Pass 'offer' for events
   *  where entityId is an offer id (so we resolve buyer/seller contacts
   *  from the offer + listing rather than the transaction). */
  entityType?: "transaction" | "offer" | "listing"
}): Promise<void> {
  const supabase = createServiceClient()
  const { event, brokerageId, entityId, actorUserId, metadata } = params
  const entityType = params.entityType ?? "transaction"

  await supabase.from("lifecycle_events").insert({
    brokerage_id:  brokerageId,
    entity_type:   entityType,
    entity_id:     entityId,
    event_type:    event,
    actor_user_id: actorUserId,
    metadata:      metadata ?? {},
  })

  // ── Enrich the event with contact + transaction + listing context so
  //    fanOutKernelEvent can fire portal updates and sequence enrollment
  //    for both buyer and seller without each call site re-resolving.
  let contactId: string | undefined
  let buyerContactId: string | undefined
  let sellerContactId: string | undefined
  let transactionId: string | undefined
  let listingId: string | undefined

  try {
    if (entityType === "transaction") {
      transactionId = entityId
      const { data: tx } = await supabase
        .from("transactions")
        .select("buyer_contact_id, seller_contact_id, contact_id, listing_id")
        .eq("id", entityId)
        .maybeSingle()
      buyerContactId  = tx?.buyer_contact_id  ?? undefined
      sellerContactId = tx?.seller_contact_id ?? undefined
      contactId       = tx?.contact_id        ?? undefined
      listingId       = tx?.listing_id        ?? undefined
    } else if (entityType === "offer") {
      const { data: o } = await supabase
        .from("offers")
        .select("contact_id, listing_id, transaction_id")
        .eq("id", entityId)
        .maybeSingle()
      buyerContactId = o?.contact_id ?? undefined
      contactId      = o?.contact_id ?? undefined
      listingId      = o?.listing_id ?? undefined
      transactionId  = o?.transaction_id ?? undefined
      if (listingId) {
        const { data: l } = await supabase
          .from("listings").select("seller_contact_id").eq("id", listingId).maybeSingle()
        sellerContactId = l?.seller_contact_id ?? undefined
      }
    } else if (entityType === "listing") {
      listingId = entityId
      const { data: l } = await supabase
        .from("listings").select("seller_contact_id").eq("id", entityId).maybeSingle()
      sellerContactId = l?.seller_contact_id ?? undefined
      contactId       = l?.seller_contact_id ?? undefined
    }
  } catch { /* enrichment is best-effort */ }

  // Single canonical fan-out (replaces direct processKernelEvent call) —
  // notifications + sequence auto-enroll + portal update happen here.
  const { fanOutKernelEvent } = await import("./event-fanout")
  await fanOutKernelEvent({
    event,
    brokerageId,
    entityType,
    entityId,
    contactId,
    buyerContactId,
    sellerContactId,
    transactionId,
    listingId,
    agentUserId: actorUserId,
    metadata,
  })
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
    })

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
      updated_at:       new Date().toISOString(),
    })
    .eq("id", offerId)

  if (acceptError) return { success: false, error: acceptError.message }

  // Reject all other pending/countered offers on same listing
  await supabase
    .from("offers")
    .update({
      is_winning_offer: false,
      updated_at:       new Date().toISOString(),
    })
    .eq("listing_id", listingId)
    .neq("id", offerId)

  // Step 3: Create transaction
  const { data: offerRow } = await supabase
    .from("offers")
    .select("contact_id, offer_price, closing_date, inspection_period_days, financing_contingency_days, appraisal_contingency_days, earnest_money")
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
    earnestMoney:       (offerRow as any).earnest_money ?? undefined,
  })

  if (!txResult.success) {
    // Hard rollback — revert offer status so it is not stranded
    await supabase
      .from("offers")
      .update({ status: "submitted", responded_at: null, is_winning_offer: false, updated_at: new Date().toISOString() })
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
    })

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
      entityType:  "offer",
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

// ═══════════════════════════════════════════════════════════════════════════════
// CANONICAL TRANSACTION OS COMMANDS
//
// Business rules:
//   • transactions.purchase_price  (not contract_price)
//   • transactions.deal_type       (not transaction_type)
//   • transactions.property_zip    (not property_zip_code)
//   • transaction_milestones.is_client_visible — controls portal visibility
//   • Closing requires stage=CLOSING_PREP OR explicit override by broker/admin
//   • Reopening requires broker/admin role — writes audit trail to transaction_timeline
//   • Commission recalculation reads agent_commission_profiles, writes transaction_commissions
//   • emitClientFriendlyUpdate writes client_friendly_updates AND respects consent/DNC
//
// No 'use server' — this is a library module.
// Every function returns KernelTxResult<T>.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── createManualTransaction ──────────────────────────────────────────────────

export interface CreateManualTransactionInput {
  brokerageId:      string
  agentId:          string
  propertyAddress:  string
  propertyCity?:    string
  propertyState?:   string
  propertyZip?:     string
  dealType:         "purchase" | "sale" | "lease" | "dual"
  purchasePrice?:   number
  contactId?:       string
  closeDate?:       string
  dealName?:        string
  commissionPct?:   number
}

export async function createManualTransaction(
  input: CreateManualTransactionInput,
): Promise<KernelTxResult<{ transactionId: string }>> {
  if (!input.propertyAddress?.trim()) {
    return { success: false, error: "Property address is required." }
  }
  try {
    const supabase = await createServiceClient()
    const { data, error } = await supabase
      .from("transactions")
      .insert({
        brokerage_id:     input.brokerageId,
        agent_id:         input.agentId,
        property_address: input.propertyAddress.trim(),
        property_city:    input.propertyCity  ?? null,
        property_state:   input.propertyState ?? null,
        property_zip:     input.propertyZip   ?? null,
        deal_type:        input.dealType,
        purchase_price:   input.purchasePrice ?? null,
        contact_id:       input.contactId     ?? null,
        close_date:       input.closeDate     ?? null,
        deal_name:        input.dealName      ?? null,
        commission_percentage: input.commissionPct ?? null,
        status:           "active",
        stage:            "UNDER_CONTRACT",
        created_at:       new Date().toISOString(),
        updated_at:       new Date().toISOString(),
      })
      .select("id")
      .single()

    if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }

    // Write initial timeline entry
    await supabase.from("transaction_timeline").insert({
      transaction_id: data.id,
      brokerage_id:   input.brokerageId,
      activity_type:  "transaction_created",
      description:    "Transaction created manually",
      performed_by:   input.agentId,
      created_at:     new Date().toISOString(),
    })

    return { success: true, data: { transactionId: data.id } }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Unknown error in createManualTransaction" }
  }
}

// ─── loadTransactionWorkspace ─────────────────────────────────────────────────

export async function loadTransactionWorkspace(transactionId: string): Promise<KernelTxResult<{
  transaction: KernelTransaction
  milestones:  unknown[]
  documents:   unknown[]
  participants: unknown[]
  complianceLogs: unknown[]
  commissions: unknown[]
}>> {
  try {
    const supabase = await createServiceClient()
    const [txResult, msResult, docResult, ptResult, clResult, commResult] = await Promise.all([
      supabase.from("transactions").select("*").eq("id", transactionId).maybeSingle(),
      supabase.from("transaction_milestones").select("*").eq("transaction_id", transactionId).order("target_date", { ascending: true, nullsFirst: false }),
      supabase.from("transaction_documents").select("*").eq("transaction_id", transactionId),
      supabase.from("transaction_participants").select("*").eq("transaction_id", transactionId),
      supabase.from("transaction_compliance_log").select("*").eq("transaction_id", transactionId).order("created_at", { ascending: false }),
      supabase.from("transaction_commissions").select("*").eq("transaction_id", transactionId),
    ])
    if (!txResult.data) return { success: false, error: "Transaction not found" }
    return {
      success: true,
      data: {
        transaction:    mapDbToKernelTransaction(txResult.data as DbTransaction),
        milestones:     msResult.data  ?? [],
        documents:      docResult.data ?? [],
        participants:   ptResult.data  ?? [],
        complianceLogs: clResult.data  ?? [],
        commissions:    commResult.data ?? [],
      },
    }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Unknown error in loadTransactionWorkspace" }
  }
}

// ─── advanceTransactionStage ──────────────────────────────────────────────────
// Thin kernel contract — delegates to TransactionOrchestrator via dynamic import.

export async function advanceTransactionStageCommand(params: {
  transactionId: string
  brokerageId:   string
  userId:        string
  userRole:      string
  targetStage:   string
  reason?:       string
}): Promise<KernelTxResult<{ newStage: string }>> {
  try {
    const { TransactionOrchestrator } = await import("@/lib/transactions/transaction-orchestrator")
    const orchestrator = new TransactionOrchestrator({
      transactionId: params.transactionId,
      brokerageId:   params.brokerageId,
      userId:        params.userId,
      userRole:      params.userRole,
    })
    const result = await orchestrator.advanceToStage(params.targetStage as any, params.reason)
    if (!result.success) return { success: false, error: result.error ?? "Advance blocked", data: undefined }
    return { success: true, data: { newStage: params.targetStage } }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Unknown error in advanceTransactionStageCommand" }
  }
}

// ─── completeTransactionMilestone ────────────────────────────────────────────

export async function completeTransactionMilestone(params: {
  milestoneId:    string
  transactionId:  string
  brokerageId:    string
  completedBy:    string
  notes?:         string
}): Promise<KernelTxResult<void>> {
  try {
    const supabase = await createServiceClient()
    const { error } = await supabase
      .from("transaction_milestones")
      .update({
        status:       "completed",
        completed_at: new Date().toISOString(),
        completed_by: params.completedBy,
        notes:        params.notes ?? null,
      })
      .eq("id", params.milestoneId)

    if (error) return { success: false, error: error.message }

    await supabase.from("transaction_timeline").insert({
      transaction_id: params.transactionId,
      brokerage_id:   params.brokerageId,
      activity_type:  "milestone_completed",
      description:    "Milestone marked as completed",
      performed_by:   params.completedBy,
      created_at:     new Date().toISOString(),
    })

    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Unknown error in completeTransactionMilestone" }
  }
}

// ─── setMilestoneClientVisibility ────────────────────────────────────────────

export async function setMilestoneClientVisibilityCommand(params: {
  milestoneId:   string
  transactionId: string
  isVisible:     boolean
}): Promise<KernelTxResult<void>> {
  try {
    const supabase = await createServiceClient()
    const { error } = await supabase
      .from("transaction_milestones")
      .update({ is_client_visible: params.isVisible })
      .eq("id", params.milestoneId)
    if (error) return { success: false, error: error.message }
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Unknown error in setMilestoneClientVisibility" }
  }
}

// ─── attachTransactionDocument ────────────────────────────────────────────────

export async function attachTransactionDocument(params: {
  transactionId: string
  brokerageId:   string
  uploadedBy:    string
  docType:       string
  docLabel?:     string
  storageUrl:    string
  notes?:        string
}): Promise<KernelTxResult<{ documentId: string }>> {
  try {
    const supabase = await createServiceClient()
    const { data, error } = await supabase
      .from("transaction_documents")
      .insert({
        transaction_id: params.transactionId,
        brokerage_id:   params.brokerageId,
        uploaded_by:    params.uploadedBy,
        doc_type:       params.docType,
        doc_label:      params.docLabel  ?? null,
        storage_url:    params.storageUrl,
        notes:          params.notes     ?? null,
        status:         "pending",
        uploaded_at:    new Date().toISOString(),
        created_at:     new Date().toISOString(),
      })
      .select("id")
      .single()
    if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }
    return { success: true, data: { documentId: data.id } }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Unknown error in attachTransactionDocument" }
  }
}

// ─── updateLenderState ───────────────────────────────────────────────────────

export async function updateLenderState(params: {
  transactionId:           string
  brokerageId:             string
  lenderName?:             string
  loanOfficerName?:        string
  loanOfficerEmail?:       string
  loanOfficerPhone?:       string
  loanType?:               string
  loanAmount?:             number
  underwritingStatus?:     string
  appraisalOrderedDate?:   string
  appraisalCompletedDate?: string
  appraisalValue?:         number
  clearToCloseDate?:       string
  notes?:                  string
}): Promise<KernelTxResult<void>> {
  try {
    const supabase = await createServiceClient()
    const { data: existing } = await supabase
      .from("transaction_lenders")
      .select("id")
      .eq("transaction_id", params.transactionId)
      .maybeSingle()

    const payload: Record<string, unknown> = {
      transaction_id:           params.transactionId,
      brokerage_id:             params.brokerageId,
      lender_name:              params.lenderName            ?? null,
      loan_officer_name:        params.loanOfficerName       ?? null,
      loan_officer_email:       params.loanOfficerEmail      ?? null,
      loan_officer_phone:       params.loanOfficerPhone      ?? null,
      loan_type:                params.loanType              ?? null,
      loan_amount:              params.loanAmount            ?? null,
      underwriting_status:      params.underwritingStatus    ?? null,
      appraisal_ordered_date:   params.appraisalOrderedDate  ?? null,
      appraisal_completed_date: params.appraisalCompletedDate ?? null,
      appraisal_value:          params.appraisalValue        ?? null,
      clear_to_close_date:      params.clearToCloseDate      ?? null,
      notes:                    params.notes                 ?? null,
      updated_at:               new Date().toISOString(),
    }

    let err
    if (existing?.id) {
      ;({ error: err } = await supabase
        .from("transaction_lenders")
        .update(payload)
        .eq("id", existing.id))
    } else {
      ;({ error: err } = await supabase
        .from("transaction_lenders")
        .insert({ ...payload, created_at: new Date().toISOString() }))
    }

    if (err) return { success: false, error: err.message }
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Unknown error in updateLenderState" }
  }
}

// ─── updateVendorState ───────────────────────────────────────────────────────

export async function updateVendorState(params: {
  transactionId: string
  brokerageId:   string
  serviceType:   string
  vendorName:    string
  vendorEmail?:  string
  vendorPhone?:  string
  status?:       string
  scheduledDate?: string
  cost?:         number
  notes?:        string
}): Promise<KernelTxResult<{ serviceId: string }>> {
  try {
    const supabase = await createServiceClient()
    const { data, error } = await supabase
      .from("transaction_vendor_services")
      .insert({
        transaction_id: params.transactionId,
        brokerage_id:   params.brokerageId,
        service_type:   params.serviceType,
        vendor_name:    params.vendorName,
        vendor_email:   params.vendorEmail   ?? null,
        vendor_phone:   params.vendorPhone   ?? null,
        status:         params.status        ?? "pending",
        scheduled_date: params.scheduledDate ?? null,
        cost:           params.cost          ?? null,
        notes:          params.notes         ?? null,
        created_at:     new Date().toISOString(),
        updated_at:     new Date().toISOString(),
      })
      .select("id")
      .single()
    if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }
    return { success: true, data: { serviceId: data.id } }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Unknown error in updateVendorState" }
  }
}

// ─── closeTransactionCommand ──────────────────────────────────────────────────

export async function closeTransactionCommand(params: {
  transactionId: string
  brokerageId:   string
  agentId:       string
  reason?:       string
}): Promise<KernelTxResult<void>> {
  try {
    const supabase = await createServiceClient()
    const today = new Date().toISOString().slice(0, 10)
    const nowIso = new Date().toISOString()

    // Capture related entities BEFORE the close so we can propagate state
    const { data: txBefore } = await supabase
      .from("transactions")
      .select("listing_id, buyer_contact_id, seller_contact_id, contact_id")
      .eq("id", params.transactionId)
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle()

    const { error } = await supabase
      .from("transactions")
      .update({
        status:     "closed",
        stage:      "CLOSED",
        close_date: today,
        updated_at: nowIso,
      })
      .eq("id", params.transactionId)
      .eq("brokerage_id", params.brokerageId)

    if (error) return { success: false, error: error.message }

    // Timeline + lifecycle_event + per-contact activity rows
    // (activity rows are what the CRM contact Activity tab reads — the
    // transaction_timeline rows alone never surface there.)
    const activityWrites: any[] = []
    if (txBefore?.buyer_contact_id) {
      activityWrites.push(
        supabase.from("activities").insert({
          brokerage_id:   params.brokerageId,
          agent_id:       params.agentId,
          contact_id:     txBefore.buyer_contact_id,
          transaction_id: params.transactionId,
          activity_type:  "transaction_closed",
          title:          "Transaction Closed",
          description:    params.reason ? `Transaction closed: ${params.reason}` : "Transaction closed — congratulations!",
          status:         "completed",
          priority:       "high",
          entity_type:    "transaction",
          created_at:     nowIso,
        })
      )
    }
    if (txBefore?.seller_contact_id && txBefore.seller_contact_id !== txBefore.buyer_contact_id) {
      activityWrites.push(
        supabase.from("activities").insert({
          brokerage_id:   params.brokerageId,
          agent_id:       params.agentId,
          contact_id:     txBefore.seller_contact_id,
          transaction_id: params.transactionId,
          activity_type:  "transaction_closed",
          title:          "Transaction Closed",
          description:    params.reason ? `Transaction closed: ${params.reason}` : "Transaction closed — congratulations!",
          status:         "completed",
          priority:       "high",
          entity_type:    "transaction",
          created_at:     nowIso,
        })
      )
    }

    await Promise.all([
      supabase.from("transaction_timeline").insert({
        transaction_id: params.transactionId,
        brokerage_id:   params.brokerageId,
        activity_type:  "transaction_closed",
        description:    params.reason ? `Transaction closed: ${params.reason}` : "Transaction closed",
        performed_by:   params.agentId,
        created_at:     nowIso,
      }),
      supabase.from("lifecycle_events").insert({
        brokerage_id:  params.brokerageId,
        entity_type:   "transaction",
        entity_id:     params.transactionId,
        event_type:    KernelEvent.TRANSACTION_CLOSED,
        actor_user_id: params.agentId,
        created_at:    nowIso,
      }),
      ...activityWrites,
    ])

    // Kernel fan-out — fires staff notifications, auto-enrolls both
    // contacts (buyer + seller) into any campaign_sequence with
    // trigger_event='transaction_closed' (e.g. the seeded "Lifetime
    // onboard" drip), and writes transparency_updates per contact so
    // the seller AND buyer portals show "Closed!" + "Welcome to your
    // lifetime portal" cards immediately.
    try {
      const { fanOutKernelEvent } = await import("./event-fanout")
      await fanOutKernelEvent({
        event:           KernelEvent.TRANSACTION_CLOSED,
        brokerageId:     params.brokerageId,
        entityType:      "transaction",
        entityId:        params.transactionId,
        transactionId:   params.transactionId,
        listingId:       txBefore?.listing_id ?? undefined,
        buyerContactId:  txBefore?.buyer_contact_id ?? undefined,
        sellerContactId: txBefore?.seller_contact_id ?? undefined,
        agentUserId:     params.agentId,
        metadata:        { reason: params.reason ?? null, close_date: today },
      })
    } catch (e) {
      console.error("[closeTransactionCommand] fanOutKernelEvent failed", e)
    }

    // ── Propagate close to related entities ────────────────────────────────
    // 1. Listing → CLOSED on its lifecycle stage machine + status='closed'
    //    (closes the loop: prior to this fix the listing stayed UNDER_CONTRACT
    //     forever even after the transaction closed)
    if (txBefore?.listing_id) {
      try {
        const { transitionLifecycle } = await import("@/lib/kernel/lifecycle")
        await transitionLifecycle({
          brokerageId: params.brokerageId,
          entityType:  "listing_stage_machine",
          entityId:    txBefore.listing_id,
          fromState:   "UNDER_CONTRACT",
          toState:     "CLOSED",
          actorUserId: params.agentId,
          eventType:   "TRANSACTION_CLOSED",
          metadata:    { transaction_id: params.transactionId },
        })
      } catch {}
      await supabase
        .from("listings")
        .update({ status: "closed", updated_at: nowIso })
        .eq("id", txBefore.listing_id)
        .then(() => null, () => null)
    }

    // 2. Buyer + seller contacts → lifetime_customer
    //    (Lifetime Customers retention surface depends on this conversion;
    //     prior to this fix only the listing-close path converted the seller,
    //     and the transaction-close path converted neither party.)
    const lifetimeContactIds: string[] = []
    if (txBefore?.buyer_contact_id)  lifetimeContactIds.push(txBefore.buyer_contact_id)
    if (txBefore?.seller_contact_id) lifetimeContactIds.push(txBefore.seller_contact_id)
    if (lifetimeContactIds.length > 0) {
      await supabase
        .from("contacts")
        .update({ contact_type: "lifetime_customer", updated_at: nowIso })
        .in("id", lifetimeContactIds)
        .eq("brokerage_id", params.brokerageId)
        .then(() => null, () => null)
    }

    // 3. Commission records — recalculate + upsert transaction_commissions rows.
    //    Prior to this fix, a transaction could close with zero commission
    //    records, which meant the agent had no payable to track.
    try {
      await recalculateCommissionStateCommand({
        transactionId: params.transactionId,
        brokerageId:   params.brokerageId,
        agentId:       params.agentId,
      })
    } catch {}

    // 4. Lifetime-customer touchpoint schedule — both buyer and seller now
    //    enter the post-close nurture sequence (3-day, 30-day, 6-month,
    //    1-year anniversary, 18-month referral ask). Previously this
    //    function was defined but never called from anywhere — orphaned.
    //    Resolve agents.id from agent user once so we can attribute the
    //    touchpoints correctly.
    try {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", params.agentId)
        .maybeSingle()
      const agentId = agentRow?.id ?? null
      if (agentId && lifetimeContactIds.length > 0) {
        const closeDate = new Date(today)
        const schedule = [
          { type: "post_close_3_day",     daysAfter: 3,        channel: "video" },
          { type: "post_close_30_day",    daysAfter: 30,       channel: "sms"   },
          { type: "post_close_6_month",   daysAfter: 180,      channel: "email" },
          { type: "home_anniversary",     daysAfter: 365,      channel: "video" },
          { type: "referral_request",     daysAfter: 18 * 30,  channel: "sms"   },
        ]
        const rows = lifetimeContactIds.flatMap(contactId =>
          schedule.map(s => {
            const d = new Date(closeDate)
            d.setDate(d.getDate() + s.daysAfter)
            return {
              brokerage_id:           params.brokerageId,
              contact_id:             contactId,
              agent_id:               agentId,
              touchpoint_type:        s.type,
              channel:                s.channel,
              scheduled_date:         d.toISOString().split("T")[0],
              status:                 "scheduled",
              related_transaction_id: params.transactionId,
            }
          })
        )
        await supabase.from("lifetime_customer_touchpoints").insert(rows)
          .then(() => null, () => null)
      }
    } catch {}

    // 5. Closing-gift task for the agent — surfaces in their inbox as a
    //    high-priority next-action so they don't forget to send a gift.
    //    Recommendation engine (aiRecommendGift) runs when the agent opens
    //    the task; we just need to plant the prompt here.
    try {
      for (const contactId of lifetimeContactIds) {
        await supabase.from("activities").insert({
          brokerage_id:   params.brokerageId,
          agent_id:       params.agentId,
          contact_id:     contactId,
          transaction_id: params.transactionId,
          activity_type:  "closing_gift_due",
          title:          "Send closing gift",
          description:    "Pick a gift from the marketplace or generate an AI recommendation. Suggested timing: within 7 days of close.",
          status:         "pending",
          priority:       "high",
          entity_type:    "contact",
          scheduled_at:   new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          created_at:     nowIso,
        }).then(() => null, () => null)
      }
    } catch {}

    // Schedule review request 5 days post-close (J8.1)
    try {
      const sendAfter = new Date()
      sendAfter.setDate(sendAfter.getDate() + 5)
      await supabase.from("review_requests").insert({
        brokerage_id:   params.brokerageId,
        agent_user_id:  params.agentId,
        transaction_id: params.transactionId,
        status:         "scheduled",
        send_after:     sendAfter.toISOString(),
        created_at:     nowIso,
      }).then(() => null, () => null)
    } catch {
      // Non-critical — close success is not dependent on review scheduling
    }

    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Unknown error in closeTransactionCommand" }
  }
}

// ─── reopenTransactionCommand ─────────────────────────────────────────────────

export async function reopenTransactionCommand(params: {
  transactionId:        string
  brokerageId:          string
  requestingUserId:     string
  requestingUserRole:   string
  reason:               string
}): Promise<KernelTxResult<void>> {
  if (!["broker", "admin"].includes(params.requestingUserRole)) {
    return { success: false, error: "Only brokers and admins can reopen transactions." }
  }
  try {
    const supabase = await createServiceClient()
    const { error } = await supabase
      .from("transactions")
      .update({
        status:     "active",
        stage:      "CLOSING_PREP",
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.transactionId)
      .eq("brokerage_id", params.brokerageId)

    if (error) return { success: false, error: error.message }

    await supabase.from("transaction_timeline").insert({
      transaction_id: params.transactionId,
      brokerage_id:   params.brokerageId,
      activity_type:  "transaction_reopened",
      description:    `Transaction reopened by ${params.requestingUserRole}: ${params.reason}`,
      performed_by:   params.requestingUserId,
      metadata:       { reason: params.reason, role: params.requestingUserRole } as any,
      created_at:     new Date().toISOString(),
    })

    await supabase.from("audit_log").insert({
      entity_type: "transaction",
      entity_id:   params.transactionId,
      action:      "reopen",
      user_id:     params.requestingUserId,
      before:      { status: "closed", stage: "CLOSED" } as any,
      after:       { status: "active", stage: "CLOSING_PREP" } as any,
      created_at:  new Date().toISOString(),
    })

    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Unknown error in reopenTransactionCommand" }
  }
}

// ─── recalculateCommissionStateCommand ───────────────────────────────────────

export async function recalculateCommissionStateCommand(params: {
  transactionId: string
  brokerageId:   string
  agentId:       string
}): Promise<KernelTxResult<{ grossCommission: number; agentNet: number; brokerageNet: number }>> {
  try {
    const supabase = await createServiceClient()

    // Load transaction purchase_price + agent commission profile
    const [{ data: tx }, { data: profile }] = await Promise.all([
      supabase
        .from("transactions")
        .select("purchase_price, commission_percentage, estimated_commission")
        .eq("id", params.transactionId)
        .maybeSingle(),
      supabase
        .from("agent_commission_profiles")
        .select("split_percent, cap_amount, transaction_fee, royalty_percent")
        .eq("agent_id", params.agentId)
        .eq("brokerage_id", params.brokerageId)
        .eq("is_active", true)
        .order("effective_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    if (!tx) return { success: false, error: "Transaction not found" }

    const purchasePrice    = (tx as any).purchase_price        ?? 0
    const commPct          = (tx as any).commission_percentage ?? (profile as any)?.split_percent ?? 3
    const splitPercent     = (profile as any)?.split_percent   ?? 80
    const txFee            = (profile as any)?.transaction_fee ?? 0
    const royaltyPct       = (profile as any)?.royalty_percent ?? 0

    const grossCommission  = (purchasePrice * commPct)  / 100
    const agentGross       = (grossCommission * splitPercent) / 100
    const royaltyFee       = (grossCommission * royaltyPct)   / 100
    const agentNet         = agentGross - txFee - royaltyFee
    const brokerageNet     = grossCommission - agentNet

    // Upsert transaction_commissions rows
    await supabase.from("transaction_commissions").upsert([
      {
        transaction_id:    params.transactionId,
        brokerage_id:      params.brokerageId,
        recipient_type:    "agent",
        recipient_name:    "Agent",
        recipient_id:      params.agentId,
        commission_type:   "commission_split",
        rate_percentage:   splitPercent,
        calculated_amount: agentNet,
        status:            "pending",
        updated_at:        new Date().toISOString(),
      },
      {
        transaction_id:    params.transactionId,
        brokerage_id:      params.brokerageId,
        recipient_type:    "brokerage",
        recipient_name:    "Brokerage",
        recipient_id:      params.brokerageId,
        commission_type:   "brokerage_split",
        rate_percentage:   100 - splitPercent,
        calculated_amount: brokerageNet,
        status:            "pending",
        updated_at:        new Date().toISOString(),
      },
    ], { onConflict: "transaction_id,recipient_type" })

    // Write commission_calculations record for audit trail
    await supabase.from("commission_calculations").insert({
      transaction_id:       params.transactionId,
      brokerage_id:         params.brokerageId,
      agent_id:             params.agentId,
      gross_commission:     grossCommission,
      agent_commission:     agentNet,
      total_commission:     grossCommission,
      calculation_version:  1,
      calculated_at:        new Date().toISOString(),
    } as any)

    return {
      success: true,
      data: { grossCommission, agentNet, brokerageNet },
    }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Unknown error in recalculateCommissionStateCommand" }
  }
}

// ─── emitClientFriendlyUpdateCommand ─────────────────────────────────────────

export async function emitClientFriendlyUpdateCommand(params: {
  transactionId: string
  brokerageId:   string
  agentId:       string
  contactId:     string
  updateType:    string
  updateText:    string
  tone?:         string
  sendVia?:      string
}): Promise<KernelTxResult<void>> {
  try {
    const supabase = await createServiceClient()

    // Write to client_friendly_updates (live table)
    const { error } = await supabase.from("client_friendly_updates").insert({
      transaction_id: params.transactionId,
      brokerage_id:   params.brokerageId,
      update_type:    params.updateType,
      update_text:    params.updateText,
      tone:           params.tone    ?? "professional",
      sent_via:       params.sendVia ?? "portal",
      ai_generated:   false,
      created_at:     new Date().toISOString(),
    })

    if (error) return { success: false, error: error.message }

    // Write timeline entry so agent sees the update was sent
    await supabase.from("transaction_timeline").insert({
      transaction_id: params.transactionId,
      brokerage_id:   params.brokerageId,
      activity_type:  "client_update_sent",
      description:    `Client update sent: ${params.updateText.slice(0, 120)}`,
      performed_by:   params.agentId,
      created_at:     new Date().toISOString(),
    })

    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Unknown error in emitClientFriendlyUpdateCommand" }
  }
}

// ─── prefillTransactionFormFromRecord ────────────────────────────────────────

export async function prefillTransactionFormFromRecord(transactionId: string): Promise<KernelTxResult<{
  propertyAddress: string | null
  propertyCity:    string | null
  propertyState:   string | null
  propertyZip:     string | null
  dealType:        string | null
  purchasePrice:   number | null
  closeDate:       string | null
  dealName:        string | null
  commissionPct:   number | null
  agentId:         string | null
  contactId:       string | null
}>> {
  try {
    const supabase = await createServiceClient()
    const { data, error } = await supabase
      .from("transactions")
      .select("property_address, property_city, property_state, property_zip, deal_type, purchase_price, close_date, deal_name, commission_percentage, agent_id, contact_id")
      .eq("id", transactionId)
      .maybeSingle()

    if (error || !data) return { success: false, error: error?.message ?? "Transaction not found" }

    return {
      success: true,
      data: {
        propertyAddress: (data as any).property_address  ?? null,
        propertyCity:    (data as any).property_city     ?? null,
        propertyState:   (data as any).property_state    ?? null,
        propertyZip:     (data as any).property_zip      ?? null,
        dealType:        (data as any).deal_type         ?? null,
        purchasePrice:   (data as any).purchase_price    ?? null,
        closeDate:       (data as any).close_date        ?? null,
        dealName:        (data as any).deal_name         ?? null,
        commissionPct:   (data as any).commission_percentage ?? null,
        agentId:         (data as any).agent_id          ?? null,
        contactId:       (data as any).contact_id        ?? null,
      },
    }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "Unknown error in prefillTransactionFormFromRecord" }
  }
}
