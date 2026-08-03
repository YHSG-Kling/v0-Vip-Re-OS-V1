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
import { auditListingDocuments } from "@/lib/compliance/required-documents"
import { scanListingPacketCompleteness } from "@/lib/workflow/intelligence/scan-offer-packet"
import { notifyComplianceFlag } from "@/lib/notifications/notify-helpers"
import { LISTING_AGREEMENT_EXECUTED_STATUS } from "@/lib/transactions/coordination-status"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { isValidUUID } from "@/lib/validations"
import { resolveProvider } from "@/lib/kernel/providers"
import { transitionLifecycle, processKernelEvent } from "@/lib/kernel"
import { KernelEvent } from "@/lib/kernel/events"

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

export async function scheduleListingAppointment(params: {
  listingId: string
  appointmentDate: string // ISO date
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, appointmentDate, userId, brokerageId } = params

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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, userId, brokerageId } = params

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
  userId: string
  brokerageId: string
  reason?: string
}) {
  const supabase = await createClient()
  const { listingId, decision, userId, brokerageId, reason } = params

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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, userId, brokerageId } = params

  // Gate: Requires seller.decision.accepted — check lifecycle_events (activities has no listing_id)
  const { data: decisionEvent } = await supabase
    .from("lifecycle_events")
    .select("id")
    .eq("entity_id", listingId)
    .eq("event_type", "seller.decision.accepted")
    .limit(1)
    .maybeSingle()

  if (!decisionEvent) {
    return { success: false, error: "Seller decision not accepted" }
  }

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
 * 1. Resolve esign + transaction provider via provider_overrides cascade.
 * 2. Load integration_credentials for resolved provider_key.
 * 3. If manual_upload: store documentUrl to listing_agreements.
 *    If provider_pull: store providerRef to listing_agreements.
 * 4. INSERT listing_agreements (commission terms + document refs).
 * 5. If has commission adjustment: INSERT commission_adjustments.
 * 6. Set go_live_date on listings + calculate open house dates.
 * 7. Call transitionLifecycle() → lifecycle_events + processKernelEvent().
 */
export async function markAgreementSigned(params: {
  listingId: string
  userId: string
  brokerageId: string
  uploadMode: "manual_upload" | "provider_pull"
  documentUrl?: string
  providerRef?: string
  commissionTerms?: {
    listingRate?: number
    buyerRate?: number
    isFlatFee?: boolean
    flatAmount?: number
    adjustmentType?: string
    adjustmentValue?: number
    adjustmentValueType?: "percent" | "flat"
    adjustmentNotes?: string
  }
}) {
  const supabase = await createClient()
  const { listingId, userId, brokerageId, uploadMode, documentUrl, providerRef, commissionTerms } = params

  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }

  // ── 1. Resolve providers via kernel cascade ───────────────────────────────
  const actorContext = { userId, brokerageId }

  const [esignResolved, transactionResolved] = await Promise.all([
    resolveProvider({ providerType: "esign",       actorContext }),
    resolveProvider({ providerType: "transaction",  actorContext }),
  ])

  const activeProviderKey = esignResolved.providerKey

  // ── 2. Load integration_credentials for the resolved provider_key ─────────
  const { data: creds } = await supabase
    .from("integration_credentials")
    .select("id, provider_name, api_key, api_secret, webhook_url")
    .eq("brokerage_id", brokerageId)
    .eq("provider_name", activeProviderKey)
    .eq("is_active", true)
    .maybeSingle()

  // Credentials optional — provider may not require them (manual_upload path)

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

  const docAudit = await auditListingDocuments(supabase as any, {
    brokerageId,
    // The seller lives in seller_contact_id. listings.contact_id exists but is
    // not populated (0 of 3 rows live), so this had been passing null and the
    // audit skipped every document filed against the seller's CONTACT record.
    // Raised in review; the readiness gate carried the same mistake and both
    // were corrected together so the two checkpoints stay in agreement.
    sellerContactId: ((listingRow?.seller_contact_id ?? listingRow?.contact_id) as string | null) ?? null,
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

  if (blockingDocs.length > 0 || packetBlockers.length > 0 || !packetScan.success) {
    const bits: string[] = []
    if (blockingDocs.length > 0)   bits.push(`${blockingDocs.length} required document(s) missing`)
    if (packetBlockers.length > 0) bits.push(`${packetBlockers.length} packet blocker(s)`)
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
  const hasAdjustment = !!(commissionTerms?.adjustmentType && commissionTerms?.adjustmentValue !== undefined)

  const { data: agreement, error: agreementError } = await supabase
    .from("listing_agreements")
    .insert({
      listing_id:                  listingId,
      brokerage_id:                brokerageId,
      agent_user_id:               userId,
      upload_mode:                 uploadMode,
      provider_name:               activeProviderKey,
      document_url:                uploadMode === "manual_upload" ? (documentUrl ?? null) : null,
      provider_ref:                uploadMode === "provider_pull" ? (providerRef ?? null) : null,
      esign_status:                LISTING_AGREEMENT_EXECUTED_STATUS,
      agreement_type:              "listing",
      seller_signed_at:            new Date().toISOString(),
      agent_signed_at:             new Date().toISOString(),
      fully_executed_at:           new Date().toISOString(),
      listing_commission_rate:     commissionTerms?.listingRate ?? null,
      buyer_commission_rate:       commissionTerms?.buyerRate ?? null,
      commission_is_flat_fee:      commissionTerms?.isFlatFee ?? false,
      commission_flat_amount:      commissionTerms?.flatAmount ?? null,
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
  if (hasAdjustment && commissionTerms) {
    await supabase.from("commission_adjustments").insert({
      brokerage_id:          brokerageId,
      created_by_agent_id:   await resolveAgentId(supabase as any, userId),
      adjustment_type:       commissionTerms.adjustmentType!,
      value:                 commissionTerms.adjustmentValue!,
      value_type:            commissionTerms.adjustmentValueType ?? "percent",
      notes:                 commissionTerms.adjustmentNotes ?? null,
      // commission_adjustments.applies_to is (gross|agent|brokerage) — a
      // seller-negotiated listing concession comes off the GROSS commission —
      // and direction is (credit|surcharge); a reduction IS a credit.
      applies_to:            "gross",
      direction:             "credit",
      is_active:             true,
      effective_date:        new Date().toISOString().slice(0, 10),
    })
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

  return { success: true, agreementId: agreement.id }
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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, repairType, description, vendorId, userId, brokerageId } = params

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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, repairId, userId, brokerageId } = params

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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, repairId, reason, userId, brokerageId } = params

  const { error } = await supabase.from("activities").insert({
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, scheduledDate, vendorId, userId, brokerageId } = params

  const { error } = await supabase.from("activities").insert({
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, photoCount, hasVideo, userId, brokerageId } = params

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
  userId: string
  brokerageId: string
  role: "agent" | "team_lead"
}) {
  const supabase = await createClient()
  const { listingId, userId, brokerageId, role } = params

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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, userId, brokerageId } = params

  // Gate: Requires media approved — check lifecycle_events (activities has no listing_id)
  const { data: mediaEvent } = await supabase
    .from("lifecycle_events")
    .select("id")
    .eq("entity_id", listingId)
    .eq("event_type", KernelEvent.LISTING_STAGE_CHANGED)
    .limit(1)
    .maybeSingle()

  if (!mediaEvent) {
    return { success: false, error: "Media not approved" }
  }

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
  userId: string
  brokerageId: string
  role: "agent" | "team_lead"
}) {
  const supabase = await createClient()
  const { listingId, userId, brokerageId, role } = params

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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, userId, brokerageId } = params

  // Gate: Requires media approved + coming soon activated — check lifecycle_events
  const { data: gates } = await supabase
    .from("lifecycle_events")
    .select("event_type")
    .eq("entity_id", listingId)
    .in("event_type", [KernelEvent.LISTING_STAGE_CHANGED, KernelEvent.COMING_SOON_SENT])

  if (!gates || gates.length < 2) {
    return { success: false, error: "Media not approved or coming soon not activated" }
  }

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
  userId: string
  brokerageId: string
  role: "agent" | "team_lead"
}) {
  const supabase = await createClient()
  const { listingId, userId, brokerageId, role } = params

  // Gate: Requires MLS ready — check lifecycle_events (activities has no listing_id)
  const { data: mlsReady } = await supabase
    .from("lifecycle_events")
    .select("id")
    .eq("entity_id", listingId)
    .eq("event_type", KernelEvent.LISTING_STAGE_CHANGED)
    .limit(1)
    .maybeSingle()

  if (!mlsReady) {
    return { success: false, error: "Listing not MLS ready" }
  }

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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, userId, brokerageId } = params

  // Gate: Requires open house marketing approved — check lifecycle_events
  const { data: openHouseApproved } = await supabase
    .from("lifecycle_events")
    .select("id")
    .eq("entity_id", listingId)
    .eq("event_type", KernelEvent.OPEN_HOUSE_MARKETING_STARTED)
    .limit(1)
    .maybeSingle()

  if (!openHouseApproved) {
    return { success: false, error: "Open house marketing not approved" }
  }

  const { error } = await supabase.from("activities").insert({
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
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
  userId: string
  brokerageId: string
  role: string
}) {
  const supabase = await createClient()
  const { listingId, mlsNumber, userId, brokerageId, role } = params

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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, eventDate, userId, brokerageId } = params

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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, attendeeCount, userId, brokerageId } = params

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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, showingId, feedback, userId, brokerageId } = params

  const { error } = await supabase.from("activities").insert({
    brokerage_id:  brokerageId,
    agent_id:      await resolveAgentId(supabase as any, userId),
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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, userId, brokerageId } = params

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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, reason, userId, brokerageId } = params

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
  userId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { listingId, userId, brokerageId } = params

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
    activity_type: "seller.listing.expired",
    title:         "Listing expired",
    description:   "Listing expired without a contract",
    notes:         JSON.stringify({ listing_id: listingId, terminal: true }),
    status:        "completed",
    entity_type:   "contact",
  })

  return { success: true, terminal: true }
}
