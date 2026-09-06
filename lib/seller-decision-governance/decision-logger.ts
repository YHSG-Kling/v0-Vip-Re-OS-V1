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
import type { UserRole } from "@/lib/auth/resolve-user-role"

// activities live schema has activity_type (not event_type), requires a NOT NULL
// brokerage_id, and exposes a polymorphic (entity_type, entity_id) pointer plus
// listing_id. Source brokerage_id from the listing and write real columns here so
// the governance audit rows actually persist.
/**
 * The result every logger below returns.
 *
 * WHY THIS IS NOT `void`. Every one of these functions used to return void and
 * swallow whatever the database said: the listing read did not destructure
 * `error`, and neither did the insert. supabase-js RESOLVES a refused query, so
 * an RLS denial arrived as `data: null, error: null` — read back as "listing not
 * found" — and a refused INSERT arrived as a resolved promise the caller could
 * not tell from a written row. The server actions above then returned
 * `{ success: true }` over an audit row that was never written, which is the one
 * thing an audit trail may never do. Callers now branch on a real answer.
 */
export type DecisionLogResult = { ok: true } | { ok: false; error: string }

async function insertListingActivities(
  supabase: Awaited<ReturnType<typeof createClient>>,
  listingId: string,
  rows: Array<{ activity_type: string; metadata: Record<string, any> }>,
): Promise<DecisionLogResult> {
  const { data: listing, error: readErr } = await supabase
    .from("listings")
    .select("brokerage_id")
    .eq("id", listingId)
    .maybeSingle()
  // A REFUSED read and a MISSING listing are different facts and must not be
  // reported as the same one — the first is an outage, the second is bad input.
  if (readErr) return { ok: false, error: `Could not read the listing: ${readErr.message}` }
  if (!listing?.brokerage_id) {
    return { ok: false, error: "Listing not found, or it carries no brokerage to file the record under" }
  }
  const { error: insErr } = await supabase.from("activities").insert(
    rows.map((r) => ({
      brokerage_id: listing.brokerage_id,
      listing_id: listingId,
      entity_type: "listing",
      entity_id: listingId,
      activity_type: r.activity_type,
      metadata: r.metadata,
    })),
  )
  if (insErr) return { ok: false, error: `The audit row was refused: ${insErr.message}` }
  return { ok: true }
}

export interface DecisionTransitionEvent {
  listing_id: string
  from_state?: SellerDecisionState
  to_state: SellerDecisionState
  // ONE VOCABULARY: this records WHICH `users.user_type` acted, so it is the
  // user_type vocabulary, imported. The four-value literal it replaces could
  // not record a broker_owner or a compliance_officer transition at all — the
  // CMA and net-sheet evaluators ADMIT roles this audit trail could not name.
  authority_role: UserRole
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
export async function logDecisionTransition(event: DecisionTransitionEvent): Promise<DecisionLogResult> {
  if (!isValidUUID(event.listing_id)) {
    // A refusal the CALLER can see. This used to console.error and return void,
    // so a bad id and a written audit row were indistinguishable upstream.
    return { ok: false, error: "Invalid listing ID" }
  }
  
  const supabase = await createClient()
  
  return insertListingActivities(supabase, event.listing_id, [{
    activity_type: "seller.decision.transition",
    metadata: {
      from_state: event.from_state,
      to_state: event.to_state,
      authority_role: event.authority_role,
      override_flag: event.override_flag || false,
      override_reason: event.override_reason,
      ...event.metadata,
    },
  }])
}

/**
 * Log CMA quality verification
 */
export async function logCMAQualityVerified(event: CMAQualityEvent): Promise<DecisionLogResult> {
  if (!isValidUUID(event.listing_id)) {
    // A refusal the CALLER can see. This used to console.error and return void,
    // so a bad id and a written audit row were indistinguishable upstream.
    return { ok: false, error: "Invalid listing ID" }
  }
  
  const supabase = await createClient()
  
  return insertListingActivities(supabase, event.listing_id, [{
    activity_type: "seller.cma.quality_verified",
    metadata: {
      comparable_count: event.comparable_count,
      oldest_comparable_months: event.oldest_comparable_months,
      max_radius_miles: event.max_radius_miles,
      quality_score: event.quality_score,
      approved_by_role: event.approved_by_role,
      ...event.metadata,
    },
  }])
}

/**
 * Log net sheet event
 */
export async function logNetSheetEvent(event: NetSheetEvent): Promise<DecisionLogResult> {
  if (!isValidUUID(event.listing_id)) {
    // A refusal the CALLER can see. This used to console.error and return void,
    // so a bad id and a written audit row were indistinguishable upstream.
    return { ok: false, error: "Invalid listing ID" }
  }
  
  const supabase = await createClient()
  
  const eventTypeMap = {
    generated: "seller.net_sheet.generated",
    expired: "seller.net_sheet.expired",
    expiration_warning: "seller.net_sheet.expiration_warning",
    regenerated: "seller.net_sheet.regenerated",
  }
  
  return insertListingActivities(supabase, event.listing_id, [{
    activity_type: eventTypeMap[event.event_type],
    metadata: {
      days_remaining: event.days_remaining,
      validity_days: event.validity_days,
      ...event.metadata,
    },
  }])
}

/**
 * Log presentation event
 */
export async function logPresentationEvent(event: PresentationEvent): Promise<DecisionLogResult> {
  if (!isValidUUID(event.listing_id)) {
    // A refusal the CALLER can see. This used to console.error and return void,
    // so a bad id and a written audit row were indistinguishable upstream.
    return { ok: false, error: "Invalid listing ID" }
  }
  
  const supabase = await createClient()
  
  const eventTypeMap = {
    assembled: "seller.presentation.assembled",
    video_ready: "seller.presentation_video.ready",
    drip_started: "seller.presentation_drip.started",
    drip_paused: "seller.presentation_drip.paused",
  }
  
  return insertListingActivities(supabase, event.listing_id, [{
    activity_type: eventTypeMap[event.event_type],
    metadata: event.metadata || {},
  }])
}

/**
 * Log decision reversal
 */
export async function logDecisionReversal(event: DecisionReversalEvent): Promise<DecisionLogResult> {
  if (!isValidUUID(event.listing_id)) {
    // A refusal the CALLER can see. This used to console.error and return void,
    // so a bad id and a written audit row were indistinguishable upstream.
    return { ok: false, error: "Invalid listing ID" }
  }
  
  const supabase = await createClient()
  
  return insertListingActivities(supabase, event.listing_id, [{
    activity_type: "seller.decision.reversed",
    metadata: {
      from_state: event.from_state,
      reversal_reason: event.reversal_reason,
      authority_role: event.authority_role,
      ...event.metadata,
    },
  }])
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
): Promise<DecisionLogResult> {
  if (!isValidUUID(listingId)) {
    return { ok: false, error: "Invalid listing ID" }
  }

  // Nothing to write is not a failure — but it is also not a written row, and
  // the caller is told which by getting a real result either way.
  if (events.length === 0) return { ok: true }

  const supabase = await createClient()
  
  return insertListingActivities(
    supabase,
    listingId,
    events.map((event) => ({ activity_type: event.eventType, metadata: event.metadata || {} })),
  )
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
    .select("event_type:activity_type, metadata, created_at")
    .eq("listing_id", listingId)
    .or(
      "activity_type.ilike.seller.decision.%,activity_type.ilike.seller.cma.%,activity_type.ilike.seller.net_sheet.%,activity_type.ilike.seller.presentation%"
    )
    .order("created_at", { ascending: false })
    .limit(limit)
  
  if (error) {
    console.error("[v0] Error querying decision history:", error)
    return []
  }
  
  return data || []
}
