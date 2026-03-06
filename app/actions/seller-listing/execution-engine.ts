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

  // Emit appointment scheduled event
  const { error: eventError } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.appointment.scheduled",
    status: "completed",
    metadata: { appointment_date: appointmentDate },
  })

  if (eventError) {
    return { success: false, error: eventError.message }
  }

  // Auto-trigger CMA generation
  await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.cma.started",
    status: "in_progress",
    metadata: {
      disclaimer: "This CMA follows state appraiser guidelines but is NOT an actual appraisal",
      appointment_date: appointmentDate,
    },
  })

  // Auto-trigger presentation creation
  await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.presentation.created",
    status: "in_progress",
  })

  // Auto-trigger presentation video
  await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.presentation.video_generated",
    status: "in_progress",
  })

  // Auto-trigger drip sequence prep
  await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.presentation.drip_prepared",
    status: "in_progress",
    metadata: {
      start_date: new Date().toISOString(),
      end_date: appointmentDate,
      duration_days: Math.ceil((apptDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
    },
  })

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

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.presentation.drip_completed",
    status: "completed",
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // Sub-event: kernel event + lifecycle_events row
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type:  "listing",
    entity_id:    listingId,
    event_type:   KernelEvent.LISTING_DRIP_COMPLETED,
    actor_user_id: userId,
    metadata: {},
  })
  await processKernelEvent({
    event:      KernelEvent.LISTING_DRIP_COMPLETED,
    brokerageId,
    entityType: "listing",
    entityId:   listingId,
  }).catch(() => {})

  // Emit decision readiness (human timeline)
  await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.decision.ready",
    status: "completed",
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

  const eventType =
    decision === "accepted"
      ? "seller.decision.accepted"
      : "seller.decision.declined"

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: eventType,
    status: "completed",
    metadata: { decision, reason },
  })

  if (error) {
    return { success: false, error: error.message }
  }

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

  // Gate: Requires seller.decision.accepted
  const { data: decisionEvent } = await supabase
    .from("activities")
    .select("id")
    .eq("listing_id", listingId)
    .eq("activity_type", "seller.decision.accepted")
    .single()

  if (!decisionEvent) {
    return { success: false, error: "Seller decision not accepted" }
  }

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.listing_agreement.initiated",
    status: "in_progress",
  })

  if (error) {
    return { success: false, error: error.message }
  }

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
      esign_status:                "executed",
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
      created_by_agent_id:   userId,
      adjustment_type:       commissionTerms.adjustmentType!,
      value:                 commissionTerms.adjustmentValue!,
      value_type:            commissionTerms.adjustmentValueType ?? "percent",
      notes:                 commissionTerms.adjustmentNotes ?? null,
      applies_to:            "listing",
      direction:             "reduction",
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

  // Auto-schedule social_posts for open_house_marketing_date
  await supabase.from("social_posts").insert({
    brokerage_id:      brokerageId,
    listing_id:        listingId,
    user_id:           userId,
    agent_id:          userId,
    post_type:         "open_house_announcement",
    platform:          "all",
    status:            "scheduled",
    approval_status:   "pending",
    scheduled_for:     new Date(marketingDate.getTime()).toISOString(),
    content:           `Open house event coming up! Stay tuned for details.`,
    created_at:        new Date().toISOString(),
    updated_at:        new Date().toISOString(),
  })

  // INSERT open_house_events for open_house_event_date
  await supabase.from("open_house_events").insert({
    brokerage_id:          brokerageId,
    listing_id:            listingId,
    agent_id:              userId,
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
    entityType:    "listing",
    entityId:      listingId,
    fromState:     "new",
    toState:       "active",
    actorUserId:   userId,
    actorRole:     "agent",
    eventType:     "listing_agreement_signed",
    metadata: {
      agreement_id:       agreement.id,
      provider_key:       activeProviderKey,
      upload_mode:        uploadMode,
      has_adjustment:     hasAdjustment,
      go_live_date:       goLiveDate.toISOString().slice(0, 10),
    },
  })

  await processKernelEvent({
    event:            KernelEvent.LISTING_AGREEMENT_SIGNED,
    brokerageId,
    entityType:       "listing",
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

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.repair.required.pre_listing",
    status: "in_progress",
    metadata: { repair_type: repairType, description, vendor_id: vendorId },
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // Sub-event: kernel event + lifecycle_events row
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type:  "listing",
    entity_id:    listingId,
    event_type:   KernelEvent.LISTING_REPAIR_REQUIRED,
    actor_user_id: userId,
    metadata: { repair_type: repairType, description, vendor_id: vendorId ?? null },
  })
  await processKernelEvent({
    event:      KernelEvent.LISTING_REPAIR_REQUIRED,
    brokerageId,
    entityType: "listing",
    entityId:   listingId,
  }).catch(() => {})

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

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.repair.completed.pre_listing",
    status: "completed",
    metadata: { repair_id: repairId },
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // Sub-event: kernel event + lifecycle_events row
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type:  "listing",
    entity_id:    listingId,
    event_type:   KernelEvent.LISTING_REPAIR_COMPLETED,
    actor_user_id: userId,
    metadata: { repair_id: repairId },
  })
  await processKernelEvent({
    event:      KernelEvent.LISTING_REPAIR_COMPLETED,
    brokerageId,
    entityType: "listing",
    entityId:   listingId,
  }).catch(() => {})

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
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.repair.failed.pre_listing",
    status: "failed",
    metadata: { repair_id: repairId, reason },
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // Sub-event: kernel event + lifecycle_events row
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type:  "listing",
    entity_id:    listingId,
    event_type:   KernelEvent.LISTING_REPAIR_FAILED,
    actor_user_id: userId,
    metadata: { repair_id: repairId, reason },
  })
  await processKernelEvent({
    event:      KernelEvent.LISTING_REPAIR_FAILED,
    brokerageId,
    entityType: "listing",
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
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.media.scheduled",
    status: "scheduled",
    metadata: { scheduled_date: scheduledDate, vendor_id: vendorId },
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // Sub-event: kernel event + lifecycle_events row
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type:  "listing",
    entity_id:    listingId,
    event_type:   KernelEvent.LISTING_MEDIA_SCHEDULED,
    actor_user_id: userId,
    metadata: { scheduled_date: scheduledDate, vendor_id: vendorId ?? null },
  })
  await processKernelEvent({
    event:      KernelEvent.LISTING_MEDIA_SCHEDULED,
    brokerageId,
    entityType: "listing",
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

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.media.captured",
    status: "completed",
    metadata: { photo_count: photoCount, has_video: hasVideo },
  })

  if (error) {
    return { success: false, error: error.message }
  }

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

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.media.approved",
    status: "completed",
    metadata: { approved_by_role: role },
  })

  if (error) {
    return { success: false, error: error.message }
  }

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

  // Gate: Requires media approved
  const { data: mediaEvent } = await supabase
    .from("activities")
    .select("id")
    .eq("listing_id", listingId)
    .eq("activity_type", "seller.media.approved")
    .single()

  if (!mediaEvent) {
    return { success: false, error: "Media not approved" }
  }

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.coming_soon.assets_prepared",
    status: "completed",
    metadata: { includes_address: false },
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // Sub-event: kernel event + lifecycle_events row
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type:  "listing",
    entity_id:    listingId,
    event_type:   KernelEvent.LISTING_COMING_SOON_ASSETS_PREPARED,
    actor_user_id: userId,
    metadata: { includes_address: false },
  })
  await processKernelEvent({
    event:      KernelEvent.LISTING_COMING_SOON_ASSETS_PREPARED,
    brokerageId,
    entityType: "listing",
    entityId:   listingId,
  }).catch(() => {})

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

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.coming_soon.activated",
    status: "completed",
    metadata: { activated_by_role: role },
  })

  if (error) {
    return { success: false, error: error.message }
  }

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

  // Gate: Requires media approved + coming soon activated
  const { data: gates } = await supabase
    .from("activities")
    .select("activity_type")
    .eq("listing_id", listingId)
    .in("activity_type", ["seller.media.approved", "seller.coming_soon.activated"])

  if (!gates || gates.length < 2) {
    return { success: false, error: "Media not approved or coming soon not activated" }
  }

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.mls.ready",
    status: "completed",
  })

  if (error) {
    return { success: false, error: error.message }
  }

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

  // Gate: Requires MLS ready
  const { data: mlsReady } = await supabase
    .from("activities")
    .select("id")
    .eq("listing_id", listingId)
    .eq("activity_type", "seller.mls.ready")
    .single()

  if (!mlsReady) {
    return { success: false, error: "Listing not MLS ready" }
  }

  // Authority check
  if (role !== "agent" && role !== "team_lead") {
    return { success: false, error: "Only agent or team leader can approve open house marketing" }
  }

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.open_house_marketing.approved",
    status: "completed",
    metadata: { approved_by_role: role },
  })

  if (error) {
    return { success: false, error: error.message }
  }

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

  // Gate: Requires open house marketing approved
  const { data: openHouseApproved } = await supabase
    .from("activities")
    .select("id")
    .eq("listing_id", listingId)
    .eq("activity_type", "seller.open_house_marketing.approved")
    .single()

  if (!openHouseApproved) {
    return { success: false, error: "Open house marketing not approved" }
  }

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.mls.submitted_to_admin",
    status: "pending",
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // Sub-event: kernel event + lifecycle_events row
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type:  "listing",
    entity_id:    listingId,
    event_type:   KernelEvent.LISTING_MLS_SUBMITTED_TO_ADMIN,
    actor_user_id: userId,
    metadata: {},
  })
  await processKernelEvent({
    event:      KernelEvent.LISTING_MLS_SUBMITTED_TO_ADMIN,
    brokerageId,
    entityType: "listing",
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

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.mls.activated",
    status: "completed",
    metadata: { mls_number: mlsNumber },
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // Auto-emit syndication event
  await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.listing.syndicated",
    status: "in_progress",
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

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.open_house.scheduled",
    status: "scheduled",
    metadata: { event_date: eventDate },
  })

  if (error) {
    return { success: false, error: error.message }
  }

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

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.open_house.completed",
    status: "completed",
    metadata: { attendee_count: attendeeCount },
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // Sub-event: kernel event + lifecycle_events row
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type:  "listing",
    entity_id:    listingId,
    event_type:   KernelEvent.LISTING_OPEN_HOUSE_COMPLETED,
    actor_user_id: userId,
    metadata: { attendee_count: attendeeCount },
  })
  await processKernelEvent({
    event:      KernelEvent.LISTING_OPEN_HOUSE_COMPLETED,
    brokerageId,
    entityType: "listing",
    entityId:   listingId,
  }).catch(() => {})

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
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.showing.completed",
    status: "completed",
    metadata: { showing_id: showingId, feedback },
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // Sub-event: kernel event + lifecycle_events row
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type:  "listing",
    entity_id:    listingId,
    event_type:   KernelEvent.LISTING_SHOWING_COMPLETED,
    actor_user_id: userId,
    metadata: { showing_id: showingId, feedback: feedback ?? null },
  })
  await processKernelEvent({
    event:      KernelEvent.LISTING_SHOWING_COMPLETED,
    brokerageId,
    entityType: "listing",
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

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.under_contract",
    status: "completed",
    metadata: { terminal: true, handoff_to: "transaction_system" },
  })

  if (error) {
    return { success: false, error: error.message }
  }

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

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.listing.cancelled",
    status: "completed",
    metadata: { reason, terminal: true },
  })

  if (error) {
    return { success: false, error: error.message }
  }

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

  const { error } = await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    listing_id: listingId,
    user_id: userId,
    activity_type: "seller.listing.expired",
    status: "completed",
    metadata: { terminal: true },
  })

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, terminal: true }
}
