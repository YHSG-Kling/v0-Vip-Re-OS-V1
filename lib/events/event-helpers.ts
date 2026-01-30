

import { createServerClient } from "@/lib/supabase/server"
import { orchestrateEvent, type EventInput, type Event } from "@/app/actions/orchestrator"

// =====================================================
// MAIN HELPER - Log event and trigger orchestration
// =====================================================

export async function logEventAndTrigger(eventInput: EventInput): Promise<Event> {
  const supabase = await createServerClient()

  // Check for duplicate if dedupe_key provided
  if (eventInput.dedupe_key) {
    const { data: existingEvent } = await supabase
      .from("events")
      .select("id")
      .eq("dedupe_key", eventInput.dedupe_key)
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .single()

    if (existingEvent) {
      console.log(`[v0] Duplicate event detected: ${eventInput.dedupe_key}`)
      throw new Error("DUPLICATE_EVENT")
    }
  }

  // Insert event
  const { data: event, error } = await supabase.from("events").insert([eventInput]).select().single()

  if (error) {
    console.error("[v0] Error inserting event:", error)
    throw error
  }

  // Trigger orchestration asynchronously
  // In production, this should be a queue/background job
  orchestrateEvent(event as Event).catch((err) => {
    console.error("[v0] Orchestration error:", err)
  })

  return event as Event
}

// =====================================================
// CONVENIENCE FUNCTIONS - Typed event creators
// =====================================================

export async function logLeadCreated(params: {
  brokerage_id: string
  user_id: string
  contact_id: string
  source: string
  timeline: string
}): Promise<Event> {
  return logEventAndTrigger({
    brokerage_id: params.brokerage_id,
    user_id: params.user_id,
    event_type: "lead.created",
    payload: {
      contact_id: params.contact_id,
      source: params.source,
      timeline: params.timeline,
    },
    source: "ui",
    dedupe_key: `lead_created_${params.contact_id}`,
  })
}

export async function logLeadTaggedHot(params: {
  brokerage_id: string
  user_id: string
  contact_id: string
  reason: string
}): Promise<Event> {
  return logEventAndTrigger({
    brokerage_id: params.brokerage_id,
    user_id: params.user_id,
    event_type: "lead.tagged_hot",
    payload: {
      contact_id: params.contact_id,
      reason: params.reason,
    },
    source: "ui",
  })
}

export async function logListingAppointmentSet(params: {
  brokerage_id: string
  user_id: string
  listing_id: string
  contact_id: string
  appointment_date: string
}): Promise<Event> {
  return logEventAndTrigger({
    brokerage_id: params.brokerage_id,
    user_id: params.user_id,
    event_type: "listing.appointment_set",
    payload: {
      listing_id: params.listing_id,
      contact_id: params.contact_id,
      appointment_date: params.appointment_date,
    },
    source: "ui",
    dedupe_key: `listing_appointment_${params.listing_id}_${params.appointment_date}`,
  })
}

export async function logListingSigned(params: {
  brokerage_id: string
  user_id: string
  listing_id: string
  go_live_date: string
}): Promise<Event> {
  return logEventAndTrigger({
    brokerage_id: params.brokerage_id,
    user_id: params.user_id,
    event_type: "listing.signed",
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
    event_type: "listing.live",
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
  listing_id: string
}): Promise<Event> {
  return logEventAndTrigger({
    brokerage_id: params.brokerage_id,
    user_id: params.user_id,
    event_type: "transaction.milestone_overdue",
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
    event_type: "credit.status_updated",
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
    event_type: "video.generated",
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
