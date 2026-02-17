"use server"

/**
 * System 7.1B - Status Column Sync
 * 
 * The offers.status column is an OPERATIONAL INDEX ONLY.
 * It REFLECTS lifecycle but never DRIVES lifecycle.
 * 
 * After every lifecycle event, status must be updated to match.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"

const EVENT_TO_STATUS: Record<string, string> = {
  "buyer.offer.draft.created": "draft",
  "buyer.offer.signature.requested": "submitted",
  "buyer.offer.sent.to.listing.agent": "under_review",
  "buyer.offer.counter.received": "countered",
  "buyer.offer.accepted": "accepted",
  "buyer.offer.rejected": "rejected",
  "buyer.offer.withdrawn": "withdrawn",
  "buyer.offer.expired": "expired",
  "buyer.offer.voided": "voided",
}

/**
 * Sync offers.status to match latest lifecycle event
 * 
 * Call this after emitting any lifecycle event.
 */
export async function syncOfferStatus(
  offerId: string
): Promise<{ success: boolean; newStatus?: string; error?: string }> {
  if (!isValidUUID(offerId)) {
    return { success: false, error: "Invalid offer ID" }
  }

  const supabase = createServiceClient()

  // Get latest lifecycle event
  const { data: latestEvent, error: eventError } = await supabase
    .from("activities")
    .select("activity_type, created_at")
    .eq("entity_type", "offer")
    .eq("entity_id", offerId)
    .in("activity_type", Object.keys(EVENT_TO_STATUS))
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (eventError) {
    console.error("[System 7.1B] Error fetching latest event:", eventError)
    return { success: false, error: eventError.message }
  }

  if (!latestEvent) {
    return { success: false, error: "No lifecycle events found" }
  }

  const newStatus = EVENT_TO_STATUS[latestEvent.activity_type]

  if (!newStatus) {
    return { success: false, error: "Unknown event type" }
  }

  // Update offers.status
  const { error: updateError } = await supabase
    .from("offers")
    .update({ status: newStatus })
    .eq("id", offerId)

  if (updateError) {
    console.error("[System 7.1B] Error updating status:", updateError)
    return { success: false, error: updateError.message }
  }

  return { success: true, newStatus }
}

/**
 * Get current offer status (derived from events)
 */
export async function getCurrentOfferStatus(
  offerId: string
): Promise<{ success: boolean; status?: string; error?: string }> {
  if (!isValidUUID(offerId)) {
    return { success: false, error: "Invalid offer ID" }
  }

  const supabase = createServiceClient()

  const { data: latestEvent, error } = await supabase
    .from("activities")
    .select("activity_type")
    .eq("entity_type", "offer")
    .eq("entity_id", offerId)
    .in("activity_type", Object.keys(EVENT_TO_STATUS))
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error("[System 7.1B] Error fetching status:", error)
    return { success: false, error: error.message }
  }

  if (!latestEvent) {
    return { success: false, error: "No events found" }
  }

  const status = EVENT_TO_STATUS[latestEvent.activity_type]

  return { success: true, status }
}
