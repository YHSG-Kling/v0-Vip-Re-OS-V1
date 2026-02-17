/**
 * System 5.2: Listing Lifecycle Core - Integration Event Deduplication
 * 
 * GOVERNANCE PATCH: Integration events MUST be idempotent
 * 
 * Deduplicate by:
 * - entity_id
 * - type
 * - integration_source
 * - external_event_id OR metadata hash
 * 
 * Ignore duplicate events gracefully
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { storeLifecycleEvent, checkEventExists } from "./event-storage"
import type { LifecycleEventStorageParams } from "./event-storage"

/**
 * Store integration event with automatic deduplication
 * Returns { success: true, isDuplicate: true } for duplicate events
 */
export async function storeIntegrationEventIdempotent(
  supabase: SupabaseClient,
  params: LifecycleEventStorageParams & {
    eventData: LifecycleEventStorageParams["eventData"] & {
      integrationSource: string
      externalEventId?: string
    }
  }
): Promise<{
  success: boolean
  eventId?: string
  isDuplicate?: boolean
  error?: string
}> {
  // Check if event already exists
  const exists = await checkEventExists(supabase, {
    entityType: params.entityType,
    entityId: params.entityId,
    eventType: params.eventType,
    integrationSource: params.eventData.integrationSource,
    externalEventId: params.eventData.externalEventId,
  })

  if (exists) {
    return {
      success: true,
      isDuplicate: true,
    }
  }

  // Store new event
  return await storeLifecycleEvent(supabase, params)
}

/**
 * Compute metadata hash for deduplication when external_event_id is not available
 */
export function computeMetadataHash(metadata: Record<string, any>): string {
  const sortedKeys = Object.keys(metadata).sort()
  const normalized = sortedKeys.map((key) => `${key}:${JSON.stringify(metadata[key])}`).join("|")
  
  // Simple hash function (for deduplication, not security)
  let hash = 0
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32-bit integer
  }
  
  return hash.toString(36)
}

/**
 * Store integration event with metadata-based deduplication
 * Used when integration doesn't provide external_event_id
 */
export async function storeIntegrationEventWithMetadataHash(
  supabase: SupabaseClient,
  params: LifecycleEventStorageParams & {
    eventData: LifecycleEventStorageParams["eventData"] & {
      integrationSource: string
    }
  }
): Promise<{
  success: boolean
  eventId?: string
  isDuplicate?: boolean
  error?: string
}> {
  // Compute metadata hash
  const metadataHash = computeMetadataHash(params.eventData.metadata || {})

  // Use metadata hash as external_event_id
  return await storeIntegrationEventIdempotent(supabase, {
    ...params,
    eventData: {
      ...params.eventData,
      externalEventId: metadataHash,
    },
  })
}

/**
 * Batch store integration events with deduplication
 * Returns summary of stored, duplicate, and failed events
 */
export async function batchStoreIntegrationEvents(
  supabase: SupabaseClient,
  events: Array<LifecycleEventStorageParams & {
    eventData: LifecycleEventStorageParams["eventData"] & {
      integrationSource: string
      externalEventId?: string
    }
  }>
): Promise<{
  success: boolean
  summary: {
    total: number
    stored: number
    duplicates: number
    failed: number
  }
  results: Array<{
    eventType: string
    success: boolean
    isDuplicate?: boolean
    error?: string
  }>
}> {
  const results: Array<{
    eventType: string
    success: boolean
    isDuplicate?: boolean
    error?: string
  }> = []

  let stored = 0
  let duplicates = 0
  let failed = 0

  for (const event of events) {
    const result = await storeIntegrationEventIdempotent(supabase, event)
    
    if (result.success) {
      if (result.isDuplicate) {
        duplicates++
      } else {
        stored++
      }
    } else {
      failed++
    }

    results.push({
      eventType: event.eventType,
      success: result.success,
      isDuplicate: result.isDuplicate,
      error: result.error,
    })
  }

  return {
    success: true,
    summary: {
      total: events.length,
      stored,
      duplicates,
      failed,
    },
    results,
  }
}

/**
 * Check for duplicate events in batch before storing
 * Useful for pre-filtering large batches
 */
export async function filterDuplicateEvents<T extends {
  entityType: "listing" | "transaction" | "contact"
  entityId: string
  eventType: string
  integrationSource: string
  externalEventId?: string
}>(
  supabase: SupabaseClient,
  events: T[]
): Promise<{
  newEvents: T[]
  duplicateEvents: T[]
}> {
  const newEvents: T[] = []
  const duplicateEvents: T[] = []

  for (const event of events) {
    const exists = await checkEventExists(supabase, {
      entityType: event.entityType,
      entityId: event.entityId,
      eventType: event.eventType,
      integrationSource: event.integrationSource,
      externalEventId: event.externalEventId,
    })

    if (exists) {
      duplicateEvents.push(event)
    } else {
      newEvents.push(event)
    }
  }

  return { newEvents, duplicateEvents }
}

/**
 * Integration event types (standardized)
 */
export const INTEGRATION_EVENT_TYPES = {
  // Media integrations
  MEDIA_ASSETS_UPLOADED: "integration.media.assets.uploaded",
  MEDIA_ASSETS_APPROVED: "integration.media.assets.approved",
  
  // Document integrations (Dotloop, etc.)
  DOCUMENTS_UPLOADED: "integration.documents.uploaded",
  DOCUMENTS_COMPLETED: "integration.documents.completed",
  SIGNATURES_RECEIVED: "integration.signatures.received",
  
  // MLS integrations
  MLS_SYNCED: "integration.mls.synced",
  MLS_UPDATED: "integration.mls.updated",
  MLS_ACTIVATED: "integration.mls.activated",
  
  // Showing integrations
  SHOWING_SCHEDULED: "integration.showing.scheduled",
  SHOWING_COMPLETED: "integration.showing.completed",
  SHOWING_FEEDBACK_RECEIVED: "integration.showing.feedback_received",
  
  // Offer integrations
  OFFER_RECEIVED: "integration.offer.received",
  OFFER_UPDATED: "integration.offer.updated",
  OFFER_ACCEPTED: "integration.offer.accepted",
  
  // Transaction integrations
  TRANSACTION_CREATED: "integration.transaction.created",
  TRANSACTION_UPDATED: "integration.transaction.updated",
  TRANSACTION_CLOSED: "integration.transaction.closed",
  
  // Marketing integrations
  MARKETING_CAMPAIGN_LAUNCHED: "integration.marketing.campaign.launched",
  MARKETING_CAMPAIGN_COMPLETED: "integration.marketing.campaign.completed",
  
  // Repair integrations
  REPAIR_SCHEDULED: "integration.repair.scheduled",
  REPAIR_COMPLETED: "integration.repair.completed",
} as const

export type IntegrationEventType = typeof INTEGRATION_EVENT_TYPES[keyof typeof INTEGRATION_EVENT_TYPES]

/**
 * Integration sources (standardized)
 */
export const INTEGRATION_SOURCES = {
  DOTLOOP: "dotloop",
  MLS: "mls",
  SHOWINGTIME: "showingtime",
  ZILLOW: "zillow",
  FACEBOOK: "facebook",
  INSTAGRAM: "instagram",
  GOOGLE_ADS: "google_ads",
  EMAIL_PLATFORM: "email_platform",
  SMS_PLATFORM: "sms_platform",
  PHOTO_VENDOR: "photo_vendor",
  VIDEO_VENDOR: "video_vendor",
  REPAIR_VENDOR: "repair_vendor",
  TRANSACTION_COORDINATOR: "transaction_coordinator",
  INTERNAL_SYSTEM: "internal_system",
} as const

export type IntegrationSource = typeof INTEGRATION_SOURCES[keyof typeof INTEGRATION_SOURCES]
