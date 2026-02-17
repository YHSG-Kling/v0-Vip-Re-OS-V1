/**
 * System 5.2: Listing Lifecycle Core - Rollback Cascade Signaling
 * 
 * GOVERNANCE PATCH: Rollback cascade rules
 * 
 * On rollback or exception:
 * - Emit 'listing.lifecycle.rollback'
 * - Include affected_domains: marketing, showings, offers
 * - Downstream systems must pause or revert workflows
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { ListingStage } from "./lifecycle-definitions"
import { storeLifecycleEvent } from "./event-storage"

export type AffectedDomain = 
  | "marketing"
  | "showings"
  | "offers"
  | "transactions"
  | "media"
  | "documents"
  | "repairs"
  | "mls"

export interface RollbackCascadeParams {
  listingId: string
  agentId: string
  brokerageId: string
  userId: string
  userRole: string
  
  // Rollback details
  fromStage: ListingStage
  toStage: ListingStage
  reason: string
  
  // Affected domains that must pause/revert
  affectedDomains: AffectedDomain[]
  
  // Additional context
  metadata?: Record<string, any>
}

/**
 * Emit rollback cascade signal
 * Downstream systems MUST listen for this event
 */
export async function emitRollbackCascade(
  supabase: SupabaseClient,
  params: RollbackCascadeParams
): Promise<{ success: boolean; eventId?: string; error?: string }> {
  return await storeLifecycleEvent(supabase, {
    entityType: "listing",
    entityId: params.listingId,
    eventType: "listing.lifecycle.rollback",
    eventData: {
      title: `Listing Rollback: ${params.fromStage} → ${params.toStage}`,
      description: `Rollback triggered: ${params.reason}. Affected domains: ${params.affectedDomains.join(", ")}`,
      agentId: params.agentId,
      brokerageId: params.brokerageId,
      userId: params.userId,
      metadata: {
        from_stage: params.fromStage,
        to_stage: params.toStage,
        reason: params.reason,
        affected_domains: params.affectedDomains,
        user_role: params.userRole,
        ...params.metadata,
      },
    },
  })
}

/**
 * Determine affected domains based on stage rollback
 * This is the canonical logic for domain impact
 */
export function determineAffectedDomains(
  fromStage: ListingStage,
  toStage: ListingStage
): AffectedDomain[] {
  const affectedDomains: AffectedDomain[] = []
  
  // Define stage thresholds for each domain
  const stageOrder: ListingStage[] = [
    "LEAD",
    "LEAD_ASSIGNED",
    "AGENT_CONSULTATION",
    "APPOINTMENT_SET",
    "CMA_GENERATION",
    "LISTING_PRESENTATION_CREATED",
    "PRESENTATION_VIDEO_GENERATED",
    "PRESENTATION_DRIP_PREP",
    "SELLER_DECISION",
    "LISTING_AGREEMENT_INITIATED",
    "LISTING_AGREEMENT_SIGNED",
    "MLS_DATE_CONFIRMED",
    "COMING_SOON_PREP",
    "REPAIRS_IN_PROGRESS",
    "COMING_SOON_ACTIVE",
    "MEDIA_CAPTURE",
    "MEDIA_APPROVED",
    "MLS_READY",
    "OPEN_HOUSE_MARKETING",
    "MLS_ACTIVE",
    "OPEN_HOUSE_EVENT",
    "SHOWINGS_ACTIVE",
    "OFFERS_RECEIVED",
    "NEGOTIATION",
    "UNDER_CONTRACT",
    "INSPECTION",
    "APPRAISAL",
    "FINANCING",
    "CLOSING_PREP",
    "CLOSED",
    "LIFETIME_CUSTOMER",
  ]
  
  const fromIndex = stageOrder.indexOf(fromStage)
  const toIndex = stageOrder.indexOf(toStage)
  
  // If rolling back past COMING_SOON_ACTIVE, marketing is affected
  if (fromIndex >= stageOrder.indexOf("COMING_SOON_ACTIVE") && 
      toIndex < stageOrder.indexOf("COMING_SOON_ACTIVE")) {
    affectedDomains.push("marketing")
  }
  
  // If rolling back past MEDIA_APPROVED, media is affected
  if (fromIndex >= stageOrder.indexOf("MEDIA_APPROVED") && 
      toIndex < stageOrder.indexOf("MEDIA_APPROVED")) {
    affectedDomains.push("media")
  }
  
  // If rolling back past MLS_ACTIVE, MLS is affected
  if (fromIndex >= stageOrder.indexOf("MLS_ACTIVE") && 
      toIndex < stageOrder.indexOf("MLS_ACTIVE")) {
    affectedDomains.push("mls")
  }
  
  // If rolling back past SHOWINGS_ACTIVE, showings are affected
  if (fromIndex >= stageOrder.indexOf("SHOWINGS_ACTIVE") && 
      toIndex < stageOrder.indexOf("SHOWINGS_ACTIVE")) {
    affectedDomains.push("showings")
  }
  
  // If rolling back past OFFERS_RECEIVED, offers are affected
  if (fromIndex >= stageOrder.indexOf("OFFERS_RECEIVED") && 
      toIndex < stageOrder.indexOf("OFFERS_RECEIVED")) {
    affectedDomains.push("offers")
  }
  
  // If rolling back past UNDER_CONTRACT, transactions are affected
  if (fromIndex >= stageOrder.indexOf("UNDER_CONTRACT") && 
      toIndex < stageOrder.indexOf("UNDER_CONTRACT")) {
    affectedDomains.push("transactions")
  }
  
  // If rolling back past LISTING_AGREEMENT_SIGNED, documents are affected
  if (fromIndex >= stageOrder.indexOf("LISTING_AGREEMENT_SIGNED") && 
      toIndex < stageOrder.indexOf("LISTING_AGREEMENT_SIGNED")) {
    affectedDomains.push("documents")
  }
  
  // If rolling back past REPAIRS_IN_PROGRESS, repairs are affected
  if (fromIndex >= stageOrder.indexOf("REPAIRS_IN_PROGRESS") && 
      toIndex < stageOrder.indexOf("REPAIRS_IN_PROGRESS")) {
    affectedDomains.push("repairs")
  }
  
  return affectedDomains
}

/**
 * Emit exception cascade signal
 * Used when a critical failure occurs (not user-initiated rollback)
 */
export async function emitExceptionCascade(
  supabase: SupabaseClient,
  params: RollbackCascadeParams & {
    exceptionType: string
    exceptionMessage: string
    stackTrace?: string
  }
): Promise<{ success: boolean; eventId?: string; error?: string }> {
  return await storeLifecycleEvent(supabase, {
    entityType: "listing",
    entityId: params.listingId,
    eventType: "listing.lifecycle.exception",
    eventData: {
      title: `Listing Exception: ${params.exceptionType}`,
      description: `Critical exception at stage ${params.fromStage}: ${params.exceptionMessage}`,
      agentId: params.agentId,
      brokerageId: params.brokerageId,
      userId: params.userId,
      metadata: {
        from_stage: params.fromStage,
        to_stage: params.toStage,
        exception_type: params.exceptionType,
        exception_message: params.exceptionMessage,
        stack_trace: params.stackTrace,
        affected_domains: params.affectedDomains,
        user_role: params.userRole,
        ...params.metadata,
      },
    },
  })
}

/**
 * Query rollback history for a listing
 */
export async function getRollbackHistory(
  supabase: SupabaseClient,
  listingId: string
): Promise<Array<{
  id: string
  timestamp: string
  fromStage: ListingStage
  toStage: ListingStage
  reason: string
  affectedDomains: AffectedDomain[]
}>> {
  const { data, error } = await supabase
    .from("activities")
    .select("*")
    .eq("listing_id", listingId)
    .in("activity_type", ["listing.lifecycle.rollback", "listing.lifecycle.exception"])
    .order("created_at", { ascending: false })
  
  if (error || !data) {
    return []
  }
  
  return data.map((activity) => {
    const parsed = activity.notes ? JSON.parse(activity.notes) : {}
    return {
      id: activity.id,
      timestamp: activity.created_at,
      fromStage: parsed.metadata?.from_stage,
      toStage: parsed.metadata?.to_stage,
      reason: parsed.metadata?.reason || activity.description,
      affectedDomains: parsed.metadata?.affected_domains || [],
    }
  })
}

/**
 * Check if listing is in rollback state
 * Downstream systems should check this before executing workflows
 */
export async function isListingInRollback(
  supabase: SupabaseClient,
  listingId: string,
  withinMinutes: number = 60
): Promise<boolean> {
  const { data, error } = await supabase
    .from("activities")
    .select("created_at")
    .eq("listing_id", listingId)
    .in("activity_type", ["listing.lifecycle.rollback", "listing.lifecycle.exception"])
    .order("created_at", { ascending: false })
    .limit(1)
    .single()
  
  if (error || !data) {
    return false
  }
  
  // Check if rollback is recent
  const rollbackDate = new Date(data.created_at)
  const now = new Date()
  const minutesSinceRollback = (now.getTime() - rollbackDate.getTime()) / (1000 * 60)
  
  return minutesSinceRollback <= withinMinutes
}

/**
 * Get affected domains for a listing's most recent rollback
 */
export async function getRecentRollbackDomains(
  supabase: SupabaseClient,
  listingId: string
): Promise<AffectedDomain[]> {
  const { data, error } = await supabase
    .from("activities")
    .select("notes")
    .eq("listing_id", listingId)
    .in("activity_type", ["listing.lifecycle.rollback", "listing.lifecycle.exception"])
    .order("created_at", { ascending: false })
    .limit(1)
    .single()
  
  if (error || !data) {
    return []
  }
  
  const parsed = data.notes ? JSON.parse(data.notes) : {}
  return parsed.metadata?.affected_domains || []
}
