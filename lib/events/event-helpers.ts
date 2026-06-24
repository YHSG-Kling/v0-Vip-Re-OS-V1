

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

  // Map EventInput to the actual lifecycle_events schema columns
  const row = {
    brokerage_id:  eventInput.brokerage_id,
    actor_user_id: eventInput.user_id ?? null,   // lifecycle_events uses actor_user_id
    event_type:    eventInput.event_type,
    metadata:      eventInput.payload,            // lifecycle_events uses metadata not payload
    source:        eventInput.source,
    dedupe_key:    eventInput.dedupe_key ?? null,
    processed:     false,
    // entity_id / entity_type may be derived from payload if available
    entity_id:   (eventInput.payload as any)?.contact_id
                  ?? (eventInput.payload as any)?.listing_id
                  ?? (eventInput.payload as any)?.video_id
                  ?? null,
    entity_type: (eventInput.payload as any)?.contact_id   ? "contact"
                : (eventInput.payload as any)?.listing_id  ? "listing"
                : (eventInput.payload as any)?.video_id    ? "video"
                : "system",
  }

  // Insert event
  const { data: event, error } = await supabase.from("lifecycle_events").insert([row]).select().single()

  if (error) {
    console.error("[v0] Error inserting event:", error)
    throw error
  }

  // Fire the registered dispatcher asynchronously (registered by app/ layer).
  // If no dispatcher is registered, event is persisted and processed later.
  const dispatcher = getDispatcher()
  if (dispatcher) {
    dispatcher(event as Event).catch((err) => {
      console.error("[v0] Orchestration error:", err)
    })
  }

  return event as Event
}

// =====================================================
// CONVENIENCE FUNCTIONS - Typed event creators
// =====================================================

export async function logListingSigned(params: {
  brokerage_id: string
  user_id: string
  listing_id: string
  go_live_date: string
}): Promise<Event> {
  return logEventAndTrigger({
    brokerage_id: params.brokerage_id,
    user_id: params.user_id,
    event_type: KernelEvent.LISTING_AGREEMENT_SIGNED,
    payload: {
      listing_id: params.listing_id,
      go_live_date: params.go_live_date,
    },
    source: "ui",
    dedupe_key: `listing_signed_${params.listing_id}`,
  })
}

export async function logListingLive(params: {
  brokerage_id: string
  user_id: string
  listing_id: string
  mls_number: string
}): Promise<Event> {
  return logEventAndTrigger({
    brokerage_id: params.brokerage_id,
    user_id: params.user_id,
    event_type: KernelEvent.LISTING_PUBLISHED,
    payload: {
      listing_id: params.listing_id,
      mls_number: params.mls_number,
    },
    source: "ui",
    dedupe_key: `listing_live_${params.listing_id}`,
  })
}

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
