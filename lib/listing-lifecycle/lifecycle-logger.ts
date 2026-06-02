/**
 * System 5.2: Listing Lifecycle Core - Lifecycle Logger
 * 
 * Logs all lifecycle events to activities table for audit trail.
 * NO new tables, NO state persistence beyond activities.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { ListingStage } from "./lifecycle-definitions"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { KernelEvent } from "@/lib/kernel/events"

export interface LifecycleEventData {
  listingId: string
  agentId: string
  brokerageId: string
  
  // Transition details
  fromStage: ListingStage | null
  toStage: ListingStage
  
  // User context
  userId: string
  userRole: string
  
  // Override info (if applicable)
  isOverride?: boolean
  overrideReason?: string
  skippedStages?: ListingStage[]
  
  // Validation results
  readinessChecksPassed?: string[]
  readinessChecksFailed?: string[]
  
  // Additional context
  notes?: string
  metadata?: Record<string, any>
}

/**
 * Log lifecycle stage transition.
 *
 * Routes through transitionLifecycle() which handles:
 *   1. UPDATE listings.lifecycle_stage = toStage
 *   2. INSERT lifecycle_events row
 *   3. processKernelEvent() → notifications fire (non-blocking)
 *
 * Milestone stages emit high-signal KernelEvents via resolveStageMilestoneEvent().
 * All other stages emit LISTING_STAGE_CHANGED.
 */
export async function logStageTransition(
  event: LifecycleEventData
): Promise<{ activityId: string }> {
  const result = await transitionLifecycle({
    brokerageId:  event.brokerageId,
    entityType:   'listing_stage_machine',
    entityId:     event.listingId,
    fromState:    event.fromStage ?? "",
    toState:      event.toStage,
    actorUserId:  event.userId,
    // Milestone stages get high-signal events; all others get LISTING_STAGE_CHANGED
    eventType:    resolveStageMilestoneEvent(event.toStage),
    metadata: {
      user_role:        event.userRole,
      is_override:      event.isOverride ?? false,
      override_reason:  event.overrideReason,
      skipped_stages:   event.skippedStages ?? [],
      readiness_passed: event.readinessChecksPassed ?? [],
      readiness_failed: event.readinessChecksFailed ?? [],
      notes:            event.notes,
    },
  })
  return { activityId: result.activityId }
}

/**
 * Resolve which kernel eventType string to pass for a given toStage.
 * Milestone stages map to higher-signal events; all others use the generic catch-all.
 */
function resolveStageMilestoneEvent(toStage: string): string {
  const milestones: Record<string, string> = {
    'MLS_ACTIVE':        'MLS_ACTIVE',
    'UNDER_CONTRACT':    'UNDER_CONTRACT',
    'CLOSED':            'CLOSED',
    'LIFETIME_CUSTOMER': 'LIFETIME_CUSTOMER',
  }
  return milestones[toStage] ?? 'LISTING_STAGE_CHANGED'
}

/**
 * Log failed transition attempt.
 *
 * Writes directly to lifecycle_events — no state change occurs,
 * so transitionLifecycle() is NOT called and processKernelEvent() is NOT fired.
 */
export async function logFailedTransition(
  supabase: SupabaseClient,
  event: LifecycleEventData & { failureReason: string }
): Promise<void> {
  await supabase.from('lifecycle_events').insert({
    brokerage_id:  event.brokerageId,
    entity_type:   'listing_stage_machine',
    entity_id:     event.listingId,
    event_type:    KernelEvent.LISTING_STAGE_TRANSITION_FAILED,
    actor_user_id: event.userId,
    metadata: {
      from_stage:       event.fromStage,
      to_stage:         event.toStage,
      failure_reason:   event.failureReason,
      readiness_failed: event.readinessChecksFailed ?? [],
      is_override:      false,
    },
  })
  // processKernelEvent NOT called — no state change occurred
}

/**
 * Log system gate enabled
 */
export async function logSystemGateEnabled(
  supabase: SupabaseClient,
  data: {
    listingId: string
    agentId: string
    brokerageId: string
    stage: ListingStage
    gateName: string
    gateDescription?: string
  }
): Promise<void> {
  await supabase.from("activities").insert({
    activity_type: "listing_lifecycle_gate_enabled",
    title: `System Gate Enabled: ${data.gateName}`,
    description: data.gateDescription || `System gate "${data.gateName}" is now enabled for this listing at stage "${data.stage}"`,
    agent_id: data.agentId,
    brokerage_id: data.brokerageId,
    listing_id: data.listingId,
    status: "completed",
    completed_at: new Date().toISOString(),
    notes: JSON.stringify({
      stage: data.stage,
      gate_name: data.gateName,
      timestamp: new Date().toISOString(),
    }),
  })
}

/**
 * Build human-readable transition description
 */
function buildTransitionDescription(event: LifecycleEventData): string {
  const parts: string[] = []
  
  if (event.isOverride) {
    parts.push(`[ADMIN OVERRIDE] Stage advanced by ${event.userRole}`)
    if (event.overrideReason) {
      parts.push(`Reason: ${event.overrideReason}`)
    }
    if (event.skippedStages && event.skippedStages.length > 0) {
      parts.push(`Skipped stages: ${event.skippedStages.join(", ")}`)
    }
  } else {
    parts.push(`Stage advanced by ${event.userRole}`)
  }
  
  if (event.readinessChecksPassed && event.readinessChecksPassed.length > 0) {
    parts.push(`Readiness checks passed: ${event.readinessChecksPassed.join(", ")}`)
  }
  
  if (event.notes) {
    parts.push(`Notes: ${event.notes}`)
  }
  
  return parts.join(" | ")
}

/**
 * Query lifecycle history for a listing.
 * Reads from lifecycle_events (entity_type = 'listing_stage_machine').
 */
export async function getLifecycleHistory(
  supabase: SupabaseClient,
  listingId: string
): Promise<Array<{
  id: string
  timestamp: string
  fromStage: ListingStage | null
  toStage: ListingStage
  userId: string
  isOverride: boolean
  notes: string | null
}>> {
  const { data } = await supabase
    .from('lifecycle_events')
    .select('*')
    .eq('entity_type', 'listing_stage_machine')
    .eq('entity_id', listingId)
    .order('created_at', { ascending: true })

  return (data ?? []).map(e => ({
    id:         e.id,
    timestamp:  e.created_at,
    fromStage:  (e.metadata?.from_state ?? null) as ListingStage | null,
    toStage:    e.metadata?.to_state as ListingStage,
    userId:     e.actor_user_id,
    isOverride: e.metadata?.is_override ?? false,
    notes:      e.metadata?.notes ?? null,
  }))
}

/**
 * Get current lifecycle stage for a listing
 */
export async function getCurrentLifecycleStage(
  supabase: SupabaseClient,
  listingId: string
): Promise<ListingStage | null> {
  const { data, error } = await supabase
    .from("activities")
    .select("notes")
    .eq("listing_id", listingId)
    .eq("activity_type", "listing_lifecycle_transition")
    .order("created_at", { ascending: false })
    .limit(1)
    .single()
  
  if (error || !data) {
    return null
  }
  
  const parsed = data.notes ? JSON.parse(data.notes) : {}
  return parsed.to_stage || null
}

/**
 * Get lifecycle statistics for a brokerage
 */
export async function getLifecycleStatistics(
  supabase: SupabaseClient,
  brokerageId: string,
  options?: {
    dateFrom?: string
    dateTo?: string
  }
): Promise<{
  totalTransitions: number
  overrideCount: number
  failedTransitions: number
  stageDistribution: Record<string, number>
}> {
  let query = supabase
    .from("activities")
    .select("activity_type, notes")
    .eq("brokerage_id", brokerageId)
    .in("activity_type", ["listing_lifecycle_transition", "listing_lifecycle_transition_failed"])
  
  if (options?.dateFrom) {
    query = query.gte("created_at", options.dateFrom)
  }
  if (options?.dateTo) {
    query = query.lte("created_at", options.dateTo)
  }
  
  const { data } = await query
  
  if (!data) {
    return {
      totalTransitions: 0,
      overrideCount: 0,
      failedTransitions: 0,
      stageDistribution: {},
    }
  }
  
  let overrideCount = 0
  let failedTransitions = 0
  const stageDistribution: Record<string, number> = {}
  
  for (const activity of data) {
    if (activity.activity_type === "listing_lifecycle_transition_failed") {
      failedTransitions++
      continue
    }
    
    const parsed = activity.notes ? JSON.parse(activity.notes) : {}
    
    if (parsed.is_override) {
      overrideCount++
    }
    
    if (parsed.to_stage) {
      stageDistribution[parsed.to_stage] = (stageDistribution[parsed.to_stage] || 0) + 1
    }
  }
  
  return {
    totalTransitions: data.filter((a) => a.activity_type === "listing_lifecycle_transition").length,
    overrideCount,
    failedTransitions,
    stageDistribution,
  }
}

/**
 * Get average time spent in each stage
 */
export async function getStageTimingMetrics(
  supabase: SupabaseClient,
  brokerageId: string,
  options?: {
    dateFrom?: string
    dateTo?: string
  }
): Promise<Record<string, { averageDays: number; count: number }>> {
  let query = supabase
    .from("activities")
    .select("listing_id, notes, created_at")
    .eq("brokerage_id", brokerageId)
    .eq("activity_type", "listing_lifecycle_transition")
    .order("listing_id", { ascending: true })
    .order("created_at", { ascending: true })
  
  if (options?.dateFrom) {
    query = query.gte("created_at", options.dateFrom)
  }
  if (options?.dateTo) {
    query = query.lte("created_at", options.dateTo)
  }
  
  const { data } = await query
  
  if (!data || data.length === 0) {
    return {}
  }
  
  // Group by listing and calculate stage durations
  const listingTransitions: Record<string, Array<{ stage: string; timestamp: string }>> = {}
  
  for (const activity of data) {
    const parsed = activity.notes ? JSON.parse(activity.notes) : {}
    const listingId = activity.listing_id
    
    if (!listingId || !parsed.to_stage) continue
    
    if (!listingTransitions[listingId]) {
      listingTransitions[listingId] = []
    }
    
    listingTransitions[listingId].push({
      stage: parsed.to_stage,
      timestamp: activity.created_at,
    })
  }
  
  // Calculate average time per stage
  const stageDurations: Record<string, number[]> = {}
  
  for (const transitions of Object.values(listingTransitions)) {
    for (let i = 0; i < transitions.length - 1; i++) {
      const current = transitions[i]
      const next = transitions[i + 1]
      
      const durationMs = new Date(next.timestamp).getTime() - new Date(current.timestamp).getTime()
      const durationDays = durationMs / (1000 * 60 * 60 * 24)
      
      if (!stageDurations[current.stage]) {
        stageDurations[current.stage] = []
      }
      stageDurations[current.stage].push(durationDays)
    }
  }
  
  // Calculate averages
  const metrics: Record<string, { averageDays: number; count: number }> = {}
  
  for (const [stage, durations] of Object.entries(stageDurations)) {
    const sum = durations.reduce((a, b) => a + b, 0)
    metrics[stage] = {
      averageDays: Math.round(sum / durations.length),
      count: durations.length,
    }
  }
  
  return metrics
}
