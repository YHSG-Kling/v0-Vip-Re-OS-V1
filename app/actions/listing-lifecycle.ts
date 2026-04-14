"use server"

import { createClient } from "@/lib/supabase/server"
import { getListingsService as getListings, createListingService as createListing } from "@/lib/application/listings"
import {
  scheduleListingAppointmentService,
  markListingSignedService,
  markListingLiveService,
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
}) {
  if (!params.listing_id || !params.contact_id) throw new Error("listing_id and contact_id are required")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  return scheduleListingAppointmentService(params, user.id, profile.brokerage_id)
}

export async function markListingSigned(params: {
  listing_id: string
  listing_agreement_signed_date: string
  go_live_date: string
  commission_rate?: number
}) {
  if (!params.listing_id) throw new Error("listing_id is required")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  return markListingSignedService(params, user.id, profile.brokerage_id)
}

export async function markListingLive(params: {
  listing_id: string
  mls_number: string
  mls_link?: string
}) {
  if (!params.listing_id || !params.mls_number) throw new Error("listing_id and mls_number are required")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  return markListingLiveService(params, user.id, profile.brokerage_id)
}

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
  notes?: string
) {
  if (!listingId || !toStage || !agentId) throw new Error("listingId, toStage, and agentId are required")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  return advanceListingStageService(listingId, toStage, agentId, notes)
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

  // Find the most recent event for this stage
  const { data: evt, error: fetchError } = await supabase
    .from("lifecycle_events")
    .select("id, metadata")
    .eq("listing_id", listingId)
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

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  return { success: true }
}
