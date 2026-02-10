/**
 * System 5.2: Listing Lifecycle Core - Enhanced Readiness Evaluation
 * 
 * GOVERNANCE PATCH: Readiness evaluation from integration events
 * 
 * Do NOT persist readiness flags.
 * Readiness must be DERIVED from:
 * - Integration events in `activities`
 * - Existing listing fields
 * 
 * Examples:
 * - media_ready = media.assets.approved event exists
 * - documents_complete = dotloop.documents.completed event exists
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { getLatestEvent, queryEventsByEntityAndType } from "./event-storage"
import { INTEGRATION_EVENT_TYPES } from "./integration-deduplication"
import type { ReadinessCheckType, ReadinessCheckResult } from "./readiness-checker"

/**
 * Evaluate media readiness from integration events
 * Derived from: integration.media.assets.approved event
 */
export async function evaluateMediaReadinessFromEvents(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  // Check for media assets approved event
  const approvedEvent = await getLatestEvent(supabase, {
    entityType: "listing",
    entityId: listingId,
    eventType: INTEGRATION_EVENT_TYPES.MEDIA_ASSETS_APPROVED,
  })

  if (!approvedEvent) {
    return {
      check: "media_approved",
      passed: false,
      reason: "No media assets approved event found",
    }
  }

  // Check metadata for photo count
  const photoCount = approvedEvent.metadata?.photo_count || 0

  return {
    check: "media_approved",
    passed: photoCount >= 10,
    reason: photoCount >= 10
      ? undefined
      : `Only ${photoCount} photo(s) approved. Minimum 10 required.`,
    details: { 
      approvedPhotos: photoCount,
      eventTimestamp: approvedEvent.timestamp,
    },
  }
}

/**
 * Evaluate document readiness from integration events
 * Derived from: integration.documents.completed event
 */
export async function evaluateDocumentReadinessFromEvents(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  // Check for documents completed event
  const completedEvent = await getLatestEvent(supabase, {
    entityType: "listing",
    entityId: listingId,
    eventType: INTEGRATION_EVENT_TYPES.DOCUMENTS_COMPLETED,
  })

  if (!completedEvent) {
    return {
      check: "documents_verified",
      passed: false,
      reason: "No documents completed event found",
    }
  }

  return {
    check: "documents_verified",
    passed: true,
    details: {
      eventTimestamp: completedEvent.timestamp,
      documentCount: completedEvent.metadata?.document_count || 0,
    },
  }
}

/**
 * Evaluate signature readiness from integration events
 * Derived from: integration.signatures.received event
 */
export async function evaluateSignatureReadinessFromEvents(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  // Check for signatures received event
  const signaturesEvent = await getLatestEvent(supabase, {
    entityType: "listing",
    entityId: listingId,
    eventType: INTEGRATION_EVENT_TYPES.SIGNATURES_RECEIVED,
  })

  if (!signaturesEvent) {
    return {
      check: "dotloop_signatures",
      passed: false,
      reason: "No signatures received event found",
    }
  }

  return {
    check: "dotloop_signatures",
    passed: true,
    details: {
      eventTimestamp: signaturesEvent.timestamp,
      signatureCount: signaturesEvent.metadata?.signature_count || 0,
    },
  }
}

/**
 * Evaluate MLS readiness from integration events
 * Derived from: integration.mls.synced or integration.mls.activated event
 */
export async function evaluateMLSReadinessFromEvents(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  // Check for MLS activated event (preferred)
  let mlsEvent = await getLatestEvent(supabase, {
    entityType: "listing",
    entityId: listingId,
    eventType: INTEGRATION_EVENT_TYPES.MLS_ACTIVATED,
  })

  // Fallback to MLS synced event
  if (!mlsEvent) {
    mlsEvent = await getLatestEvent(supabase, {
      entityType: "listing",
      entityId: listingId,
      eventType: INTEGRATION_EVENT_TYPES.MLS_SYNCED,
    })
  }

  if (!mlsEvent) {
    return {
      check: "mls_data_complete",
      passed: false,
      reason: "No MLS sync event found",
    }
  }

  // Check if event is recent (within 7 days)
  const eventDate = new Date(mlsEvent.timestamp)
  const now = new Date()
  const daysSinceEvent = (now.getTime() - eventDate.getTime()) / (1000 * 60 * 60 * 24)

  return {
    check: "mls_data_complete",
    passed: daysSinceEvent <= 7,
    reason: daysSinceEvent > 7
      ? `MLS data last synced ${Math.floor(daysSinceEvent)} days ago. May be stale.`
      : undefined,
    details: {
      eventTimestamp: mlsEvent.timestamp,
      daysSinceSync: Math.floor(daysSinceEvent),
      mlsNumber: mlsEvent.metadata?.mls_number,
    },
  }
}

/**
 * Evaluate repair completion from integration events
 * Derived from: integration.repair.completed events
 */
export async function evaluateRepairReadinessFromEvents(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  // Get all repair events
  const repairEvents = await queryEventsByEntityAndType(supabase, {
    entityType: "listing",
    entityId: listingId,
    eventTypePrefix: "integration.repair",
  })

  const scheduledRepairs = repairEvents.filter((e) => 
    e.eventType === INTEGRATION_EVENT_TYPES.REPAIR_SCHEDULED
  )
  
  const completedRepairs = repairEvents.filter((e) => 
    e.eventType === INTEGRATION_EVENT_TYPES.REPAIR_COMPLETED
  )

  const incompleteRepairs = scheduledRepairs.length - completedRepairs.length

  return {
    check: "repairs_completed",
    passed: incompleteRepairs === 0,
    reason: incompleteRepairs > 0
      ? `${incompleteRepairs} repair(s) not completed`
      : undefined,
    details: {
      scheduledRepairs: scheduledRepairs.length,
      completedRepairs: completedRepairs.length,
      incompleteRepairs,
    },
  }
}

/**
 * Evaluate showing readiness from integration events
 * Derived from: integration.showing.* events
 */
export async function evaluateShowingReadinessFromEvents(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  // Check for any showing events
  const showingEvents = await queryEventsByEntityAndType(supabase, {
    entityType: "listing",
    entityId: listingId,
    eventTypePrefix: "integration.showing",
    limit: 1,
  })

  const showingsEnabled = showingEvents.length > 0

  return {
    check: "showings_enabled",
    passed: showingsEnabled,
    reason: showingsEnabled ? undefined : "No showing events found",
    details: {
      showingEventCount: showingEvents.length,
    },
  }
}

/**
 * Evaluate offer readiness from integration events
 * Derived from: integration.offer.received event
 */
export async function evaluateOfferReadinessFromEvents(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  // Check for offer received event
  const offerEvent = await getLatestEvent(supabase, {
    entityType: "listing",
    entityId: listingId,
    eventType: INTEGRATION_EVENT_TYPES.OFFER_RECEIVED,
  })

  if (!offerEvent) {
    return {
      check: "offer_exists",
      passed: false,
      reason: "No offer received event found",
    }
  }

  return {
    check: "offer_exists",
    passed: true,
    details: {
      eventTimestamp: offerEvent.timestamp,
      offerAmount: offerEvent.metadata?.offer_amount,
    },
  }
}

/**
 * Evaluate transaction readiness from integration events
 * Derived from: integration.transaction.created event
 */
export async function evaluateTransactionReadinessFromEvents(
  supabase: SupabaseClient,
  listingId: string
): Promise<ReadinessCheckResult> {
  // Check for transaction created event
  const transactionEvent = await getLatestEvent(supabase, {
    entityType: "listing",
    entityId: listingId,
    eventType: INTEGRATION_EVENT_TYPES.TRANSACTION_CREATED,
  })

  if (!transactionEvent) {
    return {
      check: "contract_signed",
      passed: false,
      reason: "No transaction created event found",
    }
  }

  return {
    check: "contract_signed",
    passed: true,
    details: {
      eventTimestamp: transactionEvent.timestamp,
      transactionId: transactionEvent.metadata?.transaction_id,
    },
  }
}

/**
 * Composite readiness evaluation using BOTH database and events
 * This is the recommended evaluation method
 */
export async function evaluateCompositeReadiness(
  supabase: SupabaseClient,
  listingId: string,
  checkType: ReadinessCheckType
): Promise<ReadinessCheckResult> {
  switch (checkType) {
    case "media_approved":
      return await evaluateMediaReadinessFromEvents(supabase, listingId)
    
    case "documents_verified":
      return await evaluateDocumentReadinessFromEvents(supabase, listingId)
    
    case "dotloop_signatures":
      return await evaluateSignatureReadinessFromEvents(supabase, listingId)
    
    case "mls_data_complete":
      return await evaluateMLSReadinessFromEvents(supabase, listingId)
    
    case "repairs_completed":
      return await evaluateRepairReadinessFromEvents(supabase, listingId)
    
    case "showings_enabled":
      return await evaluateShowingReadinessFromEvents(supabase, listingId)
    
    case "offer_exists":
      return await evaluateOfferReadinessFromEvents(supabase, listingId)
    
    case "contract_signed":
      return await evaluateTransactionReadinessFromEvents(supabase, listingId)
    
    default:
      // Fall back to original implementation for other checks
      return {
        check: checkType,
        passed: false,
        reason: "Check not implemented in enhanced evaluation",
      }
  }
}

/**
 * Evaluate all readiness checks using composite method
 */
export async function evaluateAllReadinessComposite(
  supabase: SupabaseClient,
  listingId: string,
  requiredChecks: ReadinessCheckType[]
): Promise<{
  allPassed: boolean
  results: ReadinessCheckResult[]
  passedChecks: string[]
  failedChecks: string[]
}> {
  const results: ReadinessCheckResult[] = []
  
  for (const check of requiredChecks) {
    const result = await evaluateCompositeReadiness(supabase, listingId, check)
    results.push(result)
  }
  
  const passedChecks = results.filter((r) => r.passed).map((r) => r.check)
  const failedChecks = results.filter((r) => !r.passed).map((r) => r.check)
  
  return {
    allPassed: failedChecks.length === 0,
    results,
    passedChecks,
    failedChecks,
  }
}
