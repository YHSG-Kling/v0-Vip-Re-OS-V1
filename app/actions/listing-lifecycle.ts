"use server"

import { createClient } from "@/lib/supabase/server"
import { getListingsService as getListings, createListingService as createListing } from "@/lib/application/listings"
import {
  scheduleListingAppointmentService,
  updateListingStageService,
  advanceListingStageService,
  getListingTimelineService,
  getListingTasksService,
  completeListingTaskService,
  handleListingAppointmentBookedService,
  handleListingAgreementSignedService,
  handleListingLiveService,
  handlePriceReductionService,
  handleOfferReceivedService,
  handleContingencyClearedService,
  handleClosingApproachingService,
  triggerReviewSequenceService,
  sendReviewRequestService,
  scheduleClosingGift,
} from "@/lib/application/listing-lifecycle"

// Re-exports moved to direct imports from listings.ts
export { getListings, createListing }

// =====================================================
// LISTING LIFECYCLE SERVER ACTIONS
// Thin wrappers: validate → authenticate → delegate
// =====================================================

export async function scheduleListingAppointment(params: {
  listing_id: string
  contact_id: string
  appointment_date: string
  appointment_time: string
  notes?: string
  /** "zoom" attempts a REAL Zoom meeting on the booker's connected scope
   *  (agent → team → brokerage); honest in-person default when not connected. */
  meeting_mode?: "zoom" | "in_person"
}) {
  if (!params.listing_id || !params.contact_id) throw new Error("listing_id and contact_id are required")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  const result = await scheduleListingAppointmentService(params, user.id, profile.brokerage_id)

  // Fire the listing-appt-prep chain so the LISTING-side appointment ALSO runs the full managed
  // prep (CMA → presentation built from it → per-chapter videos → pre-appointment drip → pre-listing
  // postcard/letter), exactly like the contact-side bookSellerListingAppointment path. The service
  // emits 'listing_appointment_scheduled' which matched NO chain/handler, so listing-side
  // appointments silently skipped the entire prep. Chains trigger via triggerChainsForEvent (an
  // app/ action — can't be imported from the lib/ service), so it's wired here. Best-effort — the
  // appointment is already booked even if the chain trigger fails.
  try {
    const { data: listing } = await supabase
      .from("listings")
      .select("address, city, state, zip, bedrooms, bathrooms, sqft, lot_size, year_built, property_type")
      .eq("id", params.listing_id)
      .maybeSingle()
    const appointmentAt =
      (result as { listing?: { appointment_at?: string } } | null)?.listing?.appointment_at ??
      new Date(`${params.appointment_date}T${params.appointment_time}`).toISOString()
    const { triggerChainsForEvent } = await import("@/app/actions/workflow-orchestrator")
    const { listingApptPrepDedupeKey } = await import("@/lib/workflow-orchestrator/chains/listing-appt-prep")
    await triggerChainsForEvent({
      eventType: "listing.appointment_set",
      // Per-listing dedupe key — collapses this with the stage-pipeline + calendar paths into ONE prep.
      triggerEventId: listingApptPrepDedupeKey(params.listing_id),
      brokerageId: profile.brokerage_id,
      contactId: params.contact_id,
      agentUserId: user.id,
      listingId: params.listing_id,
      metadata: {
        appointment_date: appointmentAt,
        property_data: listing
          ? {
              address: listing.address, city: listing.city, state: listing.state, zip: listing.zip,
              bedrooms: listing.bedrooms, bathrooms: listing.bathrooms, sqft: listing.sqft,
              lotSize: listing.lot_size, yearBuilt: listing.year_built,
              propertyType: listing.property_type ?? "single_family",
            }
          : {},
      },
    })
  } catch (err) {
    console.error("[scheduleListingAppointment] listing-appt-prep chain trigger failed:", err)
  }

  return result
}

// markListingSigned + markListingLive RETIRED — the UI drives go-live / agreement-signed through
// advanceListingStage (triggerStageActions owns those stage cases + the MLS packet queue). These
// duplicated that with orphaned-event side effects that never fired.

export async function updateListingStage(params: {
  listing_id: string
  stage: string
  notes?: string
}) {
  if (!params.listing_id || !params.stage) throw new Error("listing_id and stage are required")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  return updateListingStageService(params)
}

export async function advanceListingStage(
  listingId: string,
  toStage: string,
  agentId: string,
  notes?: string,
  /** Manual override — requires broker / admin / superadmin / compliance role
   *  + min 10-char reason. Bypasses stage prerequisite checks; writes audit
   *  row with the override reason + actor for compliance. */
  overrideReason?: string,
) {
  if (!listingId || !toStage || !agentId) throw new Error("listingId, toStage, and agentId are required")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  if (overrideReason) {
    const { requireOverrideActor, PortalAuthError } = await import("@/lib/kernel/portal-auth")
    let overrideCtx
    try {
      overrideCtx = await requireOverrideActor(overrideReason)
    } catch (err) {
      if (err instanceof PortalAuthError) throw err
      throw err
    }

    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()

    // Verify listing scope
    const { data: listing } = await svc
      .from("listings")
      .select("id, brokerage_id, lifecycle_stage")
      .eq("id", listingId)
      .eq("brokerage_id", overrideCtx.brokerageId)
      .maybeSingle()
    if (!listing) throw new Error("Listing not found in your brokerage")

    // Force stage transition
    const { error: updateErr } = await svc
      .from("listings")
      .update({ lifecycle_stage: toStage, updated_at: new Date().toISOString() })
      .eq("id", listingId)
      .eq("brokerage_id", overrideCtx.brokerageId)
    if (updateErr) throw updateErr

    // Audit trail
    await svc.from("lifecycle_events").insert({
      brokerage_id:  overrideCtx.brokerageId,
      entity_type:   "listing",
      entity_id:     listingId,
      event_type:    "listing.stage_overridden",
      actor_user_id: overrideCtx.userId,
      metadata: {
        from_stage:           listing.lifecycle_stage,
        to_stage:             toStage,
        override_reason:      overrideCtx.reason,
        override_actor:       overrideCtx.userId,
        override_user_type:   overrideCtx.userType,
        notes:                notes ?? null,
      },
      created_at: new Date().toISOString(),
    })

    // A manual override still RUNS the stage's automations — the listing IS now at this stage, so its
    // managers must act (prep chain, packet, …). The override only bypassed the PREREQUISITE gates.
    await fireStageAutomations(listingId, toStage, overrideCtx.userId)

    return { success: true, listingId, fromStage: listing.lifecycle_stage, toStage }
  }

  const result = await advanceListingStageService(listingId, toStage, agentId, notes)

  // Run the canonical-stage automations (prep chain, packet) — see fireStageAutomations.
  await fireStageAutomations(listingId, toStage, user.id)

  return result
}

/**
 * Canonical-stage automations, fired at the ACTION layer in BOTH the normal and override paths.
 *
 * WHY HERE (not triggerStageActions): triggerStageActions (lib/application) switches on a LEGACY
 * lowercase stage vocabulary ("appointment_scheduled", "mls_active", "cma_prepared", …) that no longer
 * matches the canonical UPPERCASE lifecycle stages ("APPOINTMENT_SET", "MLS_ACTIVE", …), so it hits
 * `default` for every real UI stage advance — the stage automations there are dead. Reconciling that
 * whole legacy switch is a dedicated pass; meanwhile the highest-value automations are fired here on
 * the CANONICAL stage names so they actually run. A manual OVERRIDE bypasses prerequisites, not these
 * consequences — the stage IS now that stage, so its automations must reflect reality.
 */
async function fireStageAutomations(listingId: string, toStage: string, actorUserId: string): Promise<void> {
  try {
    const { stageAutomationFor } = await import("@/lib/listing-lifecycle/stage-automations")
    const automation = stageAutomationFor(toStage)
    if (!automation) return

    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()

    if (automation === "listing_appt_prep") {
      // Flagship pre-listing prep: CMA → presentation → chapter videos → pre-appointment drip →
      // pre-listing postcard. Deterministic per-listing key collapses with the calendar + AI-ISA
      // booking paths into ONE prep run (no double CMA/postcard).
      const { data: listing } = await svc
        .from("listings")
        .select("brokerage_id, contact_id, seller_contact_id, appointment_at, address, city, state, zip, bedrooms, bathrooms, sqft, lot_size, year_built, property_type")
        .eq("id", listingId)
        .maybeSingle()
      if (listing?.brokerage_id) {
        const { triggerChainsForEvent } = await import("@/app/actions/workflow-orchestrator")
        const { listingApptPrepDedupeKey } = await import("@/lib/workflow-orchestrator/chains/listing-appt-prep")
        await triggerChainsForEvent({
          eventType: "listing.appointment_set",
          triggerEventId: listingApptPrepDedupeKey(listingId),
          brokerageId: listing.brokerage_id,
          contactId: listing.contact_id ?? listing.seller_contact_id ?? null,
          agentUserId: actorUserId,
          listingId,
          metadata: {
            appointment_date: listing.appointment_at ?? null,
            property_data: {
              address: listing.address, city: listing.city, state: listing.state, zip: listing.zip,
              bedrooms: listing.bedrooms, bathrooms: listing.bathrooms, sqft: listing.sqft,
              lotSize: listing.lot_size, yearBuilt: listing.year_built,
              propertyType: listing.property_type ?? "single_family",
            },
          },
        })
      }
    } else if (automation === "mls_packet") {
      // Queue the MLS listing packet on go-live (idempotent — skip if one already exists). Restored
      // here on the canonical stage after the retired markListingLiveService (the legacy
      // triggerStageActions "mls_active" case is dead).
      const { data: existing } = await svc
        .from("listing_packet_jobs")
        .select("id")
        .eq("listing_id", listingId)
        .eq("job_type", "mls_packet")
        .limit(1)
        .maybeSingle()
      if (!existing) {
        await svc.from("listing_packet_jobs").insert({
          listing_id: listingId,
          agent_user_id: actorUserId, // FK → users.id
          job_type: "mls_packet",
          status: "pending",
          config: { includeFlyer: true, includeDisclosures: true, includePropertyReports: true, includeBinderCopies: true },
        })
      }
    }
  } catch (err) {
    console.error("[fireStageAutomations] failed:", err)
  }
}

export async function getListingTimeline(listingId: string) {
  if (!listingId) throw new Error("listingId is required")
  return getListingTimelineService(listingId)
}

export async function getListingTasks(listingId: string) {
  if (!listingId) throw new Error("listingId is required")
  return getListingTasksService(listingId)
}

export async function completeListingTask(taskId: string) {
  if (!taskId) throw new Error("taskId is required")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  return completeListingTaskService(taskId)
}

// =====================================================
// EVENT HANDLERS - Called by orchestrator
// =====================================================

export async function handleListingAppointmentBooked(payload: any) {
  return handleListingAppointmentBookedService(payload)
}

export async function handleListingAgreementSigned(payload: any) {
  return handleListingAgreementSignedService(payload)
}

export async function handleListingLive(payload: any) {
  return handleListingLiveService(payload)
}

export async function handlePriceReduction(payload: any) {
  return handlePriceReductionService(payload)
}

export async function handleOfferReceived(payload: any) {
  return handleOfferReceivedService(payload)
}

export async function handleContingencyCleared(payload: any) {
  return handleContingencyClearedService(payload)
}

export async function handleClosingApproaching(payload: any) {
  return handleClosingApproachingService(payload)
}

export async function triggerReviewSequence(payload: any) {
  return triggerReviewSequenceService(payload)
}

export async function sendReviewRequest(requestId: string, platform: string) {
  if (!requestId || !platform) throw new Error("requestId and platform are required")
  return sendReviewRequestService(requestId, platform)
}

// Export for orchestrator
export { scheduleClosingGift }

// ─── Portal Visibility ────────────────────────────────────────────────────────

/**
 * Set portal_visible flag on the most recent lifecycle_event for a given stage.
 * Agents use this to share milestone updates with the buyer/seller portal.
 */
export async function setMilestonePortalVisibility(
  listingId: string,
  stage: string,
  visible: boolean
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }
  const { data: callerRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" }

  // Verify the listing belongs to caller's brokerage before changing portal visibility
  const { data: listing } = await supabase
    .from("listings")
    .select("brokerage_id")
    .eq("id", listingId)
    .maybeSingle()
  if (!listing) return { success: false, error: "Listing not found" }
  if (listing.brokerage_id !== callerRow.brokerage_id) {
    return { success: false, error: "Forbidden" }
  }

  // Find the most recent event for this stage — scoped to caller's brokerage
  const { data: evt, error: fetchError } = await supabase
    .from("lifecycle_events")
    .select("id, metadata")
    .eq("entity_type", "listing")
    .eq("entity_id", listingId)
    .eq("brokerage_id", callerRow.brokerage_id)
    .eq("metadata->>to_state", stage)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (fetchError || !evt) {
    return { success: false, error: fetchError?.message ?? "Event not found" }
  }

  const updatedMetadata = { ...(evt.metadata ?? {}), portal_visible: visible }

  const { error: updateError } = await supabase
    .from("lifecycle_events")
    .update({ metadata: updatedMetadata })
    .eq("id", evt.id)
    .eq("brokerage_id", callerRow.brokerage_id)

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  return { success: true }
}
