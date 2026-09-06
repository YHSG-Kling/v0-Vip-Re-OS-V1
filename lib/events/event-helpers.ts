

import { createServerClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import type { EventInput, Event } from "./types"

/**
 * Optional orchestration hook registered by the app/ layer at startup.
 * lib/events/ persists events and fires this callback if set.
 * This avoids any lib→app import — the app/ layer owns the wiring.
 *
 * Register via: import { registerEventDispatcher } from "@/lib/events/event-helpers"
 */
type EventDispatcher = (event: Event) => Promise<void>
let _dispatcher: EventDispatcher | null = null

export function registerEventDispatcher(fn: EventDispatcher): void {
  _dispatcher = fn
}

function getDispatcher(): EventDispatcher | null {
  return _dispatcher
}

// =====================================================
// MAIN HELPER - Log event and trigger orchestration
// =====================================================

export async function logEventAndTrigger(eventInput: EventInput): Promise<Event> {
  const supabase = await createServerClient()

  // Require brokerage_id — never insert without it (kernel RLS invariant)
  if (!eventInput.brokerage_id) {
    console.error("[v0] logEventAndTrigger: brokerage_id is required but missing", eventInput.event_type)
    throw new Error("MISSING_BROKERAGE_ID")
  }

  // Check for duplicate if dedupe_key provided
  if (eventInput.dedupe_key) {
    const { data: existingEvent } = await supabase
      .from("lifecycle_events")
      .select("id")
      .eq("dedupe_key", eventInput.dedupe_key)
      .eq("brokerage_id", eventInput.brokerage_id)
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .maybeSingle()

    if (existingEvent) {
      console.log(`[v0] Duplicate event detected: ${eventInput.dedupe_key}`)
      throw new Error("DUPLICATE_EVENT")
    }
  }

  // Map EventInput to the actual lifecycle_events schema columns.
  //
  // entity_id / entity_type are NOT NULL on the live table (verified 2026-09-03 on
  // hrvaqgvukzxfskkcrwbt). The old derivation fell back to entity_id NULL /
  // entity_type 'system' for any payload without contact_id/listing_id/video_id —
  // so ESIGN_PACKET_SIGNED (payload.documentId), MILESTONE_OVERDUE with no listing,
  // and every webhook event of that shape were REFUSED (23502) and this function
  // threw. The fallback is now the brokerage itself (the same rule
  // app/actions/orchestrator.ts emitEvent already applies), and callers may name
  // the entity explicitly.
  const pl = (eventInput.payload ?? {}) as Record<string, any>
  const derivedEntityId: string | null =
    pl.contact_id ?? pl.listing_id ?? pl.video_id ?? pl.transaction_id ?? pl.offer_id ?? pl.documentId ?? pl.agreementId ?? null
  const derivedEntityType: string =
    pl.contact_id ? "contact"
    : pl.listing_id ? "listing"
    : pl.video_id ? "video"
    : pl.transaction_id ? "transaction"
    : pl.offer_id ? "offer"
    : pl.documentId ? "document"
    : pl.agreementId ? "buyer_broker_agreement"
    : "brokerage"
  const entityId   = eventInput.entity_id   ?? derivedEntityId   ?? eventInput.brokerage_id
  const entityType = eventInput.entity_type ?? (derivedEntityId ? derivedEntityType : "brokerage")

  const row = {
    brokerage_id:  eventInput.brokerage_id,
    actor_user_id: eventInput.user_id ?? null,   // lifecycle_events uses actor_user_id (FK users)
    event_type:    eventInput.event_type,
    metadata:      pl,                            // lifecycle_events uses metadata not payload
    source:        eventInput.source,
    dedupe_key:    eventInput.dedupe_key ?? null,
    processed:     false,
    entity_id:     entityId,
    entity_type:   entityType,
  }

  // Insert event
  const { data: event, error } = await supabase.from("lifecycle_events").insert([row]).select().single()

  if (error) {
    console.error("[v0] Error inserting event:", error)
    throw error
  }

  // The row's `payload` column is NOT NULL DEFAULT '{}' and this helper writes
  // `metadata`, so the persisted row comes back with payload {} — handing THAT to
  // the dispatcher gave every orchestrator handler an empty payload. Dispatch the
  // event as it was given, with the persisted id/timestamps.
  const dispatched = { ...(event as Event), payload: pl }

  // Fire the registered dispatcher asynchronously (registered by app/ layer).
  // If no dispatcher is registered, event is persisted and processed later.
  const dispatcher = getDispatcher()
  if (dispatcher) {
    dispatcher(dispatched).catch((err) => {
      console.error("[v0] Orchestration error:", err)
    })
  }

  // ONE VOCABULARY (2026-09-03): the orchestrator above routes DOTTED event types
  // ("listing.signed"); a KernelEvent value ("esign_packet_signed",
  // "buyer_broker_agreement_signed", "milestone_overdue") never matched its
  // switch, so the row landed and the reactor (staff bell / sequences / portal
  // template) never heard it. The row is already written → skipInsert.
  // emitKernelEvent gates on the enum itself, so dotted events are a no-op here.
  // Loaded at call time: it is `server-only` and this module is reachable from
  // simulators under plain tsx.
  try {
    const { emitKernelEvent, isKernelEventValue } = await import("@/lib/kernel/emit")
    if (isKernelEventValue(eventInput.event_type)) {
      await emitKernelEvent({
        event:            eventInput.event_type,
        brokerageId:      eventInput.brokerage_id,
        entityType,
        entityId,
        lifecycleEventId: (event as Event).id,
        contactId:        typeof pl.contact_id === "string" ? pl.contact_id : undefined,
        transactionId:    typeof pl.transaction_id === "string" ? pl.transaction_id : undefined,
        listingId:        typeof pl.listing_id === "string" ? pl.listing_id : undefined,
        agentUserId:      eventInput.user_id,
        metadata:         pl,
        skipInsert:       true,
      })
    }
  } catch (err) {
    console.error("[v0] kernel fan-out failed (row persisted):", err)
  }

  return dispatched
}

// =====================================================
// CONVENIENCE FUNCTIONS - Typed event creators
// =====================================================

// logListingSigned + logListingLive RETIRED with the mark*Service callers — they emitted underscore
// events (LISTING_AGREEMENT_SIGNED / LISTING_PUBLISHED) the dotted dispatcher switch never matched.

export async function logMilestoneOverdue(params: {
  brokerage_id: string
  user_id: string
  milestone_id: string
  milestone_title: string
  days_overdue: number
  listing_id?: string | null
}): Promise<Event> {
  return logEventAndTrigger({
    brokerage_id: params.brokerage_id,
    user_id: params.user_id,
    event_type: KernelEvent.MILESTONE_OVERDUE,
    payload: {
      milestone_id: params.milestone_id,
      milestone_title: params.milestone_title,
      days_overdue: params.days_overdue,
      listing_id: params.listing_id,
    },
    source: "system",
  })
}

export async function logCreditStatusUpdated(params: {
  brokerage_id: string
  user_id: string
  contact_id: string
  old_status: string
  new_status: string
  score_band?: string
}): Promise<Event> {
  return logEventAndTrigger({
    brokerage_id: params.brokerage_id,
    user_id: params.user_id,
    event_type: KernelEvent.CREDIT_STATUS_UPDATED,
    payload: {
      contact_id: params.contact_id,
      old_status: params.old_status,
      new_status: params.new_status,
      score_band: params.score_band,
    },
    source: "ui",
  })
}

export async function logVideoGenerated(params: {
  brokerage_id: string
  user_id: string
  video_id: string
  video_type: string
  listing_id?: string
}): Promise<Event> {
  return logEventAndTrigger({
    brokerage_id: params.brokerage_id,
    user_id: params.user_id,
    event_type: KernelEvent.VIDEO_GENERATION_COMPLETED,
    payload: {
      video_id: params.video_id,
      video_type: params.video_type,
      listing_id: params.listing_id,
    },
    source: "system",
    dedupe_key: `video_generated_${params.video_id}`,
  })
}

// =====================================================
// WEBHOOK HANDLER - For external events
// =====================================================

export async function handleWebhookEvent(webhookPayload: any): Promise<Event> {
  // Parse webhook and convert to internal event format
  // This is a placeholder - adjust based on your webhook provider

  const eventInput: EventInput = {
    brokerage_id: webhookPayload.brokerage_id,
    user_id: webhookPayload.user_id,
    event_type: webhookPayload.event_type,
    payload: webhookPayload.data,
    source: "webhook",
    dedupe_key: webhookPayload.id, // Use webhook ID as dedupe key
  }

  return logEventAndTrigger(eventInput)
}
