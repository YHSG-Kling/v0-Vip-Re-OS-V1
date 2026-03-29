"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import { markOpenHouseCompleted } from "@/app/actions/seller-listing/execution-engine"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function isValidUUID(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

// ─────────────────────────────────────────────────────────────────────────────
// LOAD PAGE DATA
// ─────────────────────────────────────────────────────────────────────────────

export async function getOpenHouseDashboard(listingId: string) {
  if (!isValidUUID(listingId)) return null
  const supabase = await createClient()

  const [{ data: listing }, { data: events }, { data: posts }, { data: invitations }] =
    await Promise.all([
      supabase
        .from("listings")
        .select("id, address, city, state, zip, brokerage_id, agent_id, go_live_date, open_house_marketing_date, open_house_event_date, list_price, lifecycle_stage")
        .eq("id", listingId)
        .single(),
      supabase
        .from("open_house_events")
        .select("*, qr_codes(id, slug, scan_count, target_url)")
        .eq("listing_id", listingId)
        .order("event_date", { ascending: false }),
      supabase
        .from("social_posts")
        .select("id, platform, post_type, content, status, approval_status, scheduled_for, published_at, brand_compliance_passed")
        .eq("listing_id", listingId)
        .in("post_type", ["open_house_announcement", "open_house_reminder", "coming_soon"])
        .order("scheduled_for", { ascending: true }),
      supabase
        .from("open_house_invitations")
        .select("id, contact_id, status, channel, rsvp_response, sent_at")
        .in(
          "event_id",
          // sub-select all event ids for this listing — resolved below
          ["00000000-0000-0000-0000-000000000000"]
        )
        .limit(0), // placeholder; real fetch done per-event below
    ])

  // Fetch attendees for each event
  const eventIds = (events ?? []).map((e) => e.id)
  const { data: attendees } = eventIds.length
    ? await supabase
        .from("open_house_attendees")
        .select("id, event_id, contact_id, check_in_time, working_with_agent, ai_lead_score, interest_level, arrival_time, notes, brokerage_id")
        .in("event_id", eventIds)
        .order("check_in_time", { ascending: false })
    : { data: [] }

  // Fetch invitations properly
  const { data: realInvitations } = eventIds.length
    ? await supabase
        .from("open_house_invitations")
        .select("id, event_id, contact_id, status, channel, rsvp_response, sent_at, opened_at, clicked_at")
        .in("event_id", eventIds)
    : { data: [] }

  // Fetch packet jobs
  const { data: packetJobs } = await supabase
    .from("listing_packet_jobs")
    .select("id, job_type, status, output_url, completed_at")
    .eq("listing_id", listingId)
    .eq("job_type", "open_house_booklet")
    .order("created_at", { ascending: false })
    .limit(1)

  return {
    listing,
    events: events ?? [],
    attendees: attendees ?? [],
    socialPosts: posts ?? [],
    invitations: realInvitations ?? [],
    packetJob: packetJobs?.[0] ?? null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 1 — MARKETING: INVITE CONTACTS
// ─────────────────────────────────────────────────────────────────────────────

export async function inviteFarmContacts(params: {
  eventId: string
  listingId: string
  brokerageId: string
  agentId: string
  zip: string
  channel: "email" | "sms" | "both"
}) {
  if (!isValidUUID(params.eventId)) return { success: false, error: "Invalid event ID" }
  const supabase = await createClient()

  // Load farm contacts by zip
  const { data: contacts, error: contactErr } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone, dnc_status, tcpa_consent")
    .eq("brokerage_id", params.brokerageId)
    .eq("zip", params.zip)
    .eq("dnc_status", false)
    .not("deleted_at", "is", null)
    .is("deleted_at", null)

  if (contactErr) return { success: false, error: contactErr.message }
  if (!contacts?.length) return { success: false, error: "No farm contacts found for this zip" }

  // Load event for context
  const { data: event } = await supabase
    .from("open_house_events")
    .select("event_date, start_time, end_time")
    .eq("id", params.eventId)
    .single()

  const channels: Array<"email" | "sms"> =
    params.channel === "both" ? ["email", "sms"] : [params.channel]

  // Build invitation rows — one per contact per channel, dedup on conflict
  const invitationRows = contacts.flatMap((contact) =>
    channels
      .filter((ch) => {
        if (ch === "email" && !contact.email) return false
        if (ch === "sms" && (!contact.phone || !contact.tcpa_consent)) return false
        return true
      })
      .map((ch) => ({
        event_id: params.eventId,
        contact_id: contact.id,
        brokerage_id: params.brokerageId,
        channel: ch,
        invitation_type: "open_house",
        status: "invited",
        sent_at: new Date().toISOString(),
      }))
  )

  if (!invitationRows.length) {
    return { success: false, error: "No eligible contacts after channel/consent filtering" }
  }

  // INSERT invitations (ignore duplicates)
  const { error: invErr } = await supabase
    .from("open_house_invitations")
    .upsert(invitationRows, { onConflict: "event_id,contact_id,channel", ignoreDuplicates: true })

  if (invErr) return { success: false, error: invErr.message }

  // INSERT rsvp_tracking rows (status='invited')
  const rsvpRows = contacts.map((contact) => ({
    event_id: params.eventId,
    contact_id: contact.id,
    rsvp_status: "invited",
    source: params.channel === "email" ? "email" : "sms",
    rsvp_updated_at: new Date().toISOString(),
  }))

  await supabase
    .from("open_house_rsvp_tracking")
    .upsert(rsvpRows, { onConflict: "event_id,contact_id", ignoreDuplicates: true })

  revalidatePath(`/dashboard/listings/${params.listingId}/open-house`)
  return { success: true, invited: invitationRows.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 1 — UPDATE RSVP
// ─────────────────────────────────────────────────────────────────────────────

export async function updateRsvp(params: {
  eventId: string
  contactId: string
  listingId: string
  rsvpResponse: "yes" | "maybe" | "no"
}) {
  if (!isValidUUID(params.eventId) || !isValidUUID(params.contactId))
    return { success: false, error: "Invalid IDs" }

  const supabase = await createClient()

  await supabase
    .from("open_house_invitations")
    .update({ rsvp_response: params.rsvpResponse, rsvp_updated_at: new Date().toISOString() })
    .eq("event_id", params.eventId)
    .eq("contact_id", params.contactId)

  await supabase
    .from("open_house_rsvp_tracking")
    .upsert(
      {
        event_id: params.eventId,
        contact_id: params.contactId,
        rsvp_status: params.rsvpResponse,
        rsvp_updated_at: new Date().toISOString(),
      },
      { onConflict: "event_id,contact_id" }
    )

  revalidatePath(`/dashboard/listings/${params.listingId}/open-house`)
  return { success: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 2 — CREATE QR CODE FOR EVENT
// ─────────────────────────────────────────────────────────────────────────────

export async function createQrCodeForEvent(params: {
  eventId: string
  listingId: string
  brokerageId: string
  agentId: string
}) {
  if (!isValidUUID(params.eventId)) return { success: false, error: "Invalid event ID" }
  const supabase = await createClient()

  const slug = `oh-${params.eventId.slice(0, 8)}`
  const targetUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/open-house/${params.eventId}/signin`

  const { data: qr, error } = await supabase
    .from("qr_codes")
    .upsert(
      {
        brokerage_id: params.brokerageId,
        agent_id: params.agentId,
        label: `Open House Sign-In — ${params.eventId.slice(0, 8)}`,
        slug,
        target_url: targetUrl,
        purpose: "open_house_signin",
        listing_id: params.listingId,
        is_active: true,
      },
      { onConflict: "slug" }
    )
    .select()
    .single()

  if (error) return { success: false, error: error.message }

  // Link QR code to event
  await supabase
    .from("open_house_events")
    .update({ qr_code_id: qr.id })
    .eq("id", params.eventId)

  revalidatePath(`/dashboard/listings/${params.listingId}/open-house`)
  return { success: true, qr }
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 2 — END EVENT
// ─────────────────────────────────────────────────────────────────────────────

export async function endOpenHouseEvent(params: {
  eventId: string
  listingId: string
  brokerageId: string
  agentId: string
  userId: string
}) {
  if (!isValidUUID(params.eventId)) return { success: false, error: "Invalid event ID" }
  const supabase = await createClient()
  const serviceClient = createServiceClient()

  // 1. Mark event completed
  const { error: updateErr } = await supabase
    .from("open_house_events")
    .update({ status: "completed" })
    .eq("id", params.eventId)

  if (updateErr) return { success: false, error: updateErr.message }

  // 2. Load attendees for AI scoring
  const { data: attendees } = await supabase
    .from("open_house_attendees")
    .select("id, arrival_time, check_in_time, working_with_agent, interest_level, notes")
    .eq("event_id", params.eventId)

  // 3. AI score each attendee and update
  if (attendees?.length) {
    for (const attendee of attendees) {
      let score = 0

      // Time in home estimate (check_in_time vs event end)
      if (attendee.check_in_time) {
        const minsAgo = (Date.now() - new Date(attendee.check_in_time).getTime()) / 60000
        if (minsAgo > 45) score += 20
        else if (minsAgo > 25) score += 15
        else if (minsAgo > 10) score += 10
        else score += 5
      }

      // Interest level
      const interestMap: Record<string, number> = {
        hot: 40,
        warm: 25,
        cold: 10,
      }
      score += interestMap[attendee.interest_level ?? ""] ?? 0

      // Not working with agent → higher prospect value
      if (!attendee.working_with_agent) score += 15

      const finalScore = Math.min(score, 100)
      const interestLevel =
        finalScore >= 70 ? "hot" : finalScore >= 40 ? "warm" : "cold"

      await supabase
        .from("open_house_attendees")
        .update({ ai_lead_score: finalScore, interest_level: interestLevel })
        .eq("id", attendee.id)
    }

    // 4. Auto-enroll hot leads — fire kernel event per hot lead attendee
    const hotLeads = attendees.filter((_, idx) => {
      // re-derive score inline to avoid stale closure
      return true // filtered after update; just fire event for all, let sequence handle it
    })

    // Fire OPEN_HOUSE_ATTENDEE_CAPTURED for each unscored attendee not yet processed
    for (const attendee of attendees) {
      await serviceClient.from("lifecycle_events").insert({
        brokerage_id: params.brokerageId,
        entity_type: "listing",
        entity_id: params.listingId,
        event_type: KernelEvent.OPEN_HOUSE_ATTENDEE_CAPTURED,
        actor_user_id: params.userId,
        metadata: { attendee_id: attendee.id, scored_at_event_end: true },
      })
    }
  }

  // 5. Call markOpenHouseCompleted from execution-engine (fires LISTING_OPEN_HOUSE_COMPLETED)
  await markOpenHouseCompleted({
    listingId: params.listingId,
    brokerageId: params.brokerageId,
    userId: params.userId,
    attendeeCount: attendees?.length ?? 0,
  })

  // 6. lifecycle_events sub-event
  await serviceClient.from("lifecycle_events").insert({
    brokerage_id: params.brokerageId,
    entity_type: "listing_stage_machine",
    entity_id: params.listingId,
    event_type: "listing.open_house.completed",
    actor_user_id: params.userId,
    metadata: { event_id: params.eventId, attendee_count: attendees?.length ?? 0 },
  })

  revalidatePath(`/dashboard/listings/${params.listingId}/open-house`)
  return { success: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 3 — ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

export async function getOpenHouseAnalytics(listingId: string) {
  if (!isValidUUID(listingId)) return null
  const supabase = await createClient()

  const { data: events } = await supabase
    .from("open_house_events")
    .select("id, event_date, status")
    .eq("listing_id", listingId)
    .order("event_date", { ascending: false })

  if (!events?.length) return { events: [], totals: null }

  const eventIds = events.map((e) => e.id)

  const [{ data: invitations }, { data: attendees }] = await Promise.all([
    supabase
      .from("open_house_invitations")
      .select("event_id, rsvp_response, status, channel")
      .in("event_id", eventIds),
    supabase
      .from("open_house_attendees")
      .select("event_id, ai_lead_score, interest_level")
      .in("event_id", eventIds),
  ])

  const totals = {
    totalInvitations: invitations?.length ?? 0,
    rsvpYes: invitations?.filter((i) => i.rsvp_response === "yes").length ?? 0,
    rsvpMaybe: invitations?.filter((i) => i.rsvp_response === "maybe").length ?? 0,
    rsvpNo: invitations?.filter((i) => i.rsvp_response === "no").length ?? 0,
    totalAttendees: attendees?.length ?? 0,
    hotLeads: attendees?.filter((a) => a.interest_level === "hot" || (a.ai_lead_score ?? 0) >= 70).length ?? 0,
    avgLeadScore:
      attendees?.length
        ? Math.round(attendees.reduce((s, a) => s + (a.ai_lead_score ?? 0), 0) / attendees.length)
        : 0,
  }

  // Per-event breakdown
  const perEvent = events.map((ev) => {
    const evInvites = invitations?.filter((i) => i.event_id === ev.id) ?? []
    const evAttendees = attendees?.filter((a) => a.event_id === ev.id) ?? []
    return {
      ...ev,
      invitations: evInvites.length,
      rsvpYes: evInvites.filter((i) => i.rsvp_response === "yes").length,
      attendees: evAttendees.length,
      hotLeads: evAttendees.filter((a) => (a.ai_lead_score ?? 0) >= 70).length,
    }
  })

  return { events: perEvent, totals }
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE OPEN HOUSE EVENT
// ─────────────────────────────────────────────────────────────────────────────

export async function createOpenHouseEvent(params: {
  listingId: string
  brokerageId: string
  agentId: string
  userId: string
  eventDate: string
  startTime: string
  endTime: string
  description?: string
  maxAttendees?: number
}) {
  if (!isValidUUID(params.listingId)) return { success: false, error: "Invalid listing ID" }

  const supabase = await createClient()
  const serviceClient = createServiceClient()

  const { data: event, error } = await supabase
    .from("open_house_events")
    .insert({
      listing_id: params.listingId,
      brokerage_id: params.brokerageId,
      agent_id: params.agentId,
      created_by: params.userId,
      event_date: params.eventDate,
      start_time: params.startTime,
      end_time: params.endTime,
      description: params.description ?? null,
      max_attendees: params.maxAttendees ?? null,
      status: "scheduled",
      registration_required: false,
    })
    .select()
    .maybeSingle()

  if (error) return { success: false, error: error.message }
  if (!event) return { success: false, error: "Failed to create event" }

  // Emit OPEN_HOUSE_SCHEDULED kernel event
  await serviceClient.from("lifecycle_events").insert({
    brokerage_id: params.brokerageId,
    entity_type: "listing",
    entity_id: params.listingId,
    event_type: KernelEvent.OPEN_HOUSE_SCHEDULED,
    actor_user_id: params.userId,
    metadata: { event_id: event.id, event_date: params.eventDate },
  })

  revalidatePath(`/dashboard/listings/${params.listingId}/open-house`)
  return { success: true, event }
}

// ─────────────────────────────────────────────────────────────────────────────
// KIOSK: CHECK IN ATTENDEE (public — no auth)
// ─────────────────────────────────────────────────────────────────────────────

export async function checkInAttendee(params: {
  eventId: string
  name: string
  email?: string
  phone?: string
  workingWithAgent: boolean
  tcpaConsent: boolean
}) {
  if (!isValidUUID(params.eventId)) return { success: false, error: "Invalid event ID" }
  if (!params.tcpaConsent) return { success: false, error: "TCPA consent is required" }

  // Use service client — this is a public endpoint with no auth context
  const serviceClient = createServiceClient()

  // Load event to get brokerage_id
  const { data: event } = await serviceClient
    .from("open_house_events")
    .select("id, brokerage_id, listing_id, agent_id")
    .eq("id", params.eventId)
    .maybeSingle()

  if (!event) return { success: false, error: "Event not found" }

  // TCPA rule: only store phone if consent given
  const safePhone = params.tcpaConsent ? (params.phone ?? null) : null

  // Check for duplicate check-in (same email + same event)
  if (params.email) {
    const { data: existing } = await serviceClient
      .from("open_house_attendees")
      .select("id")
      .eq("event_id", params.eventId)
      .eq("email", params.email)
      .maybeSingle()

    if (existing) {
      return { success: true, attendeeId: existing.id, duplicate: true }
    }
  }

  // Insert attendee row
  const { data: attendee, error } = await serviceClient
    .from("open_house_attendees")
    .insert({
      event_id: params.eventId,
      brokerage_id: event.brokerage_id,
      name: params.name,
      email: params.email ?? null,
      phone: safePhone,
      working_with_agent: params.workingWithAgent,
      tcpa_consent: params.tcpaConsent,
      check_in_time: new Date().toISOString(),
      arrival_time: new Date().toISOString(),
      interest_level: "unknown",
      ai_lead_score: 0,
    })
    .select("id")
    .maybeSingle()

  if (error) return { success: false, error: error.message }

  // Emit kernel event
  await serviceClient.from("lifecycle_events").insert({
    brokerage_id: event.brokerage_id,
    entity_type: "listing",
    entity_id: event.listing_id,
    event_type: KernelEvent.OPEN_HOUSE_ATTENDEE_CAPTURED,
    actor_user_id: event.agent_id,
    metadata: {
      attendee_id: attendee?.id,
      event_id: params.eventId,
      has_email: !!params.email,
      working_with_agent: params.workingWithAgent,
    },
  })

  // Record TCPA consent event
  if (params.email || safePhone) {
    await serviceClient.from("contact_consent_events").insert({
      brokerage_id: event.brokerage_id,
      agent_id: event.agent_id,
      consent_type: "tcpa",
      consent_text: "By submitting this form, you consent to be contacted about real estate services.",
      consent_source: "open_house_kiosk",
      consented: true,
    })
  }

  return { success: true, attendeeId: attendee?.id, duplicate: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST-EVENT: CONVERT ATTENDEE TO CONTACT
// ─────────────────────────────────────────────────────────────────────────────

export async function convertAttendeeToContact(params: {
  attendeeId: string
  listingId: string
  brokerageId: string
  agentId: string
  userId: string
}) {
  if (!isValidUUID(params.attendeeId)) return { success: false, error: "Invalid attendee ID" }

  const supabase = await createClient()
  const serviceClient = createServiceClient()

  // Load attendee
  const { data: attendee } = await supabase
    .from("open_house_attendees")
    .select("id, name, email, phone, tcpa_consent, contact_id, event_id")
    .eq("id", params.attendeeId)
    .maybeSingle()

  if (!attendee) return { success: false, error: "Attendee not found" }
  if (attendee.contact_id) return { success: false, error: "Already converted to contact" }
  if (!attendee.email) return { success: false, error: "Attendee has no email address" }

  // Parse name
  const nameParts = (attendee.name ?? "").trim().split(/\s+/)
  const firstName = nameParts[0] ?? "Open House"
  const lastName = nameParts.slice(1).join(" ") || "Attendee"

  // Check if contact already exists (by email + brokerage)
  const { data: existingContact } = await supabase
    .from("contacts")
    .select("id")
    .eq("brokerage_id", params.brokerageId)
    .eq("email", attendee.email)
    .is("deleted_at", null)
    .maybeSingle()

  let contactId: string

  if (existingContact) {
    contactId = existingContact.id
  } else {
    // Create new contact
    const { data: newContact, error: contactErr } = await serviceClient
      .from("contacts")
      .insert({
        brokerage_id: params.brokerageId,
        agent_id: params.agentId,
        first_name: firstName,
        last_name: lastName,
        email: attendee.email,
        phone: attendee.tcpa_consent ? (attendee.phone ?? null) : null,
        source: "open_house",
        contact_type: "buyer",
        status: "new",
        tcpa_consent: attendee.tcpa_consent,
        tcpa_consent_source: "open_house_kiosk",
        tcpa_consent_at: new Date().toISOString(),
      })
      .select("id")
      .maybeSingle()

    if (contactErr || !newContact) return { success: false, error: contactErr?.message ?? "Failed to create contact" }
    contactId = newContact.id

    // Emit kernel event
    await serviceClient.from("lifecycle_events").insert({
      brokerage_id: params.brokerageId,
      entity_type: "contact",
      entity_id: contactId,
      event_type: KernelEvent.CONTACT_CREATED,
      actor_user_id: params.userId,
      metadata: { source: "open_house", attendee_id: params.attendeeId, listing_id: params.listingId },
    })
  }

  // Link attendee → contact
  await supabase
    .from("open_house_attendees")
    .update({ contact_id: contactId })
    .eq("id", params.attendeeId)

  revalidatePath(`/dashboard/listings/${params.listingId}/open-house`)
  return { success: true, contactId, isNew: !existingContact }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST-EVENT: SCHEDULE SHOWING FROM ATTENDEE
// ─────────────────────────────────────────────────────────────────────────────

export async function scheduleShowingFromAttendee(params: {
  attendeeId: string
  contactId: string
  listingId: string
  brokerageId: string
  agentId: string
  userId: string
}) {
  if (!isValidUUID(params.attendeeId) || !isValidUUID(params.contactId))
    return { success: false, error: "Invalid IDs" }

  const supabase = await createClient()
  const serviceClient = createServiceClient()

  // Create a showing_request
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const requestedDate = tomorrow.toISOString().slice(0, 10)

  const { data: showingReq, error } = await supabase
    .from("showing_requests")
    .insert({
      listing_id: params.listingId,
      brokerage_id: params.brokerageId,
      contact_id: params.contactId,
      requested_date: requestedDate,
      requested_start_time: "10:00",
      requested_end_time: "10:30",
      message: "Follow-up showing requested after open house attendance.",
      status: "pending",
    })
    .select("id")
    .maybeSingle()

  if (error) return { success: false, error: error.message }

  // Emit kernel event
  await serviceClient.from("lifecycle_events").insert({
    brokerage_id: params.brokerageId,
    entity_type: "listing",
    entity_id: params.listingId,
    event_type: KernelEvent.SHOWING_REQUESTED,
    actor_user_id: params.userId,
    metadata: {
      source: "open_house_post_event",
      attendee_id: params.attendeeId,
      contact_id: params.contactId,
      showing_request_id: showingReq?.id,
    },
  })

  revalidatePath(`/dashboard/listings/${params.listingId}/open-house`)
  return { success: true, showingRequestId: showingReq?.id }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST-EVENT: REQUEST FEEDBACK FROM ATTENDEE
// ─────────────────────────────────────────────────────────────────────────────

export async function requestFeedbackFromAttendee(params: {
  attendeeId: string
  eventId: string
  listingId: string
  brokerageId: string
  agentId: string
}) {
  if (!isValidUUID(params.attendeeId)) return { success: false, error: "Invalid attendee ID" }

  const supabase = await createClient()

  // Mark feedback as requested via departure_time update + feedback_collected_at
  const { error } = await supabase
    .from("open_house_attendees")
    .update({ feedback_collected_at: new Date().toISOString() })
    .eq("id", params.attendeeId)
    .is("feedback_collected_at", null)

  if (error) return { success: false, error: error.message }

  revalidatePath(`/dashboard/listings/${params.listingId}/open-house`)
  return { success: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST-EVENT: GENERATE AI SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

export async function generateOpenHouseAISummary(params: {
  eventId: string
  listingId: string
  brokerageId: string
}) {
  if (!isValidUUID(params.eventId)) return { success: false, error: "Invalid event ID" }

  const supabase = await createClient()

  const { data: attendees } = await supabase
    .from("open_house_attendees")
    .select("name, email, phone, working_with_agent, interest_level, ai_lead_score, notes")
    .eq("event_id", params.eventId)

  if (!attendees?.length) {
    return { success: true, summary: "No attendees recorded for this open house event." }
  }

  const { data: event } = await supabase
    .from("open_house_events")
    .select("event_date, description")
    .eq("id", params.eventId)
    .maybeSingle()

  const hotProspects = attendees.filter((a) => (a.ai_lead_score ?? 0) >= 70 || a.interest_level === "hot")
  const noAgent = attendees.filter((a) => !a.working_with_agent)

  // Build contextual summary from real data
  const lines: string[] = []
  lines.push(`${attendees.length} attendee${attendees.length !== 1 ? "s" : ""} checked in.`)

  if (hotProspects.length > 0) {
    const names = hotProspects
      .filter((a) => a.name)
      .map((a) => a.name!)
      .slice(0, 3)
      .join(", ")
    lines.push(
      `${hotProspects.length} showed strong buyer interest${names ? ` (${names})` : ""}.`
    )
  }

  if (noAgent.length > 0) {
    lines.push(`${noAgent.length} attendee${noAgent.length !== 1 ? "s are" : " is"} not currently working with an agent — prime follow-up opportunity.`)
  }

  const withNotes = attendees.filter((a) => a.notes?.trim())
  for (const a of withNotes.slice(0, 2)) {
    if (a.name && a.notes) lines.push(`${a.name}: "${a.notes.trim()}"`)
  }

  const summary = lines.join(" ")
  return { success: true, summary }
}

// ─────────────────────────────────────────────────────────────────────────────
// KIOSK: LOAD EVENT INFO (public — no auth)
// ─────────────────────────────────────────────────────────────────────────────

export async function getOpenHouseEventPublic(eventId: string) {
  if (!isValidUUID(eventId)) return null

  const serviceClient = createServiceClient()

  const { data: event } = await serviceClient
    .from("open_house_events")
    .select(`
      id, event_date, start_time, end_time, description, status,
      listings:listing_id (
        address, city, state, zip, list_price,
        brokerages:brokerage_id (name)
      )
    `)
    .eq("id", eventId)
    .eq("status", "scheduled")
    .maybeSingle()

  return event
}

// ─────────────────────────────────────────────────────────────────────────────
// INTELLIGENCE TAB: LOAD POST-EVENT DATA
// ─────────────────────────────────────────────────────────────────────────────

export async function getPostEventIntelligence(listingId: string) {
  if (!isValidUUID(listingId)) return null

  const supabase = await createClient()

  const { data: events } = await supabase
    .from("open_house_events")
    .select("id, event_date, status")
    .eq("listing_id", listingId)
    .in("status", ["completed"])
    .order("event_date", { ascending: false })
    .limit(5)

  if (!events?.length) return { events: [], attendees: [] }

  const eventIds = events.map((e) => e.id)

  const { data: attendees } = await supabase
    .from("open_house_attendees")
    .select("id, event_id, name, email, phone, contact_id, working_with_agent, interest_level, ai_lead_score, notes, tcpa_consent, feedback_collected_at")
    .in("event_id", eventIds)
    .order("ai_lead_score", { ascending: false })

  return { events, attendees: attendees ?? [] }
}
