/**
 * System 5.2: Listing Lifecycle Core - Event Storage Helpers
 * 
 * GOVERNANCE PATCH: Event storage and querying strategy
 * 
 * All lifecycle and integration events MUST be stored in `activities` using:
 * - type (namespaced, e.g. 'listing.lifecycle.transition')
 * - entity_type = 'listing'
 * - entity_id
 * - metadata (JSON)
 * 
 * Events must be queryable by:
 * - entity_id
 * - type prefix
 * - integration_source
 */

import type { SupabaseClient } from "@supabase/supabase-js"

export interface LifecycleEventStorageParams {
  entityType: "listing" | "transaction" | "contact"
  entityId: string
  eventType: string // Namespaced, e.g. 'listing.lifecycle.transition'
  eventData: {
    title: string
    description?: string
    agentId?: string
    brokerageId?: string
    userId?: string
    integrationSource?: string
    externalEventId?: string
    metadata?: Record<string, any>
  }
}

/**
 * Store a lifecycle or integration event in activities table
 * Enforces storage contract with namespaced event types
 */
export async function storeLifecycleEvent(
  supabase: SupabaseClient,
  params: LifecycleEventStorageParams
): Promise<{ success: boolean; eventId?: string; error?: string }> {
  try {
    const { data, error } = await supabase
      .from("activities")
      .insert({
        activity_type: params.eventType,
        title: params.eventData.title,
        description: params.eventData.description || "",
        agent_id: params.eventData.agentId,
        brokerage_id: params.eventData.brokerageId,
        ...(params.entityType === "listing" && { listing_id: params.entityId }),
        ...(params.entityType === "transaction" && { transaction_id: params.entityId }),
        ...(params.entityType === "contact" && { contact_id: params.entityId }),
        status: "completed",
        completed_at: new Date().toISOString(),
        notes: JSON.stringify({
          entity_type: params.entityType,
          entity_id: params.entityId,
          user_id: params.eventData.userId,
          integration_source: params.eventData.integrationSource,
          external_event_id: params.eventData.externalEventId,
          metadata: params.eventData.metadata || {},
          timestamp: new Date().toISOString(),
        }),
      })
      .select("id")
      .single()

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true, eventId: data?.id }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * Query events by entity and type prefix
 * Example: Query all 'listing.lifecycle.*' events for a listing
 */
export async function queryEventsByEntityAndType(
  supabase: SupabaseClient,
  params: {
    entityType: "listing" | "transaction" | "contact"
    entityId: string
    eventTypePrefix: string
    limit?: number
  }
): Promise<Array<{
  id: string
  eventType: string
  title: string
  description: string
  timestamp: string
  metadata: Record<string, any>
}>> {
  const entityColumn = params.entityType === "listing" ? "listing_id" 
    : params.entityType === "transaction" ? "transaction_id" 
    : "contact_id"

  const { data, error } = await supabase
    .from("activities")
    .select("id, activity_type, title, description, created_at, notes")
    .eq(entityColumn, params.entityId)
    .ilike("activity_type", `${params.eventTypePrefix}%`)
    .order("created_at", { ascending: false })
    .limit(params.limit || 100)

  if (error || !data) {
    return []
  }

  return data.map((activity) => {
    const parsed = activity.notes ? JSON.parse(activity.notes) : {}
    return {
      id: activity.id,
      eventType: activity.activity_type,
      title: activity.title,
      description: activity.description || "",
      timestamp: activity.created_at,
      metadata: parsed.metadata || {},
    }
  })
}

/**
 * Query events by integration source
 * Example: Query all Dotloop events for a listing
 */
export async function queryEventsByIntegrationSource(
  supabase: SupabaseClient,
  params: {
    entityType: "listing" | "transaction" | "contact"
    entityId: string
    integrationSource: string
    limit?: number
  }
): Promise<Array<{
  id: string
  eventType: string
  title: string
  externalEventId?: string
  timestamp: string
  metadata: Record<string, any>
}>> {
  const entityColumn = params.entityType === "listing" ? "listing_id" 
    : params.entityType === "transaction" ? "transaction_id" 
    : "contact_id"

  const { data, error } = await supabase
    .from("activities")
    .select("id, activity_type, title, created_at, notes")
    .eq(entityColumn, params.entityId)
    .order("created_at", { ascending: false })
    .limit(params.limit || 100)

  if (error || !data) {
    return []
  }

  // Filter by integration source in notes
  const filtered = data.filter((activity) => {
    const parsed = activity.notes ? JSON.parse(activity.notes) : {}
    return parsed.integration_source === params.integrationSource
  })

  return filtered.map((activity) => {
    const parsed = activity.notes ? JSON.parse(activity.notes) : {}
    return {
      id: activity.id,
      eventType: activity.activity_type,
      title: activity.title,
      externalEventId: parsed.external_event_id,
      timestamp: activity.created_at,
      metadata: parsed.metadata || {},
    }
  })
}

/**
 * Check if event exists (for deduplication)
 */
export async function checkEventExists(
  supabase: SupabaseClient,
  params: {
    entityType: "listing" | "transaction" | "contact"
    entityId: string
    eventType: string
    integrationSource?: string
    externalEventId?: string
  }
): Promise<boolean> {
  const entityColumn = params.entityType === "listing" ? "listing_id" 
    : params.entityType === "transaction" ? "transaction_id" 
    : "contact_id"

  const { data, error } = await supabase
    .from("activities")
    .select("id, notes")
    .eq(entityColumn, params.entityId)
    .eq("activity_type", params.eventType)
    .limit(100)

  if (error || !data || data.length === 0) {
    return false
  }

  // If no external tracking, existence of event type is enough
  if (!params.integrationSource && !params.externalEventId) {
    return true
  }

  // Check notes for integration source and external ID
  for (const activity of data) {
    const parsed = activity.notes ? JSON.parse(activity.notes) : {}
    
    if (params.integrationSource && parsed.integration_source !== params.integrationSource) {
      continue
    }
    
    if (params.externalEventId && parsed.external_event_id === params.externalEventId) {
      return true
    }
  }

  return false
}

/**
 * Get latest event of a specific type
 */
export async function getLatestEvent(
  supabase: SupabaseClient,
  params: {
    entityType: "listing" | "transaction" | "contact"
    entityId: string
    eventType: string
  }
): Promise<{
  id: string
  eventType: string
  title: string
  timestamp: string
  metadata: Record<string, any>
} | null> {
  const entityColumn = params.entityType === "listing" ? "listing_id" 
    : params.entityType === "transaction" ? "transaction_id" 
    : "contact_id"

  const { data, error } = await supabase
    .from("activities")
    .select("id, activity_type, title, created_at, notes")
    .eq(entityColumn, params.entityId)
    .eq("activity_type", params.eventType)
    .order("created_at", { ascending: false })
    .limit(1)
    .single()

  if (error || !data) {
    return null
  }

  const parsed = data.notes ? JSON.parse(data.notes) : {}

  return {
    id: data.id,
    eventType: data.activity_type,
    title: data.title,
    timestamp: data.created_at,
    metadata: parsed.metadata || {},
  }
}

/**
 * Count events by type prefix
 */
export async function countEventsByType(
  supabase: SupabaseClient,
  params: {
    entityType: "listing" | "transaction" | "contact"
    entityId: string
    eventTypePrefix: string
  }
): Promise<number> {
  const entityColumn = params.entityType === "listing" ? "listing_id" 
    : params.entityType === "transaction" ? "transaction_id" 
    : "contact_id"

  const { count, error } = await supabase
    .from("activities")
    .select("id", { count: "exact", head: true })
    .eq(entityColumn, params.entityId)
    .ilike("activity_type", `${params.eventTypePrefix}%`)

  if (error) {
    return 0
  }

  return count || 0
}
