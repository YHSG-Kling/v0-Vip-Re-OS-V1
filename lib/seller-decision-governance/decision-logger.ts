/**
 * System 5.3: CMA & Listing Presentation Governance Engine
 * Decision Event Logger
 * 
 * Logs all seller decision events to activities table:
 * - State transitions
 * - CMA quality verification
 * - Net sheet expiration
 * - Presentation assembly
 * - Decision reversals
 * - Override tracking
 * 
 * This is GOVERNANCE ONLY - events only, no state storage
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import type { SellerDecisionState } from "./decision-state-definitions"

export interface DecisionTransitionEvent {
  listing_id: string
  from_state?: SellerDecisionState
  to_state: SellerDecisionState
  authority_role: "agent" | "team_lead" | "broker" | "admin"
  override_flag?: boolean
  override_reason?: string
  metadata?: Record<string, any>
}

export interface CMAQualityEvent {
  listing_id: string
  comparable_count: number
  oldest_comparable_months: number
  max_radius_miles: number
  quality_score: number
  approved_by_role: string
  metadata?: Record<string, any>
}

export interface NetSheetEvent {
  listing_id: string
  event_type: "generated" | "expired" | "expiration_warning" | "regenerated"
  days_remaining?: number
  validity_days?: number
  metadata?: Record<string, any>
}

export interface PresentationEvent {
  listing_id: string
  event_type: "assembled" | "video_ready" | "drip_started" | "drip_paused"
  metadata?: Record<string, any>
}

export interface DecisionReversalEvent {
  listing_id: string
  from_state: SellerDecisionState
  reversal_reason: string
  authority_role: string
  metadata?: Record<string, any>
}

// Agent task (correct location, no changes) — event_type: seller.decision.transition, seller.cma.quality_verified, seller.net_sheet.*, seller.presentation.*
/**
 * Log decision state transition
 */
export async function logDecisionTransition(event: DecisionTransitionEvent): Promise<void> {
  if (!isValidUUID(event.listing_id)) {
    console.error("[v0] Invalid listing_id in logDecisionTransition")
    return
  }
  
  const supabase = await createClient()
  
  await supabase.from("activities").insert({
    listing_id: event.listing_id,
    event_type: "seller.decision.transition",
    metadata: {
      from_state: event.from_state,
      to_state: event.to_state,
      authority_role: event.authority_role,
      override_flag: event.override_flag || false,
      override_reason: event.override_reason,
      ...event.metadata,
    },
  })
}

/**
 * Log CMA quality verification
 */
export async function logCMAQualityVerified(event: CMAQualityEvent): Promise<void> {
  if (!isValidUUID(event.listing_id)) {
    console.error("[v0] Invalid listing_id in logCMAQualityVerified")
    return
  }
  
  const supabase = await createClient()
  
  await supabase.from("activities").insert({
    listing_id: event.listing_id,
    event_type: "seller.cma.quality_verified",
    metadata: {
      comparable_count: event.comparable_count,
      oldest_comparable_months: event.oldest_comparable_months,
      max_radius_miles: event.max_radius_miles,
      quality_score: event.quality_score,
      approved_by_role: event.approved_by_role,
      ...event.metadata,
    },
  })
}

/**
 * Log net sheet event
 */
export async function logNetSheetEvent(event: NetSheetEvent): Promise<void> {
  if (!isValidUUID(event.listing_id)) {
    console.error("[v0] Invalid listing_id in logNetSheetEvent")
    return
  }
  
  const supabase = await createClient()
  
  const eventTypeMap = {
    generated: "seller.net_sheet.generated",
    expired: "seller.net_sheet.expired",
    expiration_warning: "seller.net_sheet.expiration_warning",
    regenerated: "seller.net_sheet.regenerated",
  }
  
  await supabase.from("activities").insert({
    listing_id: event.listing_id,
    event_type: eventTypeMap[event.event_type],
    metadata: {
      days_remaining: event.days_remaining,
      validity_days: event.validity_days,
      ...event.metadata,
    },
  })
}

/**
 * Log presentation event
 */
export async function logPresentationEvent(event: PresentationEvent): Promise<void> {
  if (!isValidUUID(event.listing_id)) {
    console.error("[v0] Invalid listing_id in logPresentationEvent")
    return
  }
  
  const supabase = await createClient()
  
  const eventTypeMap = {
    assembled: "seller.presentation.assembled",
    video_ready: "seller.presentation_video.ready",
    drip_started: "seller.presentation_drip.started",
    drip_paused: "seller.presentation_drip.paused",
  }
  
  await supabase.from("activities").insert({
    listing_id: event.listing_id,
    event_type: eventTypeMap[event.event_type],
    metadata: event.metadata || {},
  })
}

/**
 * Log decision reversal
 */
export async function logDecisionReversal(event: DecisionReversalEvent): Promise<void> {
  if (!isValidUUID(event.listing_id)) {
    console.error("[v0] Invalid listing_id in logDecisionReversal")
    return
  }
  
  const supabase = await createClient()
  
  await supabase.from("activities").insert({
    listing_id: event.listing_id,
    event_type: "seller.decision.reversed",
    metadata: {
      from_state: event.from_state,
      reversal_reason: event.reversal_reason,
      authority_role: event.authority_role,
      ...event.metadata,
    },
  })
}

/**
 * Batch log multiple events
 */
export async function batchLogEvents(
  listingId: string,
  events: Array<{
    eventType: string
    metadata?: Record<string, any>
  }>
): Promise<void> {
  if (!isValidUUID(listingId)) {
    console.error("[v0] Invalid listing_id in batchLogEvents")
    return
  }
  
  if (events.length === 0) return
  
  const supabase = await createClient()
  
  const activities = events.map((event) => ({
    listing_id: listingId,
    event_type: event.eventType,
    metadata: event.metadata || {},
  }))
  
  await supabase.from("activities").insert(activities)
}

/**
 * Query decision history for a listing
 */
export async function queryDecisionHistory(listingId: string, limit = 50) {
  if (!isValidUUID(listingId)) {
    return []
  }
  
  const supabase = await createClient()
  
  const { data, error } = await supabase
    .from("activities")
    .select("event_type, metadata, created_at")
    .eq("listing_id", listingId)
    .or(
      "event_type.ilike.seller.decision.%,event_type.ilike.seller.cma.%,event_type.ilike.seller.net_sheet.%,event_type.ilike.seller.presentation%"
    )
    .order("created_at", { ascending: false })
    .limit(limit)
  
  if (error) {
    console.error("[v0] Error querying decision history:", error)
    return []
  }
  
  return data || []
}
