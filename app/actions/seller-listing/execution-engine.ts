"use server"

/**
 * System 5.2: Seller Listing Lifecycle - Execution Engine
 * 
 * Executes the seller listing lifecycle from appointment through active listing.
 * Enforces sequencing, readiness gates, authority rules.
 * 
 * Domains:
 * 1. Seller Decision & Commitment
 * 2. Listing Readiness (Sequenced: Legal → Property → Media)
 * 3. Market Exposure
 * 4. Termination/Handoff
 * 
 * Constraints:
 * - NO schema changes
 * - NO state storage
 * - Events to activities table ONLY
 * - STOPS at UNDER_CONTRACT
 */
// Agent task (correct location, no changes) — activity_type: seller.appointment.scheduled, seller.cma.started, seller.presentation.*, seller.decision.*, and all seller lifecycle events

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { auditListingDocuments } from "@/lib/compliance/required-documents"
import { scanListingPacketCompleteness } from "@/lib/workflow/intelligence/scan-offer-packet"
import { notifyComplianceFlag } from "@/lib/notifications/notify-helpers"
import { LISTING_AGREEMENT_EXECUTED_STATUS } from "@/lib/transactions/coordination-status"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { isValidUUID } from "@/lib/validations"
import { resolveProvider } from "@/lib/kernel/providers"
import { transitionLifecycle, processKernelEvent } from "@/lib/kernel"
import { KernelEvent } from "@/lib/kernel/events"
import { getStageDefinition, type ListingStage } from "@/lib/listing-lifecycle/lifecycle-definitions"
import {
  ledgerMechanismForReason,
  recipientTypeForReason,
  commissionAdjustmentReasonLabel,
  isCommissionAdjustmentReason,
} from "@/lib/commission/adjustment-vocabulary"
import { resolveTotalCommissionRate } from "@/lib/commission/agreement-total-rate"

// ============================================================================
// DOMAIN 1: Seller Decision & Commitment
// ============================================================================

/**
 * Schedule listing appointment and trigger CMA + presentation workflow
 * Minimum drip duration: 5 days before appointment
 */

/**
 * Write a lifecycle activity and SAY SO WHEN IT DOES NOT LAND.
 *
 * This file logs the entire seller listing lifecycle — appointment set, agreement
 * signed, photography booked, live on market — as `activities` rows, and all
 * eighteen writes were `await logLifecycleActivity(supabase, {…})` with the
 * result dropped. supabase-js RESOLVES a rejected insert rather than throwing, so
 * a failed write was indistinguishable from a successful one and the surrounding
 * action returned success either way.
 *
 * That matters more here than almost anywhere: these rows ARE the listing's
 * history. The kernel's conversation memory reads them into the AI's picture of
 * the relationship, and a broker would hand them to a regulator as the record of
 * what happened and when. One helper rather than eighteen repeated checks, so
 * the next writer cannot forget.
 */
async function logLifecycleActivity(
  supabase: any,
  row: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from("activities").insert(row)
  if (error) {
    console.error(
      `[seller-lifecycle] activity "${String(row.activity_type)}" NOT recorded:`,
      error.message,
    )
  }
}

/**
 * THE TENANT GATE. Every export in this file is a `"use server"` action, and every
 * one of them took `userId` and `brokerageId` AS PARAMETERS with no authentication
 * anywhere in the file — 23 actions, zero requireAuth calls. A server action is a
 * POST endpoint: whoever called one chose which brokerage's ledger to write into,
 * whose user id to attribute the act to, and which listing to drive through a
 * kernel stage transition. Nothing checked that the caller belonged to that
 * brokerage or that the listing did either.
 *
 * These rows ARE the listing's history — the kernel reads them into the AI's
 * picture of the relationship and a broker would hand them to a regulator. A
 * forged one is worse than a missing one.
 *
 * Identity now comes from the SESSION and the listing must belong to it. The
 * params are still accepted so existing callers (the voice command map, the
 * lifecycle cards) keep compiling, but the values USED are the resolved ones —
 * a caller cannot widen its own scope by passing a different id.
 */
// UN-EXPORTED (§1.1, 2026-08-31, lane M4): both halves of the gate result are
// named only by the private authorizeListingAction below.
interface ListingActionScope {
  ok: true
  userId: string
  brokerageId: string
}
interface ListingActionDenied {
  ok: false
  error: string
}

async function authorizeListingAction(
  supabase: Awaited<ReturnType<typeof createClient>>,
  listingId: string,
): Promise<ListingActionScope | ListingActionDenied> {
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { ok: false, error: "unauthenticated" }
  if (!isValidUUID(listingId)) return { ok: false, error: "invalid_listing_id" }

  // The listing must be inside the caller's brokerage. Reading through the
  // request-scoped client means RLS applies too — a listing the caller cannot
  // see resolves to no row and is refused rather than silently acted upon.
  const { data: listing } = await supabase
    .from("listings")
    .select("id, brokerage_id")
    .eq("id", listingId)
    .maybeSingle()
  if (!listing) return { ok: false, error: "listing_not_found" }
  if (listing.brokerage_id !== auth.brokerageId) return { ok: false, error: "listing_not_in_your_brokerage" }

  return { ok: true, userId: auth.userId, brokerageId: auth.brokerageId }
}

/**
 * THE STAGE PRECONDITION — read the listing's CURRENT stage, not a pile of events.
 *
 * Four stage-advancing actions each hand-rolled their own gate, and all four were
 * broken in the same two ways:
 *
 *   1. THEY MATCHED AN EVENT TYPE NOTHING WRITES. Each queried lifecycle_events
 *      for `event_type = KernelEvent.LISTING_STAGE_CHANGED` — the bare
 *      'listing_stage_changed'. But transitionLifecycle, the ONLY writer of these
 *      rows, stores `lifecycle.${eventType}` (lib/kernel/lifecycle.ts:218). The
 *      prefixed value never equals the bare one, so every one of these gates
 *      matched ZERO rows for every listing, and markMLSReady /
 *      approveOpenHouseMarketing / prepareComingSoonAssets / submitToMLSAdmin
 *      could NEVER SUCCEED. Not "rarely" — never.
 *
 *   2. THEY ASKED THE WRONG QUESTION. "Has an event of this type ever been
 *      recorded" is not "is the listing in the required state". markMLSReady
 *      counted rows of EITHER type and accepted `length >= 2`, so once the prefix
 *      was corrected two ordinary stage changes would have satisfied a gate whose
 *      stated meaning is "media approved AND coming soon activated". Fixing only
 *      the prefix would have turned a gate that blocks everything into a gate
 *      that blocks nothing.
 *
 * And nothing downstream catches it: transitionLifecycle writes the state column
 * UNCONDITIONALLY and records `fromState` in metadata as a claim it never
 * verifies. These pre-gates are the only enforcement of stage order that exists,
 * and listing_stage_machine transitions also sync `listings.status`, so a listing
 * that skipped ahead goes publicly live out of order.
 *
 * So the precondition is read from the entity's own stage column and compared
 * against `allowedFrom` in LISTING_LIFECYCLE_STAGES — the authoritative table
 * that already declares which stage each target may be entered from. Deriving the
 * gate from the definition means the two cannot drift; adding a stage updates
 * both at once.
 */
async function requireCurrentListingStage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  listingId: string,
  allowed: readonly ListingStage[],
  requirementLabel: string,
): Promise<{ ok: true; from: ListingStage } | { ok: false; error: string }> {
  const { data: listing, error } = await supabase
    .from("listings")
    .select("lifecycle_stage")
    .eq("id", listingId)
    .maybeSingle()

  // A gate that could not READ is not a gate that passed. supabase-js resolves a
  // failed query, so without this the refusal would be indistinguishable from a
  // listing sitting in the wrong stage — and the message would send the agent
  // hunting for a stage problem that does not exist.
  if (error) return { ok: false, error: `stage_check_failed:${error.message}` }
  if (!listing) return { ok: false, error: "listing_not_found" }

  const current = (listing.lifecycle_stage as ListingStage | null) ?? null
  if (!current) return { ok: false, error: `listing_has_no_stage; ${requirementLabel} requires ${allowed.join(" or ")}` }
  if (!allowed.includes(current)) {
    return { ok: false, error: `listing is ${current}; ${requirementLabel} requires ${allowed.join(" or ")}` }
  }
  return { ok: true, from: current }
}

/**
 * For an action that ADVANCES the stage: the listing must be in one of the stages
 * the target declares it may be entered from.
 */
async function requireListingStage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  listingId: string,
  target: ListingStage,
): Promise<{ ok: true; from: ListingStage } | { ok: false; error: string }> {
  const def = getStageDefinition(target)
  if (!def) return { ok: false, error: `unknown_stage:${target}` }
  return requireCurrentListingStage(supabase, listingId, def.allowedFrom, target)
}

export async function scheduleListingAppointment(params: {
  listingId: string
  appointmentDate: string // ISO date
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId, appointmentDate } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }

  // Validate appointment date (must be >= 5 days from now)
  const apptDate = new Date(appointmentDate)
  const minDate = new Date()
  minDate.setDate(minDate.getDate() + 5)

  if (apptDate < minDate) {
    return {
      success: false,
      error: "Appointment must be at least 5 days in the future for drip sequence",
    }
  }

  // Stage transition: LEAD → APPOINTMENT_SET
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "LEAD",
    toState:     "APPOINTMENT_SET",
    eventType:   KernelEvent.LISTING_STAGE_CHANGED,
    actorUserId: userId,
    brokerageId,
    metadata: { appointment_date: appointmentDate },
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.LISTING_STAGE_CHANGED,
    brokerageId: brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  // Human-readable CRM activity (agent task log — activities is correct here)
  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.appointment.scheduled",
    title:         "Listing appointment scheduled",
    description:   `Appointment scheduled for ${appointmentDate}`,
    notes:         JSON.stringify({ appointment_date: appointmentDate }),
    status:        "completed",
    entity_type:   "contact",
  })

  // Sub-events within APPOINTMENT_SET stage — no stage change → lifecycle_events
  const subEvents = [
    {
      event_type: "seller.cma.started",
      metadata: {
        disclaimer:       "This CMA follows state appraiser guidelines but is NOT an actual appraisal",
        appointment_date: appointmentDate,
      },
    },
    { event_type: "seller.presentation.created",        metadata: {} },
    { event_type: "seller.presentation.video_generated", metadata: {} },
    {
      event_type: "seller.presentation.drip_prepared",
      metadata: {
        start_date:    new Date().toISOString(),
        end_date:      appointmentDate,
        duration_days: Math.ceil((apptDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
      },
    },
  ]

  for (const sub of subEvents) {
    await supabase.from("lifecycle_events").insert({
      brokerage_id:  brokerageId,
      entity_type:   "listing_stage_machine",
      entity_id:     listingId,
      event_type:    sub.event_type,
      actor_user_id: userId,
      metadata:      sub.metadata,
    })
  }

  return { success: true }
}

/**
 * Mark drip sequence as completed (final segment sent)
 */
export async function markDripCompleted(params: {
  listingId: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Stage transition: PRESENTATION_DRIP_PREP → SELLER_DECISION
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "PRESENTATION_DRIP_PREP",
    toState:     "SELLER_DECISION",
    eventType:   KernelEvent.LISTING_DRIP_COMPLETED,
    actorUserId: userId,
    brokerageId,
    metadata: {},
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.LISTING_DRIP_COMPLETED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  // CRM human task record — drip sequence completion (activities correct)
  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.presentation.drip_completed",
    title:         "Seller drip sequence completed",
    description:   "Presentation drip sequence completed",
    status:        "completed",
    entity_type:   "contact",
  })

  // Sub-event within SELLER_DECISION stage — no stage change → lifecycle_events
  await supabase.from("lifecycle_events").insert({
    brokerage_id:  brokerageId,
    entity_type:   "listing_stage_machine",
    entity_id:     listingId,
    event_type:    "seller.decision.ready",
    actor_user_id: userId,
    metadata:      {},
  })

  return { success: true }
}

/**
 * Record seller decision (accept or decline listing)
 */
export async function recordSellerDecision(params: {
  listingId: string
  decision: "accepted" | "declined"
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
  reason?: string
}) {
  const supabase = await createClient()
  const { listingId, decision, reason } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Stage transition varies by decision
  const toState      = decision === "accepted" ? "LISTING_AGREEMENT_INITIATED" : "SELLER_DECLINED"
  const kernelEvent  = decision === "accepted" ? KernelEvent.LISTING_STAGE_CHANGED : KernelEvent.SELLER_DECLINED
  const activityType = decision === "accepted" ? "seller.decision.accepted" : "seller.decision.declined"

  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "SELLER_DECISION",
    toState,
    eventType:   kernelEvent,
    actorUserId: userId,
    brokerageId,
    metadata: { decision, reason: reason ?? null },
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      kernelEvent,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    activity_type: activityType,
    title:         `Seller decision: ${decision}`,
    description:   reason ?? `Seller decision: ${decision}`,
    notes:         JSON.stringify({ listing_id: listingId, decision, reason: reason ?? null }),
    status:        "completed",
    entity_type:   "contact",
  })

  return { success: true, decision }
}

// ============================================================================
// DOMAIN 2: Listing Readiness (SEQUENCED)
// ============================================================================

/**
 * A. Legal / Agreement Track
 * Initiate listing agreement via Dotloop
 */
export async function initiateListingAgreement(params: {
  listingId: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Gate: the seller must have ACCEPTED.
  //
  // This read used to look in lifecycle_events for event_type
  // 'seller.decision.accepted' — a row nothing has ever written there.
  // recordSellerDecision writes that string as an ACTIVITY_TYPE into `activities`
  // (via logLifecycleActivity); the read was moved to lifecycle_events and the
  // write was not, and the comment that used to sit here ("activities has no
  // listing_id") records someone noticing the table was wrong without following
  // the value. So this gate matched nothing and initiateListingAgreement refused
  // every caller.
  //
  // What acceptance actually PRODUCES is the stage: recordSellerDecision
  // transitions SELLER_DECISION → LISTING_AGREEMENT_INITIATED on accept, and
  // → SELLER_DECLINED on decline. Reading the stage answers the question directly
  // and cannot be desynchronised from the writer.
  const stageGate = await requireCurrentListingStage(
    supabase, listingId, ["LISTING_AGREEMENT_INITIATED"], "starting the listing agreement",
  )
  if (!stageGate.ok) return { success: false, error: stageGate.error }

  // Sub-event: agreement paperwork started inside LISTING_AGREEMENT_INITIATED stage — no state change
  const { error: leError } = await supabase.from("lifecycle_events").insert({
    brokerage_id:  brokerageId,
    entity_type:   "listing_stage_machine",
    entity_id:     listingId,
    event_type:    KernelEvent.LISTING_AGREEMENT_INITIATED,
    actor_user_id: userId,
    metadata:      { stage: "LISTING_AGREEMENT_INITIATED" },
  })

  if (leError) {
    return { success: false, error: leError.message }
  }

  await processKernelEvent({
    event:      KernelEvent.LISTING_AGREEMENT_INITIATED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.listing_agreement.initiated",
    title:         "Listing agreement initiated",
    description:   `Listing agreement process initiated for listing ${listingId}`,
    notes:         JSON.stringify({ listing_id: listingId }),
    status:        "in_progress",
    entity_type:   "contact",
  })

  return { success: true }
}

/**
 * Mark listing agreement as signed — provider-routed.
 *
 * Steps (per spec):
 * 1. Resolve the esign provider via the provider_overrides cascade. (The spec
 *    said "esign + transaction"; the transaction half was resolved and never
 *    read, so it was deleted 2026-08-22 — see the note at the call site.)
 * 2. (RETIRED 2026-08-22) "Load integration_credentials for resolved
 *    provider_key" — nothing consumed it and this function makes no provider
 *    call. See the tombstone at the former call site; credentials resolve
 *    through lib/connections/resolve-scoped.ts.
 * 3. If manual_upload: store documentUrl to listing_agreements.
 *    If provider_pull: store providerRef to listing_agreements.
 * 4. INSERT listing_agreements (commission terms + document refs).
 * 5. If has commission adjustment: INSERT commission_adjustments.
 * 6. Set go_live_date on listings + calculate open house dates.
 * 7. Call transitionLifecycle() → lifecycle_events + processKernelEvent().
 */
export async function markAgreementSigned(params: {
  listingId: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
  uploadMode: "manual_upload" | "provider_pull"
  documentUrl?: string
  providerRef?: string
  /**
   * `listing_agreements.document_name` — what the executed agreement document is
   * called. Read (with effective_date) on the listing lifecycle page; had no
   * writer until orphan tranche X4 (2026-09-01) added intake for both. Optional:
   * blank writes NULL ("not recorded"), never a name derived or invented here.
   */
  documentName?: string
  /**
   * `listing_agreements.effective_date` — the effective date stated ON the
   * agreement (yyyy-mm-dd). NOT defaulted to today: the signature timestamps
   * below already record when it was executed, and a listing agreement's stated
   * effective date is part of the form, so an uncaptured one is NULL — the same
   * "absent means not recorded" doctrine as seller_transaction_fee.
   */
  effectiveDate?: string
  commissionTerms?: {
    listingRate?: number
    buyerRate?: number
    /**
     * `listing_agreements.total_commission_rate` — the TOTAL commission percent
     * as it appears on the executed agreement. Owner ruling (2026-08-27):
     * "listing agreement total commission rate is part of the agreement which is
     * a state form and/or seller agreement" — so it is captured at intake, not
     * inferred later. Rules (one vocabulary with the seven readers, see
     * lib/commission/agreement-total-rate.ts): PERCENT values (3 = 3%);
     * total-only agreements are legal (total set, splits blank); when both
     * splits are entered the total must equal their sum and is DERIVED as that
     * sum when left blank; blank everywhere writes NULL, never 0.
     */
    totalRate?: number
    isFlatFee?: boolean
    flatAmount?: number
    /**
     * `listing_agreements.seller_transaction_fee` — the FLAT brokerage
     * transaction fee charged to the SELLER at closing, in dollars, as agreed on
     * this agreement.
     *
     * WHY IT IS HERE (wave 14). m286 built the column and wrote its doctrine, and
     * no writer ever followed. SIX readers price the seller's net against it:
     *   lib/kernel/offer-net-sheet.ts:162          the offer net sheet
     *   lib/workflow/intelligence/multi-offer-matrix.ts:97  the multi-offer matrix
     *   app/actions/cma-presentation/net-sheet-calculator.ts:151
     *   app/actions/seller-cma.ts:215 / :300       the CMA + net-sheet pages
     *   app/actions/portal-seller.ts:573           THE SELLER'S OWN PORTAL
     *   app/dashboard/listings/[id]/offers/page.tsx:150
     * Every one of them read NULL and coerced it to 0, so every net-sheet figure
     * shown to a seller — including in their own portal — OVERSTATED their
     * proceeds by the brokerage's flat fee.
     *
     * NOT agents.transaction_fee / agent_commission_profiles.transaction_fee.
     * Those are AGENT-side (what the agent pays the brokerage out of their own
     * split) and must never reduce the seller's proceeds — m286 says so
     * explicitly, and the temptation to default this from one of them is exactly
     * the mistake that comment exists to prevent. Absent means NONE AGREED, which
     * is written as NULL, not as 0: 0 asserts a fee of zero was negotiated.
     *
     * Flat dollars only. A percentage charge is commission and belongs in the
     * rate fields above.
     */
    sellerTransactionFee?: number
    adjustmentType?: string
    adjustmentValue?: number
    adjustmentValueType?: "percent" | "flat"
    adjustmentNotes?: string
  }
}) {
  const supabase = await createClient()
  const { listingId, uploadMode, documentUrl, providerRef, commissionTerms } = params

  // Validate the OPTIONAL agreement metadata before any work: a malformed date
  // would be refused by Postgres and supabase-js reports that by resolving, so
  // the whole insert would fail late looking like a compliance problem.
  const documentName = params.documentName?.trim() || null
  let effectiveDate: string | null = null
  if (params.effectiveDate != null && params.effectiveDate.trim() !== "") {
    const raw = params.effectiveDate.trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(new Date(raw).getTime())) {
      return { success: false, error: "Effective date must be a valid yyyy-mm-dd date (or left blank if the agreement states none)." }
    }
    effectiveDate = raw
  }

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }

  // ── 1. Resolve providers via kernel cascade ───────────────────────────────
  const actorContext = { userId, brokerageId }

  // ONE resolve, not two. The `transaction` provider was resolved here beside
  // `esign` and then never read — `transactionResolved` appeared on this line and
  // nowhere else in the function. It was not free: `resolveProvider` walks the
  // provider_overrides cascade, so every agreement-signing paid for a second
  // cascade whose answer was discarded. Deleted rather than kept "for symmetry":
  // an unread resolve is an orphan read, and this function makes no transaction-
  // provider call at all (steps 3-7 below touch listing_agreements,
  // commission_adjustments, listings and lifecycle_events only).
  const esignResolved = await resolveProvider({ providerType: "esign", actorContext })

  const activeProviderKey = esignResolved.providerKey

  // ─── TOMBSTONE — step 2, "Load integration_credentials for the resolved
  //     provider_key" (2026-08-22) ──────────────────────────────────────────
  //
  // SURVIVOR — credential resolution for this and every other provider lane:
  //   lib/connections/resolve-scoped.ts  resolveScopedConnectionResult /
  //                                      resolveScopedConnection
  //   which walks agent → team → brokerage → platform and reaches
  //   `integration_credentials` through its last tier,
  //   lib/integrations/connection-manager.ts:resolveConnectionResult.
  //
  // DELETED AS AN ORPHAN READ WITH NO READER. It selected six columns —
  // including `api_key` and `api_secret` — into a `creds` binding that NOTHING
  // in this function ever touched. `markAgreementSigned` does not CALL an e-sign
  // provider: `manual_upload` stores a `documentUrl` the agent already uploaded,
  // `provider_pull` stores a `providerRef` the caller already holds, and the row
  // is written straight to `listing_agreements` with esign_status EXECUTED. So
  // this was a needless secret read on every execution — the worst kind of dead
  // code, because it costs confidentiality rather than cycles.
  //
  // IT ALSO SWALLOWED ITS OWN REFUSAL. It destructured `{ data }` only, so a
  // refused read (supabase-js RESOLVES refusals — CLAUDE.md §3) was byte-for-byte
  // "no credential configured". Rebuilding it correctly was rejected as the fix:
  // that would be a SECOND reader of the credential store with its own
  // brokerage-only lookup, which is exactly the shape the survivor exists to
  // replace — resolve-scoped reports connected | not_connected | unreadable and
  // STOPS on an unreadable tier instead of descending onto another owner's
  // credential (see the ruling at lib/kernel/manager-registry.ts:1010, and the
  // same deletion already made at app/actions/dispatch-showing.ts:219).
  //
  // IF a real e-sign dispatch is ever wired into this function, resolve it
  // through the survivor above — never with a fresh `.from("integration_credentials")`.
  //
  // `resolveProvider` above is NOT the survivor for this: it reads
  // `provider_overrides` and answers WHICH VENDOR, never WITH WHAT CREDENTIAL.

  // ── 2.5 COMPLIANCE GATE (owner's ruling: the same run as the offer side) ──
  //
  // This function used to write `compliance_passed: true` as a LITERAL. Nothing
  // had been checked; the column simply asserted a pass. Per the owner, a signed
  // listing agreement is gated exactly like an accepted offer: every required
  // brokerage / team / agent document present (required-vs-warning coming from
  // the same settings cascade), and no missing signature, initial or field.
  //
  // No MLS number is read here. Per the owner's ruling the MLS number belongs to
  // the listing-LAUNCH checkpoint, not to executing the agreement.
  const { data: listingRow } = await supabase
    .from("listings")
    .select("state, agent_id, seller_contact_id, contact_id")
    .eq("id", listingId)
    .maybeSingle()

  const { data: actingUser } = await supabase
    .from("users").select("team_id").eq("id", userId).maybeSingle()

  // The listing agent, RESOLVED agents.id → users.id (never substituted), so a
  // TC or broker executing on their behalf still notifies them.
  const listingAgentUserId = listingRow?.agent_id
    ? ((await supabase.from("agents").select("user_id").eq("id", listingRow.agent_id as string).maybeSingle())
        .data?.user_id as string | null) ?? null
    : null

  // The seller, resolved ONCE and used by both the document audit below and the
  // agreement row itself. `listings.contact_id` is the historical fallback and
  // is not populated live (see the note in the audit call), so seller_contact_id
  // wins when present.
  const sellerContactId = ((listingRow?.seller_contact_id ?? listingRow?.contact_id) as string | null) ?? null

  const docAudit = await auditListingDocuments(supabase as any, {
    brokerageId,
    // The seller lives in seller_contact_id. listings.contact_id exists but is
    // not populated (0 of 3 rows live), so this had been passing null and the
    // audit skipped every document filed against the seller's CONTACT record.
    // Raised in review; the readiness gate carried the same mistake and both
    // were corrected together so the two checkpoints stay in agreement.
    sellerContactId,
    agentUserId:     userId,
    teamId:          (actingUser?.team_id as string | null) ?? null,
    stateCode:       (listingRow?.state as string | null) ?? null,
    listingId,
  })

  const packetScan = await scanListingPacketCompleteness({
    listingId,
    raiserUserId: userId,
    brokerageId,
    alsoNotifyUserIds: [listingAgentUserId],
  })

  const blockingDocs    = docAudit.missing_blocking ?? []
  const packetBlockers  = packetScan.blockers ?? []
  const warningDocs     = docAudit.missing_warning ?? []
  const packetWarnings  = packetScan.warnings ?? []

  // An AUDIT that could not run is a block for the same reason a packet scan
  // that could not run is: it verified nothing. auditListingDocuments now says
  // so explicitly instead of returning the all-zero shape of a clean file.
  const auditUnavailable = docAudit.unavailable_reason

  if (blockingDocs.length > 0 || packetBlockers.length > 0 || !packetScan.success || auditUnavailable) {
    const bits: string[] = []
    if (blockingDocs.length > 0)   bits.push(`${blockingDocs.length} required document(s) missing`)
    if (packetBlockers.length > 0) bits.push(`${packetBlockers.length} packet blocker(s)`)
    if (auditUnavailable) bits.push(`required-document check could not run (${auditUnavailable})`)
    // A scan that could not RUN is treated as a block, never as a pass — the
    // same rule the listing-launch gate uses.
    if (!packetScan.success) bits.push(`packet check could not run (${packetScan.error ?? "no reason given"})`)

    await notifyComplianceFlag(supabase as any, {
      brokerageId,
      agentUserId: userId,
      alsoNotifyUserIds: [listingAgentUserId],
      flag: {
        type:       "compliance.listing_agreement_blocked",
        severity:   "high",
        title:      `Listing agreement blocked: ${bits.join(", ")}`,
        body:       `Missing required: ${blockingDocs.join(", ") || "(none)"}.\nPacket blockers: ${packetBlockers.slice(0, 5).map(b => b.title).join("; ") || "(none)"}.`,
        entityType: "document",
        entityId:   listingId,
      },
    })

    return {
      success: false,
      error: `Cannot execute the listing agreement — ${bits.join(" and ")}. Fix the listed items first.`,
      missing_required: blockingDocs,
      packet_blockers:  packetBlockers.map(b => ({ flagType: b.flagType, severity: b.severity, title: b.title })),
    }
  }

  // Warnings do not block, but they are still told to somebody — otherwise the
  // required/warning switch means "stops the deal" or "silence", with nothing
  // in between.
  if (warningDocs.length > 0 || packetWarnings.length > 0) {
    await notifyComplianceFlag(supabase as any, {
      brokerageId,
      agentUserId: userId,
      alsoNotifyUserIds: [listingAgentUserId],
      flag: {
        type:       "compliance.listing_agreement_warnings",
        severity:   "medium",
        title:      `Listing agreement executed with warnings: ${warningDocs.length} optional document(s), ${packetWarnings.length} packet warning(s)`,
        body:       `Missing (warning): ${warningDocs.join(", ") || "(none)"}.`,
        entityType: "document",
        entityId:   listingId,
      },
    })
  }

  // ── 3+4. INSERT listing_agreements ───────────────────────────────────────
  // adjustmentType is typed `string` at the boundary; the reason CHECK on
  // listing_agreements.adjustment_type refuses anything outside the vocabulary,
  // and supabase-js reports that by RESOLVING, not throwing. Validate with the
  // vocabulary's own guard BEFORE writing, so an unknown reason is refused with
  // a message instead of surfacing as a bare constraint violation.
  if (commissionTerms?.adjustmentType && !isCommissionAdjustmentReason(commissionTerms.adjustmentType)) {
    return {
      success: false,
      error: `Unknown commission adjustment reason "${commissionTerms.adjustmentType}" — pick one of the offered reasons (or "custom").`,
    }
  }
  const hasAdjustment = !!(commissionTerms?.adjustmentType && commissionTerms?.adjustmentValue !== undefined)

  // MONEY SHOWN TO A SELLER — validated before it is written, because the six
  // net-sheet readers subtract it from the seller's proceeds without re-checking.
  // A negative fee would ADD to their net; a NaN would render "$NaN" on the
  // seller's own portal. Neither is a number anyone agreed to.
  const rawFee = commissionTerms?.sellerTransactionFee
  if (rawFee !== undefined && rawFee !== null) {
    if (!Number.isFinite(Number(rawFee)) || Number(rawFee) < 0) {
      return { success: false, error: "Seller transaction fee must be a positive dollar amount (or left blank if none was agreed)." }
    }
  }
  const sellerTransactionFee =
    rawFee === undefined || rawFee === null ? null : Number(rawFee)

  // THE AGREEMENT'S TOTAL — validated/derived BEFORE the write (owner ruling
  // 2026-08-27: the total commission rate is part of the state form / seller
  // agreement). resolveAgreedCommission gives a written total precedence over
  // the split sum, so a total that disagrees with the splits must be refused
  // here rather than written and left to silently win downstream.
  const totalRateResolution = resolveTotalCommissionRate({
    listingRate: commissionTerms?.listingRate ?? null,
    buyerRate: commissionTerms?.buyerRate ?? null,
    totalRate: commissionTerms?.totalRate ?? null,
  })
  if (!totalRateResolution.ok) {
    return { success: false, error: totalRateResolution.error }
  }

  const { data: agreement, error: agreementError } = await supabase
    .from("listing_agreements")
    .insert({
      listing_id:                  listingId,
      brokerage_id:                brokerageId,
      // THE SELLER, STAMPED ON THE AGREEMENT. This is the only insert of
      // `listing_agreements` in the tree and it left `seller_contact_id` NULL,
      // while two consumers key on it:
      //
      //   · lib/kernel/compliance/active-representation.ts:59-63 — arm 3 of the
      //     implied-TCPA-consent test is "a fully-signed listing agreement for
      //     this contact". With the column NULL that arm could never match, so
      //     a seller whose agreement THIS FUNCTION had just fully executed
      //     (esign_status is written executed a few lines below) still counted
      //     as unconsented on sms/phone, and the dispatch suppression gate
      //     blocked the servicing team from reaching their own active client.
      //   · lib/kernel/notification-engine.ts:314-323 — reads seller_contact_id
      //     off the agreement to find the seller to notify, and skips silently
      //     on NULL (`if (listingAgreement?.seller_contact_id)`).
      //
      // The value was already in scope: the same id is handed to
      // auditListingDocuments above. It was resolved and then not written down.
      seller_contact_id:           sellerContactId,
      agent_user_id:               userId,
      upload_mode:                 uploadMode,
      provider_name:               activeProviderKey,
      document_url:                uploadMode === "manual_upload" ? (documentUrl ?? null) : null,
      provider_ref:                uploadMode === "provider_pull" ? (providerRef ?? null) : null,
      // Optional intake (see the parameter docs): NULL means "not recorded",
      // and the lifecycle-page reader treats it that way.
      document_name:               documentName,
      effective_date:              effectiveDate,
      esign_status:                LISTING_AGREEMENT_EXECUTED_STATUS,
      agreement_type:              "listing",
      seller_signed_at:            new Date().toISOString(),
      agent_signed_at:             new Date().toISOString(),
      fully_executed_at:           new Date().toISOString(),
      listing_commission_rate:     commissionTerms?.listingRate ?? null,
      buyer_commission_rate:       commissionTerms?.buyerRate ?? null,
      // Entered on the form, or derived as listing + buyer when both sides were
      // entered and the total line was left blank; NULL when nothing was
      // recorded. See resolveTotalCommissionRate for the refusal rules.
      total_commission_rate:       totalRateResolution.total,
      commission_is_flat_fee:      commissionTerms?.isFlatFee ?? false,
      commission_flat_amount:      commissionTerms?.flatAmount ?? null,
      // NULL, never 0, when none was agreed — see the doc on the parameter. The
      // six net-sheet readers all treat NULL as "no fee"; writing 0 would be
      // indistinguishable but would ASSERT a negotiated zero.
      seller_transaction_fee:      sellerTransactionFee,
      has_commission_adjustment:   hasAdjustment,
      adjustment_type:             commissionTerms?.adjustmentType ?? null,
      adjustment_value:            commissionTerms?.adjustmentValue ?? null,
      adjustment_value_type:       commissionTerms?.adjustmentValueType ?? null,
      adjustment_notes:            commissionTerms?.adjustmentNotes ?? null,
      // Reached only after the gate above passed, so this now records a check
      // that actually ran instead of asserting one that never did.
      compliance_passed:           true,
    })
    .select("id")
    .single()

  if (agreementError) {
    return { success: false, error: agreementError.message }
  }

  // ── 5. INSERT commission_adjustments if applicable ────────────────────────
  //
  // THIS INSERT COULD NEVER SUCCEED, and nothing said so. Three separate live-schema
  // violations, all invisible because the result was never destructured — supabase-js
  // RESOLVES a rejected write, so `await ...insert(...)` with no `error` check reports
  // a constraint violation exactly like a success:
  //
  //   · transaction_id  — NOT NULL, no default. Never supplied.
  //   · recipient_type  — NOT NULL, no default. Never supplied.
  //   · adjustment_type — written straight through from the listing agreement's
  //     REASON vocabulary into the ledger's MECHANISM vocabulary. `military`,
  //     `repeat_client` and `relocation` are valid reasons and are rejected here.
  //
  // What it cost: an agent negotiates a reduced commission, the agreement saves, the
  // UI confirms — and lib/commission/waterfall/03-apply-gross-adjustments.ts, which
  // reads this table filtered on transaction_id, finds nothing. The seller is invoiced
  // the FULL commission the agent promised to discount, at closing, every time.
  let adjustmentWarning: string | null = null
  if (hasAdjustment && commissionTerms) {
    // The ledger row hangs off the TRANSACTION — that is the only key the waterfall
    // reads. Without one there is nothing to attach the concession to, and inventing
    // a transaction here would be a far larger side effect than this action implies.
    const { data: tx } = await supabase
      .from("transactions")
      .select("id")
      .eq("listing_id", listingId)
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!tx?.id) {
      adjustmentWarning =
        "The commission adjustment is recorded on the listing agreement but NOT in the commission ledger — this listing has no transaction yet, and the ledger entry is what reduces the commission at closing. Open the transaction for this listing and re-apply the adjustment."
    } else {
      const reason = commissionTerms.adjustmentType ?? null
      const { error: adjustmentError } = await supabase
        .from("commission_adjustments")
        .insert({
          brokerage_id:          brokerageId,
          transaction_id:        tx.id,
          created_by_agent_id:   await resolveAgentId(supabase as any, userId),
          // Reason → mechanism. The reason itself stays on
          // listing_agreements.adjustment_type and is carried into the notes below,
          // so translating here loses nothing.
          adjustment_type:       ledgerMechanismForReason(reason),
          recipient_type:        recipientTypeForReason(reason),
          value:                 commissionTerms.adjustmentValue!,
          value_type:            commissionTerms.adjustmentValueType ?? "percent",
          notes:                 [commissionAdjustmentReasonLabel(reason), commissionTerms.adjustmentNotes]
                                   .filter(Boolean).join(" — ") || null,
          // applies_to is (gross|agent|brokerage) — a seller-negotiated listing
          // concession comes off the GROSS commission — and direction is
          // (credit|surcharge); a reduction IS a credit.
          applies_to:            "gross",
          direction:             "credit",
          is_active:             true,
          effective_date:        new Date().toISOString().slice(0, 10),
        })

      if (adjustmentError) {
        adjustmentWarning =
          `The commission adjustment is recorded on the listing agreement but NOT in the commission ledger (${adjustmentError.message}). The ledger entry is what reduces the commission at closing.`
      }
    }
  }

  // ── 6. Set go_live_date + calculate open house dates ──────────────────────
  const goLiveDate = new Date()
  const { marketingDate, eventDate } = calculateOpenHouseDates(goLiveDate)

  const { error: listingError } = await supabase
    .from("listings")
    .update({
      go_live_date:              goLiveDate.toISOString().slice(0, 10),
      open_house_marketing_date: marketingDate.toISOString().slice(0, 10),
      open_house_event_date:     eventDate.toISOString().slice(0, 10),
      updated_at:                new Date().toISOString(),
    })
    .eq("id", listingId)

  if (listingError) {
    return { success: false, error: listingError.message }
  }

  // Auto-schedule a DRAFT open-house social post — copy is AI-generated (gateway, brand-voiced,
  // Fair-Housing redrafted) grounded in the real address + event date, with a date-stamped floor as the
  // deterministic fallback (no more "stay tuned" placeholder). approval_status stays 'pending' so a human
  // still reviews before it posts.
  const { data: ohListing } = await supabase
    .from("listings").select("address, city, state").eq("id", listingId).maybeSingle()
  const ohAddress = [ohListing?.address, ohListing?.city, ohListing?.state].filter(Boolean).join(", ")
  const ohDateLabel = eventDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
  const ohFloor = ohAddress
    ? `Open house at ${ohAddress} on ${ohDateLabel}. Come see it in person — details to follow.`
    : `Open house on ${ohDateLabel}. Come see it in person — details to follow.`
  const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
  const ohCopy = await generateClientMessage({
    brokerageId,
    agentUserId: userId,
    audience: "lead",
    purpose:
      "Write a short, inviting open-house announcement for prospective buyers to see on social media. Warm and welcoming, no pressure, no guarantees.",
    facts: [
      ...(ohAddress ? [{ label: "Property", value: ohAddress }] : []),
      { label: "Open house date", value: ohDateLabel },
    ],
    fallback: { subject: "Open house", body: ohFloor },
  })
  await supabase.from("social_posts").insert({
    brokerage_id:      brokerageId,
    listing_id:        listingId,
    user_id:           userId,
    agent_id:          await resolveAgentId(supabase as any, userId),
    post_type:         "open_house_announcement",
    platform:          "all",
    status:            "scheduled",
    approval_status:   "pending",
    scheduled_for:     new Date(marketingDate.getTime()).toISOString(),
    content:           ohCopy.body,
    created_at:        new Date().toISOString(),
    updated_at:        new Date().toISOString(),
  })

  // INSERT open_house_events for open_house_event_date
  await supabase.from("open_house_events").insert({
    brokerage_id:          brokerageId,
    listing_id:            listingId,
    agent_id:              await resolveAgentId(supabase as any, userId),
    created_by:            userId,
    event_date:            eventDate.toISOString(),
    event_type:            "open_house",
    status:                "scheduled",
    registration_required: false,
    created_at:            new Date().toISOString(),
  })

  // ── 7. transitionLifecycle + processKernelEvent ───────────────────────────
  await transitionLifecycle({
    brokerageId,
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "LISTING_AGREEMENT_INITIATED",
    toState:     "LISTING_AGREEMENT_SIGNED",
    actorUserId: userId,
    actorRole:   "agent",
    eventType:   KernelEvent.LISTING_AGREEMENT_SIGNED,
    metadata: {
      agreement_id:   agreement.id,
      provider_key:   activeProviderKey,
      upload_mode:    uploadMode,
      has_adjustment: hasAdjustment,
      go_live_date:   goLiveDate.toISOString().slice(0, 10),
    },
  })

  await processKernelEvent({
    event:            KernelEvent.LISTING_AGREEMENT_SIGNED,
    brokerageId,
  entityType:       "listing_stage_machine",
  entityId:         listingId,
  }).catch(() => {
  // Non-blocking — notification failure must not fail the agreement signing
  })

  // The agreement itself saved. If the ledger entry did not, the caller is told so
  // explicitly rather than being handed an unqualified success — a concession the
  // money engine never sees is money the seller is charged anyway.
  return { success: true, agreementId: agreement.id, ...(adjustmentWarning ? { warning: adjustmentWarning } : {}) }
}

// ─── OPEN HOUSE DATE CALCULATOR ───────────────────────────────────────────────
// Spec: marketing_date = last Friday before go_live_date
//       event_date     = next Saturday after go_live_date

function calculateOpenHouseDates(goLiveDate: Date): {
  marketingDate: Date
  eventDate: Date
} {
  const dow = goLiveDate.getDay() // 0=Sun … 6=Sat

  // Last Friday: if today IS Friday (5), go back 7 days; otherwise go back (dow+2)%7+1 days
  const daysToLastFriday = dow === 5 ? 7 : ((dow + 2) % 7) + 1
  const marketingDate = new Date(goLiveDate)
  marketingDate.setDate(goLiveDate.getDate() - daysToLastFriday)

  // Next Saturday: 0 if already Saturday is replaced by 7 (always future)
  const daysToNextSaturday = ((6 - dow + 7) % 7) || 7
  const eventDate = new Date(goLiveDate)
  eventDate.setDate(goLiveDate.getDate() + daysToNextSaturday)

  return { marketingDate, eventDate }
}

/**
 * B. Property Readiness Track
 * Record pre-listing repair requirement
 */
export async function recordPreListingRepair(params: {
  listingId: string
  repairType: string
  description: string
  vendorId?: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId, repairType, description, vendorId } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Stage transition: LISTING_AGREEMENT_SIGNED → REPAIRS_IN_PROGRESS
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "LISTING_AGREEMENT_SIGNED",
    toState:     "REPAIRS_IN_PROGRESS",
    eventType:   KernelEvent.LISTING_REPAIR_REQUIRED,
    actorUserId: userId,
    brokerageId,
    metadata: { repair_type: repairType, description, vendor_id: vendorId ?? null },
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.LISTING_REPAIR_REQUIRED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.repair.required.pre_listing",
    title:         `Pre-listing repair required: ${repairType}`,
    description,
    notes:         JSON.stringify({ listing_id: listingId, repair_type: repairType, vendor_id: vendorId ?? null }),
    status:        "in_progress",
    entity_type:   "contact",
  })

  return { success: true }
}

/**
 * Mark pre-listing repair as completed
 */
export async function markRepairCompleted(params: {
  listingId: string
  repairId: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId, repairId } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Stage transition: REPAIRS_IN_PROGRESS → COMING_SOON_PREP
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "REPAIRS_IN_PROGRESS",
    toState:     "COMING_SOON_PREP",
    eventType:   KernelEvent.LISTING_REPAIR_COMPLETED,
    actorUserId: userId,
    brokerageId,
    metadata: { repair_id: repairId },
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.LISTING_REPAIR_COMPLETED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.repair.completed.pre_listing",
    title:         "Pre-listing repair completed",
    notes:         JSON.stringify({ listing_id: listingId, repair_id: repairId }),
    status:        "completed",
    entity_type:   "contact",
  })

  return { success: true }
}

/**
 * Mark pre-listing repair as failed (blocks progression)
 */
export async function markRepairFailed(params: {
  listingId: string
  repairId: string
  reason: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId, repairId, reason } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  const { error } = await supabase.from("activities").insert({
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.repair.failed.pre_listing",
    title:         "Pre-listing repair failed",
    description:   reason,
    notes:         JSON.stringify({ listing_id: listingId, repair_id: repairId, reason }),
    status:        "completed",
    entity_type:   "contact",
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // Sub-event: kernel event + lifecycle_events row
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type:  "listing_stage_machine",
    entity_id:    listingId,
    event_type:   KernelEvent.LISTING_REPAIR_FAILED,
    actor_user_id: userId,
    metadata: { repair_id: repairId, reason },
  })
  await processKernelEvent({
    event:      KernelEvent.LISTING_REPAIR_FAILED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  return { success: true, blocked: true }
}

/**
 * C. Media & Marketing Prep Track
 * Schedule media capture
 */
export async function scheduleMediaCapture(params: {
  listingId: string
  scheduledDate: string
  vendorId?: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId, scheduledDate, vendorId } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  const { error } = await supabase.from("activities").insert({
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.media.scheduled",
    title:         `Media capture scheduled: ${scheduledDate}`,
    description:   `Media capture session scheduled`,
    notes:         JSON.stringify({ listing_id: listingId, scheduled_date: scheduledDate, vendor_id: vendorId ?? null }),
    status:        "pending",
    entity_type:   "contact",
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // Sub-event: kernel event + lifecycle_events row
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type:  "listing_stage_machine",
    entity_id:    listingId,
    event_type:   KernelEvent.LISTING_MEDIA_SCHEDULED,
    actor_user_id: userId,
    metadata: { scheduled_date: scheduledDate, vendor_id: vendorId ?? null },
  })
  await processKernelEvent({
    event:      KernelEvent.LISTING_MEDIA_SCHEDULED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  return { success: true }
}

/**
 * Mark media as captured (photos/video done)
 */
export async function markMediaCaptured(params: {
  listingId: string
  photoCount: number
  hasVideo: boolean
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId, photoCount, hasVideo } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Stage transition: COMING_SOON_PREP → MEDIA_CAPTURE
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "COMING_SOON_PREP",
    toState:     "MEDIA_CAPTURE",
    eventType:   KernelEvent.LISTING_STAGE_CHANGED,
    actorUserId: userId,
    brokerageId,
    metadata: { photo_count: photoCount, has_video: hasVideo },
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.LISTING_STAGE_CHANGED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.media.captured",
    title:         `Media captured: ${photoCount} photos${hasVideo ? ", video" : ""}`,
    description:   `${photoCount} photos captured${hasVideo ? " with video" : ""}`,
    notes:         JSON.stringify({ listing_id: listingId, photo_count: photoCount, has_video: hasVideo }),
    status:        "completed",
    entity_type:   "contact",
  })

  return { success: true }
}

/**
 * Approve media (agent or team leader)
 */
export async function approveMedia(params: {
  listingId: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
  role: "agent" | "team_lead"
}) {
  const supabase = await createClient()
  const { listingId, role } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Authority check
  if (role !== "agent" && role !== "team_lead") {
    return { success: false, error: "Only agent or team leader can approve media" }
  }

  // Stage transition: MEDIA_CAPTURE → MEDIA_APPROVED
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "MEDIA_CAPTURE",
    toState:     "MEDIA_APPROVED",
    eventType:   KernelEvent.LISTING_STAGE_CHANGED,
    actorUserId: userId,
    actorRole:   role,
    brokerageId,
    metadata: { approved_by_role: role },
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.LISTING_STAGE_CHANGED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.media.approved",
    title:         "Media approved",
    description:   `Media approved by ${role}`,
    notes:         JSON.stringify({ listing_id: listingId, approved_by_role: role }),
    status:        "completed",
    entity_type:   "contact",
  })

  return { success: true }
}

/**
 * Prepare coming soon assets (WITHOUT address)
 */
export async function prepareComingSoonAssets(params: {
  listingId: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Gate: the listing must actually be in the stage COMING_SOON_PREP is entered from.
  const stageGate = await requireListingStage(supabase, listingId, "COMING_SOON_PREP")
  if (!stageGate.ok) return { success: false, error: stageGate.error }

  // Stage transition: MEDIA_APPROVED → COMING_SOON_PREP
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "MEDIA_APPROVED",
    toState:     "COMING_SOON_PREP",
    eventType:   KernelEvent.LISTING_COMING_SOON_ASSETS_PREPARED,
    actorUserId: userId,
    brokerageId,
    metadata: { includes_address: false },
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.LISTING_COMING_SOON_ASSETS_PREPARED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.coming_soon.assets_prepared",
    title:         "Coming soon assets prepared (without address)",
    description:   "Coming soon marketing assets prepared, address withheld per compliance",
    notes:         JSON.stringify({ listing_id: listingId, includes_address: false }),
    status:        "completed",
    entity_type:   "contact",
  })

  return { success: true }
}

/**
 * Activate coming soon marketing
 */
export async function activateComingSoon(params: {
  listingId: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
  role: "agent" | "team_lead"
}) {
  const supabase = await createClient()
  const { listingId, role } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Authority check
  if (role !== "agent" && role !== "team_lead") {
    return { success: false, error: "Only agent or team leader can activate coming soon" }
  }

  // Stage transition: COMING_SOON_PREP → COMING_SOON_ACTIVE
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "COMING_SOON_PREP",
    toState:     "COMING_SOON_ACTIVE",
    eventType:   KernelEvent.COMING_SOON_SENT,
    actorUserId: userId,
    actorRole:   role,
    brokerageId,
    metadata: { activated_by_role: role },
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.COMING_SOON_SENT,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.coming_soon.activated",
    title:         "Coming soon marketing activated",
    description:   `Coming soon activated by ${role}`,
    notes:         JSON.stringify({ listing_id: listingId, activated_by_role: role }),
    status:        "completed",
    entity_type:   "contact",
  })

  return { success: true }
}

/**
 * Mark listing as MLS ready (computed, not stored)
 */
export async function markMLSReady(params: {
  listingId: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Gate: the listing must actually be in the stage MLS_READY is entered from
  // (MEDIA_APPROVED), which is only reachable through COMING_SOON_ACTIVE and
  // MEDIA_CAPTURE — so the stage itself carries "media approved AND coming soon
  // activated". The old two-row count could not express that and never matched.
  const stageGate = await requireListingStage(supabase, listingId, "MLS_READY")
  if (!stageGate.ok) return { success: false, error: stageGate.error }

  // Stage transition: COMING_SOON_ACTIVE → MLS_READY
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "COMING_SOON_ACTIVE",
    toState:     "MLS_READY",
    eventType:   KernelEvent.LISTING_STAGE_CHANGED,
    actorUserId: userId,
    brokerageId,
    metadata: {},
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.LISTING_STAGE_CHANGED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.mls.ready",
    title:         "Listing MLS ready",
    description:   "Listing cleared all gates and is ready for MLS submission",
    notes:         JSON.stringify({ listing_id: listingId }),
    status:        "completed",
    entity_type:   "contact",
  })

  return { success: true }
}

// ============================================================================
// DOMAIN 3: Market Exposure
// ============================================================================

/**
 * Approve open house marketing (REQUIRED weekend before MLS activation)
 */
export async function approveOpenHouseMarketing(params: {
  listingId: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
  role: "agent" | "team_lead"
}) {
  const supabase = await createClient()
  const { listingId, role } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Gate: the listing must actually be MLS_READY, the stage OPEN_HOUSE_MARKETING
  // is entered from.
  const stageGate = await requireListingStage(supabase, listingId, "OPEN_HOUSE_MARKETING")
  if (!stageGate.ok) return { success: false, error: stageGate.error }

  // Authority check
  if (role !== "agent" && role !== "team_lead") {
    return { success: false, error: "Only agent or team leader can approve open house marketing" }
  }

  // Stage transition: MLS_READY → OPEN_HOUSE_MARKETING
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "MLS_READY",
    toState:     "OPEN_HOUSE_MARKETING",
    eventType:   KernelEvent.OPEN_HOUSE_MARKETING_STARTED,
    actorUserId: userId,
    actorRole:   role,
    brokerageId,
    metadata: { approved_by_role: role },
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.OPEN_HOUSE_MARKETING_STARTED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.open_house_marketing.approved",
    title:         "Open house marketing approved",
    description:   `Open house marketing approved by ${role}`,
    notes:         JSON.stringify({ listing_id: listingId, approved_by_role: role }),
    status:        "completed",
    entity_type:   "contact",
  })

  return { success: true }
}

/**
 * Submit listing to admin for MLS entry
 */
export async function submitToMLSAdmin(params: {
  listingId: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Gate: open house marketing must be approved — i.e. the listing is sitting in
  // OPEN_HOUSE_MARKETING, the stage MLS_ACTIVE is entered from. Expressed against
  // the target so the requirement stays tied to the stage table rather than to a
  // hand-copied literal.
  const stageGate = await requireListingStage(supabase, listingId, "MLS_ACTIVE")
  if (!stageGate.ok) return { success: false, error: stageGate.error }

  const { error } = await supabase.from("activities").insert({
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.mls.submitted_to_admin",
    title:         "Listing submitted to MLS admin",
    description:   "Listing submitted to admin for MLS entry",
    notes:         JSON.stringify({ listing_id: listingId }),
    status:        "pending",
    entity_type:   "contact",
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // Sub-event: kernel event + lifecycle_events row
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type:  "listing_stage_machine",
    entity_id:    listingId,
    event_type:   KernelEvent.LISTING_MLS_SUBMITTED_TO_ADMIN,
    actor_user_id: userId,
    metadata: {},
  })
  await processKernelEvent({
    event:      KernelEvent.LISTING_MLS_SUBMITTED_TO_ADMIN,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  return { success: true }
}

/**
 * Activate MLS (admin only)
 */
export async function activateMLS(params: {
  listingId: string
  mlsNumber: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
  role: string
}) {
  const supabase = await createClient()
  const { listingId, mlsNumber, role } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Authority check: Admin only
  if (role !== "admin") {
    return { success: false, error: "Only admin can activate MLS" }
  }

  // Stage transition: MLS_READY → MLS_ACTIVE
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "MLS_READY",
    toState:     "MLS_ACTIVE",
    eventType:   KernelEvent.LISTING_PUBLISHED,
    actorUserId: userId,
    actorRole:   role,
    brokerageId,
    metadata: { mls_number: mlsNumber },
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.LISTING_PUBLISHED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  // CRM human task record for MLS activation (activities correct)
  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.mls.activated",
    title:         `Listing activated on MLS: ${mlsNumber}`,
    description:   `Listing published to MLS with number ${mlsNumber}`,
    notes:         JSON.stringify({ listing_id: listingId, mls_number: mlsNumber }),
    status:        "completed",
    entity_type:   "contact",
  })

  // Sub-event within MLS_ACTIVE stage — no stage change → lifecycle_events
  await supabase.from("lifecycle_events").insert({
    brokerage_id:  brokerageId,
    entity_type:   "listing_stage_machine",
    entity_id:     listingId,
    event_type:    "seller.listing.syndicated",
    actor_user_id: userId,
    metadata:      { mls_number: mlsNumber },
  })

  return { success: true }
}

/**
 * Schedule open house event
 */
export async function scheduleOpenHouse(params: {
  listingId: string
  eventDate: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId, eventDate } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Stage transition: MLS_ACTIVE → OPEN_HOUSE_EVENT
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "MLS_ACTIVE",
    toState:     "OPEN_HOUSE_EVENT",
    eventType:   KernelEvent.OPEN_HOUSE_SCHEDULED,
    actorUserId: userId,
    brokerageId,
    metadata: { event_date: eventDate },
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.OPEN_HOUSE_SCHEDULED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.open_house.scheduled",
    title:         `Open house scheduled: ${eventDate}`,
    description:   `Open house event scheduled for ${eventDate}`,
    notes:         JSON.stringify({ listing_id: listingId, event_date: eventDate }),
    status:        "pending",
    entity_type:   "contact",
    scheduled_at:  eventDate,
  })

  return { success: true }
}

/**
 * Mark open house as completed
 */
export async function markOpenHouseCompleted(params: {
  listingId: string
  attendeeCount: number
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId, attendeeCount } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Stage transition: OPEN_HOUSE_EVENT → SHOWINGS_ACTIVE
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "OPEN_HOUSE_EVENT",
    toState:     "SHOWINGS_ACTIVE",
    eventType:   KernelEvent.LISTING_OPEN_HOUSE_COMPLETED,
    actorUserId: userId,
    brokerageId,
    metadata: { attendee_count: attendeeCount },
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.LISTING_OPEN_HOUSE_COMPLETED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.open_house.completed",
    title:         `Open house completed: ${attendeeCount} attendees`,
    description:   `Open house completed with ${attendeeCount} attendees`,
    notes:         JSON.stringify({ listing_id: listingId, attendee_count: attendeeCount }),
    status:        "completed",
    entity_type:   "contact",
  })

  return { success: true }
}

/**
 * Record showing completion
 */
export async function recordShowingCompleted(params: {
  listingId: string
  showingId: string
  feedback?: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId, showingId, feedback } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  const { error } = await supabase.from("activities").insert({
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.showing.completed",
    title:         "Showing completed",
    description:   feedback ?? "Showing completed",
    notes:         JSON.stringify({ listing_id: listingId, showing_id: showingId, feedback: feedback ?? null }),
    status:        "completed",
    entity_type:   "contact",
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // Sub-event: kernel event + lifecycle_events row
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type:  "listing_stage_machine",
    entity_id:    listingId,
    event_type:   KernelEvent.LISTING_SHOWING_COMPLETED,
    actor_user_id: userId,
    metadata: { showing_id: showingId, feedback: feedback ?? null },
  })
  await processKernelEvent({
    event:      KernelEvent.LISTING_SHOWING_COMPLETED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  return { success: true }
}

// ============================================================================
// DOMAIN 4: Termination / Handoff
// ============================================================================

/**
 * Mark listing as under contract (TERMINAL - stops System 5.2)
 */
export async function markUnderContract(params: {
  listingId: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Stage transition: OFFERS_RECEIVED → UNDER_CONTRACT (terminal — stops System 5.2)
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "OFFERS_RECEIVED",
    toState:     "UNDER_CONTRACT",
    eventType:   KernelEvent.CONTRACT_SIGNED,
    actorUserId: userId,
    brokerageId,
    metadata: { terminal: true, handoff_to: "transaction_system" },
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.CONTRACT_SIGNED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.under_contract",
    title:         "Listing under contract",
    description:   "Listing moved to under contract — handed off to transaction system",
    notes:         JSON.stringify({ listing_id: listingId, terminal: true, handoff_to: "transaction_system" }),
    status:        "completed",
    entity_type:   "contact",
  })

  return { success: true, terminal: true }
}

/**
 * Cancel listing
 */
export async function cancelListing(params: {
  listingId: string
  reason: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId, reason } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Fetch current stage to use as fromState
  const { data: listingRow } = await supabase
    .from("listings")
    .select("lifecycle_stage")
    .eq("id", listingId)
    .single()

  const currentStage = listingRow?.lifecycle_stage ?? "UNKNOWN"

  // Stage transition: [current] → LISTING_CANCELLED (terminal)
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   currentStage,
    toState:     "LISTING_CANCELLED",
    eventType:   KernelEvent.LISTING_CANCELLED,
    actorUserId: userId,
    brokerageId,
    metadata: { reason, terminal: true },
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.LISTING_CANCELLED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.listing.cancelled",
    title:         "Listing cancelled",
    description:   reason,
    notes:         JSON.stringify({ listing_id: listingId, reason, terminal: true }),
    status:        "completed",
    entity_type:   "contact",
  })

  return { success: true, terminal: true }
}

/**
 * Mark listing as expired
 */
export async function markListingExpired(params: {
  listingId: string
  /** @deprecated ignored — identity is resolved from the session by the tenant gate. */
  userId?: string
  /** @deprecated ignored — resolved from the session; passing one cannot widen scope. */
  brokerageId?: string
}) {
  const supabase = await createClient()
  const { listingId } = params

  // TENANT GATE — identity from the SESSION, and the listing must belong to it.
  // The userId / brokerageId params are ignored in favour of these; a caller
  // cannot write into another brokerage's ledger by passing its id.
  const scope = await authorizeListingAction(supabase, listingId)
  if (!scope.ok) return { success: false, error: scope.error }
  const { userId, brokerageId } = scope

  // Stage transition: MLS_ACTIVE → LISTING_EXPIRED (terminal)
  const transitionResult = await transitionLifecycle({
    entityType:  "listing_stage_machine",
    entityId:    listingId,
    fromState:   "MLS_ACTIVE",
    toState:     "LISTING_EXPIRED",
    eventType:   KernelEvent.LISTING_EXPIRED,
    actorUserId: userId,
    brokerageId,
    metadata: { terminal: true },
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error ?? "Stage transition failed" }
  }

  await processKernelEvent({
    event:      KernelEvent.LISTING_EXPIRED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId:   listingId,
  }).catch(() => {})

  await logLifecycleActivity(supabase, {
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
    listing_id:    listingId,
    activity_type: "seller.listing.expired",
    title:         "Listing expired",
    description:   "Listing expired without a contract",
    notes:         JSON.stringify({ listing_id: listingId, terminal: true }),
    status:        "completed",
    entity_type:   "contact",
  })

  return { success: true, terminal: true }
}
