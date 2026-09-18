/**
 * System 5.2: Listing Lifecycle Core - Exception Recovery Limits
 * 
 * GOVERNANCE PATCH: Time-bound exception rules
 * 
 * Define time-bound rules:
 * - ON_HOLD has max duration
 * - EXPIRED cannot resume without new agreement
 * - Emit escalation events when limits exceeded
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { ListingStage } from "./lifecycle-definitions"
import { getCurrentLifecycleStage, getLifecycleHistory } from "./lifecycle-logger"
import { storeLifecycleEvent } from "./event-storage"

export interface StageDurationLimit {
  stage: ListingStage
  maxDurationDays: number
  escalationRequired: boolean
  escalationRoles: string[]
  autoTransitionTo?: ListingStage
}

/**
 * Stage duration limits configuration
 * These are governance rules that trigger escalations
 */
export const STAGE_DURATION_LIMITS: StageDurationLimit[] = [
  {
    stage: "LEAD",
    maxDurationDays: 7,
    escalationRequired: true,
    escalationRoles: ["team_lead", "broker"],
  },
  {
    stage: "LEAD_ASSIGNED",
    maxDurationDays: 3,
    escalationRequired: true,
    escalationRoles: ["team_lead"],
  },
  {
    stage: "AGENT_CONSULTATION",
    maxDurationDays: 14,
    escalationRequired: true,
    escalationRoles: ["team_lead"],
  },
  {
    stage: "APPOINTMENT_SET",
    maxDurationDays: 7,
    escalationRequired: true,
    escalationRoles: ["agent", "team_lead"],
  },
  {
    stage: "SELLER_DECISION",
    maxDurationDays: 30,
    escalationRequired: true,
    escalationRoles: ["team_lead", "broker"],
    autoTransitionTo: "LEAD", // Consider re-qualifying
  },
  {
    stage: "REPAIRS_IN_PROGRESS",
    maxDurationDays: 30,
    escalationRequired: true,
    escalationRoles: ["agent", "team_lead"],
  },
  {
    stage: "MEDIA_CAPTURE",
    maxDurationDays: 7,
    escalationRequired: true,
    escalationRoles: ["agent"],
  },
  {
    stage: "MLS_READY",
    maxDurationDays: 3,
    escalationRequired: true,
    escalationRoles: ["agent", "team_lead"],
  },
  {
    stage: "SHOWINGS_ACTIVE",
    maxDurationDays: 90,
    escalationRequired: true,
    escalationRoles: ["agent", "team_lead"],
  },
  {
    stage: "NEGOTIATION",
    maxDurationDays: 14,
    escalationRequired: true,
    escalationRoles: ["agent", "broker"],
  },
  {
    stage: "INSPECTION",
    maxDurationDays: 10,
    escalationRequired: true,
    escalationRoles: ["agent"],
  },
  {
    stage: "APPRAISAL",
    maxDurationDays: 14,
    escalationRequired: true,
    escalationRoles: ["agent"],
  },
  {
    stage: "FINANCING",
    maxDurationDays: 30,
    escalationRequired: true,
    escalationRoles: ["agent", "broker"],
  },
  {
    stage: "CLOSING_PREP",
    maxDurationDays: 7,
    escalationRequired: true,
    escalationRoles: ["agent"],
  },
]

/**
 * Special stage rules
 */
export interface SpecialStageRule {
  stage: ListingStage
  ruleName: string
  description: string
  blockTransitions?: boolean
  requiresApproval?: boolean
  approvalRoles?: string[]
}

export const SPECIAL_STAGE_RULES: SpecialStageRule[] = [
  {
    stage: "LEAD",
    ruleName: "EXPIRED_NO_RESUME",
    description: "Expired listings cannot resume without new listing agreement",
    blockTransitions: true,
    requiresApproval: true,
    approvalRoles: ["broker", "admin"],
  },
]

/**
 * Check if listing stage has exceeded duration limit
 */
export async function checkStageDurationLimit(
  supabase: SupabaseClient,
  listingId: string
): Promise<{
  exceeded: boolean
  currentStage: ListingStage | null
  daysinStage: number
  maxDurationDays: number | null
  escalationRequired: boolean
  escalationRoles: string[]
  autoTransitionTo?: ListingStage
}> {
  // Get current stage
  const currentStage = await getCurrentLifecycleStage(supabase, listingId)
  
  if (!currentStage) {
    return {
      exceeded: false,
      currentStage: null,
      daysinStage: 0,
      maxDurationDays: null,
      escalationRequired: false,
      escalationRoles: [],
    }
  }
  
  // Get stage duration limit config
  const limitConfig = STAGE_DURATION_LIMITS.find((l) => l.stage === currentStage)
  
  if (!limitConfig) {
    return {
      exceeded: false,
      currentStage,
      daysinStage: 0,
      maxDurationDays: null,
      escalationRequired: false,
      escalationRoles: [],
    }
  }
  
  // Get lifecycle history to find when entered current stage
  const history = await getLifecycleHistory(supabase, listingId)
  const currentStageEntry = history.reverse().find((h) => h.toStage === currentStage)
  
  if (!currentStageEntry) {
    return {
      exceeded: false,
      currentStage,
      daysinStage: 0,
      maxDurationDays: limitConfig.maxDurationDays,
      escalationRequired: limitConfig.escalationRequired,
      escalationRoles: limitConfig.escalationRoles,
    }
  }
  
  // Calculate days in current stage
  const enteredAt = new Date(currentStageEntry.timestamp)
  const now = new Date()
  const daysinStage = Math.floor((now.getTime() - enteredAt.getTime()) / (1000 * 60 * 60 * 24))
  
  const exceeded = daysinStage > limitConfig.maxDurationDays
  
  return {
    exceeded,
    currentStage,
    daysinStage,
    maxDurationDays: limitConfig.maxDurationDays,
    escalationRequired: exceeded && limitConfig.escalationRequired,
    escalationRoles: limitConfig.escalationRoles,
    autoTransitionTo: limitConfig.autoTransitionTo,
  }
}

/**
 * Emit escalation event when stage duration limit exceeded
 */
export async function emitStageDurationEscalation(
  supabase: SupabaseClient,
  params: {
    listingId: string
    agentId: string
    brokerageId: string
    currentStage: ListingStage
    daysInStage: number
    maxDurationDays: number
    escalationRoles: string[]
  }
): Promise<{ success: boolean; eventId?: string; error?: string }> {
  return await storeLifecycleEvent(supabase, {
    entityType: "listing",
    entityId: params.listingId,
    eventType: "listing.lifecycle.escalation.duration_exceeded",
    eventData: {
      title: `Stage Duration Exceeded: ${params.currentStage}`,
      description: `Listing has been in stage "${params.currentStage}" for ${params.daysInStage} days (max: ${params.maxDurationDays} days). Escalation required.`,
      agentId: params.agentId,
      brokerageId: params.brokerageId,
      metadata: {
        current_stage: params.currentStage,
        days_in_stage: params.daysInStage,
        max_duration_days: params.maxDurationDays,
        escalation_roles: params.escalationRoles,
        escalation_timestamp: new Date().toISOString(),
      },
    },
  })
}

/**
 * Check all listings for duration limit violations
 * Should be run periodically (e.g., daily cron job)
 */
export async function checkAllListingDurationLimits(
  supabase: SupabaseClient,
  brokerageId: string
): Promise<Array<{
  listingId: string
  currentStage: ListingStage
  daysInStage: number
  maxDurationDays: number
  escalationRequired: boolean
}>> {
  // Get all active listings for brokerage
  const { data: listings } = await supabase
    .from("listings")
    .select("id")
    .eq("brokerage_id", brokerageId)
    // "closed" is not a listings status, so this exclusion excluded nothing and
    // recovery limits were computed over finished listings too. "sold" is the
    // real terminal status.
    .neq("status", "sold")
  
  if (!listings) {
    return []
  }
  
  const violations: Array<{
    listingId: string
    currentStage: ListingStage
    daysInStage: number
    maxDurationDays: number
    escalationRequired: boolean
  }> = []
  
  for (const listing of listings) {
    const check = await checkStageDurationLimit(supabase, listing.id)
    
    if (check.exceeded && check.currentStage) {
      violations.push({
        listingId: listing.id,
        currentStage: check.currentStage,
        daysInStage: check.daysinStage,
        maxDurationDays: check.maxDurationDays!,
        escalationRequired: check.escalationRequired,
      })
    }
  }
  
  return violations
}

/**
 * Check special stage rules (e.g., EXPIRED cannot resume)
 */
export async function checkSpecialStageRules(
  supabase: SupabaseClient,
  listingId: string,
  targetStage: ListingStage
): Promise<{
  allowed: boolean
  blockedBy?: SpecialStageRule
  reason?: string
}> {
  // Get current stage
  const currentStage = await getCurrentLifecycleStage(supabase, listingId)
  
  // Check for special rules on target stage
  const rule = SPECIAL_STAGE_RULES.find((r) => r.stage === targetStage)
  
  if (!rule) {
    return { allowed: true }
  }
  
  // Check if transitioning from LEAD to active stage
  // This would indicate resuming an expired listing
  if (currentStage === "LEAD" && rule.blockTransitions) {
    return {
      allowed: false,
      blockedBy: rule,
      reason: rule.description,
    }
  }
  
  return { allowed: true }
}

/**
 * Get escalation history for a listing
 */
export async function getEscalationHistory(
  supabase: SupabaseClient,
  listingId: string
): Promise<Array<{
  id: string
  timestamp: string
  escalationType: string
  currentStage: ListingStage
  daysInStage: number
  escalationRoles: string[]
}>> {
  const { data, error } = await supabase
    .from("activities")
    .select("*")
    .eq("listing_id", listingId)
    .ilike("activity_type", "listing.lifecycle.escalation.%")
    .order("created_at", { ascending: false })
  
  if (error || !data) {
    return []
  }
  
  return data.map((activity) => {
    const parsed = activity.notes ? JSON.parse(activity.notes) : {}
    return {
      id: activity.id,
      timestamp: activity.created_at,
      escalationType: activity.activity_type,
      currentStage: parsed.metadata?.current_stage,
      daysInStage: parsed.metadata?.days_in_stage || 0,
      escalationRoles: parsed.metadata?.escalation_roles || [],
    }
  })
}
