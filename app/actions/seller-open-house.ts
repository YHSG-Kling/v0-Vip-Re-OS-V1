"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import { markOpenHouseCompleted } from "@/app/actions/seller-listing/execution-engine"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { ingestOpenHouseAttendeeSignalAction } from "@/app/actions/lead-signal-ingest"
import { interestLevelToSignalScale } from "@/lib/lead-intelligence/interest-level"

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function isValidUUID(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

/**
 * Resolve identity from the authenticated session. Every CRM-facing action in
 * this file must call this — the previous version trusted brokerageId / agentId
 * / userId as caller-supplied params, which let any signed-in user forge writes
 * for any brokerage.
 *
 * Returns the caller's brokerage_id, user_id, and (when present) the
 * canonical agents.id for that user. agentId is null for non-agent staff
 * (admins, brokers) — callers should fall back to userId in that case.
 */
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string; agentId: string | null }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  const { data: a } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id, agentId: a?.id ?? null }
}

/** Verify a listing belongs to the caller's brokerage. */
async function verifyListingOwnership(
  listingId: string,
  brokerageId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isValidUUID(listingId)) return { ok: false, error: "Invalid listing ID" }
  const svc = createServiceClient()
  const { data: listing } = await svc
    .from("listings")
    .select("brokerage_id")
    .eq("id", listingId)
    .maybeSingle()
  if (!listing) return { ok: false, error: "Listing not found" }
  if (listing.brokerage_id !== brokerageId) return { ok: false, error: "Forbidden" }
  return { ok: true }
}

/** Verify an open-house event belongs to the caller's brokerage; returns the event. */
async function verifyEventOwnership(
  eventId: string,
  brokerageId: string
): Promise<
  | { ok: true; event: { id: string; brokerage_id: string; listing_id: string; agent_id: string | null } }
  | { ok: false; error: string }
> {
  if (!isValidUUID(eventId)) return { ok: false, error: "Invalid event ID" }
  const svc = createServiceClient()
  const { data: event } = await svc
    .from("open_house_events")
    .select("id, brokerage_id, listing_id, agent_id")
    .eq("id", eventId)
    .maybeSingle()
  if (!event) return { ok: false, error: "Event not found" }
  if (event.brokerage_id !== brokerageId) return { ok: false, error: "Forbidden" }
  return { ok: true, event }
}

// ─── LOAD PAGE DATA ───────────────────────────────────────────────────────────

export async function getOpenHouseDashboard(listingId: string) {
  if (!isValidUUID(listingId)) return null

  const auth = await requireCaller()
  if (!auth.ok) return null
  const own = await verifyListingOwnership(listingId, auth.brokerageId)
  if (!own.ok) return null

  const supabase = await createClient()

  const [{ data: listing }, { data: events }, { data: posts }] =
    await Promise.all([
      supabase
        .from("listings")
        .select("id, address, city, state, zip, brokerage_id, agent_id, go_live_date, open_house_marketing_date, open_house_event_date, list_price, lifecycle_stage")
        .eq("id", listingId)
        .maybeSingle(),
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

  const { data: realInvitations } = eventIds.length
    ? await supabase
        .from("open_house_invitations")
        .select("id, event_id, contact_id, status, channel, rsvp_response, sent_at, opened_at, clicked_at")
        .in("event_id", eventIds)
    : { data: [] }

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

// ─── TAB 1 — MARKETING: INVITE CONTACTS ──────────────────────────────────────

export async function inviteFarmContacts(params: {
  eventId: string
  listingId: string
  brokerageId?: string  // ignored — derived from session
  agentId?: string  // ignored — derived from session
  zip: string
  channel: "email" | "sms" | "both"
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const evOwn = await verifyEventOwnership(params.eventId, auth.brokerageId)
  if (!evOwn.ok) return { success: false, error: evOwn.error }

  const supabase = await createClient()

  // Load farm contacts by zip — strictly scoped to caller's brokerage
  const { data: contacts, error: contactErr } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone, dnc_status, tcpa_consent")
    .eq("brokerage_id", auth.brokerageId)
    .eq("zip_code", params.zip)
    .eq("dnc_status", false)
    .is("deleted_at", null)

  if (contactErr) return { success: false, error: contactErr.message }
  if (!contacts?.length) return { success: false, error: "No farm contacts found for this zip" }

  const channels: Array<"email" | "sms"> =
    params.channel === "both" ? ["email", "sms"] : [params.channel]

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
        brokerage_id: auth.brokerageId,
        channel: ch,
        invitation_type: "open_house",
        // STAGED, NOT SENT. This used to write status:"invited" and stamp
        // sent_at with now(), for a message that was never composed and never
        // dispatched — no cron, no dispatchEmail, no sendSMS reads this table.
        // The count then flowed into total_invites_sent on the event analytics,
        // so the fabrication propagated into reporting. The consent filtering
        // above (dnc_status, tcpa_consent) is real and stays; only the claim of
        // delivery goes.
        status: "queued",
        sent_at: null,
      }))
  )

  if (!invitationRows.length) {
    return { success: false, error: "No eligible contacts after channel/consent filtering" }
  }

  const { error: invErr } = await supabase
    .from("open_house_invitations")
    .upsert(invitationRows, { onConflict: "event_id,contact_id,channel", ignoreDuplicates: true })

  if (invErr) return { success: false, error: invErr.message }

  // THE TENANT IS THE EVENT'S, RESOLVED THROUGH THE RECORD — same rule as the
  // invitation rows above (and the worked rationale at
  // app/actions/open-house.ts:481-498). A tracking row is filed against
  // `event_id`, so it belongs to whichever brokerage owns that open house.
  // `evOwn.event.brokerage_id` is the event row's own value, read by
  // verifyEventOwnership() and already proven equal to auth.brokerageId by its
  // Forbidden guard — so this is not a live cross-tenant write, it is stamped
  // from the record so it stays correct if that guard is ever loosened.
  //
  // This upsert stamped nothing, and open_house_rsvp_tracking's RLS policy is
  // `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()` (see
  // open-house-automation.ts:695) — an untenanted row there is readable AND
  // writable by every user of every tenant. That is the concrete cost of the
  // NULLs this line was writing.
  const rsvpRows = contacts.map((contact) => ({
    event_id: params.eventId,
    contact_id: contact.id,
    brokerage_id: evOwn.event.brokerage_id,
    rsvp_status: "invited",
    source: params.channel === "email" ? "email" : "sms",
    rsvp_updated_at: new Date().toISOString(),
  }))

  const { error: rsvpErr } = await supabase
    .from("open_house_rsvp_tracking")
    .upsert(rsvpRows, { onConflict: "event_id,contact_id", ignoreDuplicates: true })

  if (rsvpErr) {
    // The invitations above landed. Say what did and did not happen rather than
    // reporting a clean success — supabase-js RESOLVES a refused write, so
    // without this check a "permission denied" was indistinguishable from a
    // successful no-op.
    console.error("[inviteFarmContacts] rsvp tracking upsert failed:", rsvpErr.message)
  }

  revalidatePath(`/dashboard/listings/${params.listingId}/open-house`)
  return { success: true, invited: invitationRows.length }
}

// ─── TAB 1 — UPDATE RSVP ─────────────────────────────────────────────────────

export async function updateRsvp(params: {
  eventId: string
  contactId: string
  listingId: string
  rsvpResponse: "yes" | "maybe" | "no"
}) {
  if (!isValidUUID(params.eventId) || !isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const evOwn = await verifyEventOwnership(params.eventId, auth.brokerageId)
  if (!evOwn.ok) return { success: false, error: evOwn.error }

  const supabase = await createClient()

  await supabase
    .from("open_house_invitations")
    .update({ rsvp_response: params.rsvpResponse, rsvp_updated_at: new Date().toISOString() })
    .eq("event_id", params.eventId)
    .eq("contact_id", params.contactId)
    .eq("brokerage_id", auth.brokerageId)

  // Tenant from the EVENT record (verifyEventOwnership above already read it and
  // refused anything outside the caller's brokerage). Without it this upsert
  // wrote a NULL-tenant tracking row that the
  // `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()` policy
  // leaves open to every tenant — and that the invitation UPDATE two statements
  // up, which narrows on .eq("brokerage_id", …), could never match.
  const { error: rsvpErr } = await supabase
    .from("open_house_rsvp_tracking")
    .upsert(
      {
        event_id: params.eventId,
        contact_id: params.contactId,
        brokerage_id: evOwn.event.brokerage_id,
        rsvp_status: params.rsvpResponse,
        rsvp_updated_at: new Date().toISOString(),
      },
      { onConflict: "event_id,contact_id" }
    )

  if (rsvpErr) {
    // Reported as a failure on purpose: the tracking row is what the dashboard
    // tallies read, so a landed invitation with no tracking row is not a
    // recorded RSVP. Both writes are idempotent on (event_id, contact_id), so
    // the retry this prompts is safe.
    return { success: false, error: `RSVP tracking not saved: ${rsvpErr.message}` }
  }

  revalidatePath(`/dashboard/listings/${params.listingId}/open-house`)
  return { success: true }
}

// ─── TAB 2 — CREATE QR CODE FOR EVENT ────────────────────────────────────────

export async function createQrCodeForEvent(params: {
  eventId: string
  listingId: string
  brokerageId?: string  // ignored — derived from session
  agentId?: string  // ignored — derived from session
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const evOwn = await verifyEventOwnership(params.eventId, auth.brokerageId)
  if (!evOwn.ok) return { success: false, error: evOwn.error }

  const supabase = await createClient()

  // MERGED-THEN-DELETED: this used to be its own `qr_codes` upsert-on-slug, using the
  // deterministic slug `oh-<eventId8>` as its idempotency. It never set destination_type, so
  // open-house scans were invisible to every destination-bucketed analytic, and an 8-character
  // slice of a uuid as a GLOBALLY UNIQUE slug is a collision waiting to happen across tenants —
  // and a collision on that upsert would have re-pointed ANOTHER brokerage's code. The write now
  // goes through the one minter with the key `open_house:<eventId>`; the slug is generated
  // per-row and stays unique. What this path contributed and kept: purpose 'open_house' (the
  // CHECK has no _signin variant) and the sign-in URL as the semantic destination.
  const { mintTrackedQr, openHouseQrLabel } = await import("@/lib/marketing/tracked-qr")
  const origin = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")
  const minted = await mintTrackedQr({
    brokerageId:     auth.brokerageId,
    agentId:         evOwn.event.agent_id ?? auth.agentId,
    label:           openHouseQrLabel(params.eventId),
    destinationType: "book_meeting",
    targetUrl:       `${origin}/open-house/${params.eventId}/signin`,
    listingId:       params.listingId,
    purpose:         "open_house",
    origin:          origin || undefined,
  })

  if (!minted) return { success: false, error: "The QR code was not created — the write was refused." }

  const { error: linkError } = await supabase
    .from("open_house_events")
    .update({ qr_code_id: minted.qrCodeId })
    .eq("id", params.eventId)
    .eq("brokerage_id", auth.brokerageId)

  // The event's qr_code_id is what the sign-in surface reads to find the code; a minted code the
  // event cannot point at is not a usable QR, so this refusal is reported, not swallowed.
  if (linkError) return { success: false, error: `QR code created but not attached to the event: ${linkError.message}` }

  revalidatePath(`/dashboard/listings/${params.listingId}/open-house`)
  return {
    success: true,
    qr: {
      id: minted.qrCodeId,
      slug: minted.slug,
      target_url: minted.targetUrl,
      scan_url: minted.scanUrl,
      image_url: minted.qrCodeDataUrl,
      purpose: "open_house",
      listing_id: params.listingId,
    },
  }
}

// ─── TAB 2 — END EVENT ───────────────────────────────────────────────────────

export async function endOpenHouseEvent(params: {
  eventId: string
  listingId: string
  brokerageId?: string  // ignored — derived from session
  agentId?: string  // ignored — derived from session
  userId?: string  // ignored — derived from session
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const evOwn = await verifyEventOwnership(params.eventId, auth.brokerageId)
  if (!evOwn.ok) return { success: false, error: evOwn.error }

  const supabase = await createClient()
  const serviceClient = createServiceClient()

  const { error: updateErr } = await supabase
    .from("open_house_events")
    .update({ status: "completed" })
    .eq("id", params.eventId)
    .eq("brokerage_id", auth.brokerageId)

  if (updateErr) return { success: false, error: updateErr.message }

  // THE READER THAT DECIDES WHETHER AN ATTENDEE EXISTS AT ALL — it drives the
  // scoring loop below and the OPEN_HOUSE_ATTENDEE_CAPTURED events after it.
  // supabase-js RESOLVES a refused query, so `const { data: attendees }` alone
  // read a refusal as "nobody came": the event closed, every attendee went
  // unscored, no capture event fired, and the action returned success. This is
  // also the equality that makes an UNSTAMPED attendee invisible — `NULL =
  // <uuid>` is never true — so the two failure modes were indistinguishable here.
  const { data: attendees, error: attendeesError } = await supabase
    .from("open_house_attendees")
    .select("id, arrival_time, check_in_time, working_with_agent, interest_level, notes")
    .eq("event_id", params.eventId)
    .eq("brokerage_id", auth.brokerageId)

  if (attendeesError) {
    return { success: false, error: `Could not read this event's attendees: ${attendeesError.message}` }
  }

  if (attendees?.length) {
    for (const attendee of attendees) {
      let score = 0

      if (attendee.check_in_time) {
        const minsAgo = (Date.now() - new Date(attendee.check_in_time).getTime()) / 60000
        if (minsAgo > 45) score += 20
        else if (minsAgo > 25) score += 15
        else if (minsAgo > 10) score += 10
        else score += 5
      }

      const interestMap: Record<string, number> = {
        hot: 40,
        warm: 25,
        cold: 10,
      }
      score += interestMap[attendee.interest_level ?? ""] ?? 0

      if (!attendee.working_with_agent) score += 15

      const finalScore = Math.min(score, 100)
      const interestLevel =
        finalScore >= 70 ? "hot" : finalScore >= 40 ? "warm" : "cold"

      await supabase
        .from("open_house_attendees")
        .update({ ai_lead_score: finalScore, interest_level: interestLevel })
        .eq("id", attendee.id)
        .eq("brokerage_id", auth.brokerageId)
    }

    // Fire OPEN_HOUSE_ATTENDEE_CAPTURED for each scored attendee — session-derived identity
    for (const attendee of attendees) {
      await serviceClient.from("lifecycle_events").insert({
        brokerage_id: auth.brokerageId,
        entity_type: "listing",
        entity_id: params.listingId,
        event_type: KernelEvent.OPEN_HOUSE_ATTENDEE_CAPTURED,
        actor_user_id: auth.userId,
        metadata: { attendee_id: attendee.id, scored_at_event_end: true },
      })
    }
  }

  await markOpenHouseCompleted({
    listingId: params.listingId,
    brokerageId: auth.brokerageId,
    userId: auth.userId,
    attendeeCount: attendees?.length ?? 0,
  })

  await serviceClient.from("lifecycle_events").insert({
    brokerage_id: auth.brokerageId,
    entity_type: "listing_stage_machine",
    entity_id: params.listingId,
    event_type: "listing.open_house.completed",
    actor_user_id: auth.userId,
    metadata: { event_id: params.eventId, attendee_count: attendees?.length ?? 0 },
  })

  revalidatePath(`/dashboard/listings/${params.listingId}/open-house`)
  return { success: true }
}

// ─── TAB 3 — ANALYTICS ───────────────────────────────────────────────────────

export async function getOpenHouseAnalytics(listingId: string) {
  if (!isValidUUID(listingId)) return null

  const auth = await requireCaller()
  if (!auth.ok) return null
  const own = await verifyListingOwnership(listingId, auth.brokerageId)
  if (!own.ok) return null

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

// ─── CREATE OPEN HOUSE EVENT ─────────────────────────────────────────────────

export async function createOpenHouseEvent(params: {
  listingId: string
  brokerageId?: string  // ignored — derived from session
  agentId?: string  // ignored — derived from session
  userId?: string  // ignored — derived from session
  eventDate: string
  startTime: string
  endTime: string
  description?: string
  maxAttendees?: number
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const own = await verifyListingOwnership(params.listingId, auth.brokerageId)
  if (!own.ok) return { success: false, error: own.error }

  const serviceClient = createServiceClient()

  const { data: event, error } = await serviceClient
    .from("open_house_events")
    .insert({
      listing_id: params.listingId,
      brokerage_id: auth.brokerageId,
      // NOT `?? auth.userId` (m361). open_house_events.agent_id FKs agents
      // (verified live), so the substitution was FK-rejected and the open house
      // was never created. created_by on the next line is the users id and is
      // correct — the row wants BOTH classes, which is precisely why one of
      // them must not be a guess.
      agent_id: auth.agentId,
      created_by: auth.userId,
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

  await serviceClient.from("lifecycle_events").insert({
    brokerage_id: auth.brokerageId,
    entity_type: "listing",
    entity_id: params.listingId,
    event_type: KernelEvent.OPEN_HOUSE_SCHEDULED,
    actor_user_id: auth.userId,
    metadata: { event_id: event.id, event_date: params.eventDate },
  })

  // Portal fan-out: the seller sees "Open house scheduled" on their portal.
  const { data: ohListing } = await serviceClient
    .from("listings")
    .select("seller_contact_id")
    .eq("id", params.listingId)
    .maybeSingle()
  const { fanOutKernelEvent } = await import("@/lib/kernel/event-fanout")
  await fanOutKernelEvent({
    event:           KernelEvent.OPEN_HOUSE_SCHEDULED,
    brokerageId:     auth.brokerageId,
    entityType:      "listing",
    entityId:        params.listingId,
    sellerContactId: ohListing?.seller_contact_id ?? undefined,
    listingId:       params.listingId,
    agentUserId:     auth.userId,
    metadata:        { event_id: event.id, event_date: params.eventDate },
  }).catch(() => {})

  revalidatePath(`/dashboard/listings/${params.listingId}/open-house`)
  return { success: true, event }
}

// ─── KIOSK: CHECK IN ATTENDEE (public — no auth, scoped via eventId lookup) ──

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

  // Public kiosk endpoint — no caller auth. Brokerage is derived from the
  // event itself, so an attacker can only create attendees against an event
  // they know the UUID of (and only stamps the attendee with that event's
  // brokerage). They cannot forge cross-tenant data.
  const serviceClient = createServiceClient()

  const { data: event } = await serviceClient
    .from("open_house_events")
    .select("id, brokerage_id, listing_id, agent_id, status")
    .eq("id", params.eventId)
    .maybeSingle()

  if (!event) return { success: false, error: "Event not found" }
  if (event.status === "completed" || event.status === "cancelled") {
    return { success: false, error: "Event is not accepting check-ins" }
  }

  const safePhone = params.tcpaConsent ? (params.phone ?? null) : null

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
      // interest_level is NULLABLE and has no 'unknown' — at sign-in we have
      // not assessed them yet, and NULL already says exactly that.
      ai_lead_score: 0,
    })
    .select("id")
    .maybeSingle()

  if (error) return { success: false, error: error.message }

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

// ─── POST-EVENT: CONVERT ATTENDEE TO CONTACT ─────────────────────────────────

export async function convertAttendeeToContact(params: {
  attendeeId: string
  listingId: string
  brokerageId?: string  // ignored — derived from session
  agentId?: string  // ignored — derived from session
  userId?: string  // ignored — derived from session
}) {
  if (!isValidUUID(params.attendeeId)) return { success: false, error: "Invalid attendee ID" }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()
  const serviceClient = createServiceClient()

  const { data: attendee } = await supabase
    .from("open_house_attendees")
    .select("id, name, email, phone, tcpa_consent, contact_id, event_id, brokerage_id, interest_level")
    .eq("id", params.attendeeId)
    .maybeSingle()

  if (!attendee) return { success: false, error: "Attendee not found" }
  if (attendee.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden" }
  if (attendee.contact_id) return { success: false, error: "Already converted to contact" }
  if (!attendee.email) return { success: false, error: "Attendee has no email address" }

  const nameParts = (attendee.name ?? "").trim().split(/\s+/)
  const firstName = nameParts[0] ?? "Open House"
  const lastName = nameParts.slice(1).join(" ") || "Attendee"

  const { data: existingContact } = await supabase
    .from("contacts")
    .select("id")
    .eq("brokerage_id", auth.brokerageId)
    .eq("email", attendee.email)
    .is("deleted_at", null)
    .maybeSingle()

  let contactId: string

  if (existingContact) {
    contactId = existingContact.id
  } else {
    const { data: newContact, error: contactErr } = await serviceClient
      .from("contacts")
      .insert({
        brokerage_id: auth.brokerageId,
        agent_id: auth.agentId,
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

    await serviceClient.from("lifecycle_events").insert({
      brokerage_id: auth.brokerageId,
      entity_type: "contact",
      entity_id: contactId,
      event_type: KernelEvent.CONTACT_CREATED,
      actor_user_id: auth.userId,
      metadata: { source: "open_house", attendee_id: params.attendeeId, listing_id: params.listingId },
    })
  }

  await supabase
    .from("open_house_attendees")
    .update({ contact_id: contactId })
    .eq("id", params.attendeeId)
    .eq("brokerage_id", auth.brokerageId)

  // Record a behavioral lead-intelligence signal: an open-house attendee just
  // became a tracked contact. Pushes engagement/intent/overall scores UP and
  // is idempotent per (contact, source, day) — never blocks the conversion.
  await ingestOpenHouseAttendeeSignalAction({
    contactId,
    attendeeId: params.attendeeId,
    listingId: params.listingId,
    interestLevel: interestLevelToSignalScale(attendee.interest_level),
  }).catch(() => {})

  revalidatePath(`/dashboard/listings/${params.listingId}/open-house`)
  return { success: true, contactId, isNew: !existingContact }
}

// ─── POST-EVENT: SCHEDULE SHOWING FROM ATTENDEE ──────────────────────────────

export async function scheduleShowingFromAttendee(params: {
  attendeeId: string
  contactId: string
  listingId: string
  brokerageId?: string  // ignored — derived from session
  agentId?: string  // ignored — derived from session
  userId?: string  // ignored — derived from session
}) {
  if (!isValidUUID(params.attendeeId) || !isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  // Verify both the contact and the listing belong to caller's brokerage
  const supabase = await createClient()
  const { data: contact } = await supabase
    .from("contacts")
    .select("brokerage_id")
    .eq("id", params.contactId)
    .maybeSingle()
  if (!contact || contact.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }
  const lstOwn = await verifyListingOwnership(params.listingId, auth.brokerageId)
  if (!lstOwn.ok) return { success: false, error: lstOwn.error }

  const serviceClient = createServiceClient()

  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const requestedDate = tomorrow.toISOString().slice(0, 10)

  const { data: showingReq, error } = await supabase
    .from("showing_requests")
    .insert({
      listing_id: params.listingId,
      brokerage_id: auth.brokerageId,
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

  await serviceClient.from("lifecycle_events").insert({
    brokerage_id: auth.brokerageId,
    entity_type: "listing",
    entity_id: params.listingId,
    event_type: KernelEvent.SHOWING_REQUESTED,
    actor_user_id: auth.userId,
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

// ─── POST-EVENT: REQUEST FEEDBACK FROM ATTENDEE ──────────────────────────────

/**
 * Ask one open-house attendee for their feedback.
 *
 * WHAT THIS USED TO DO, AND WHY IT COULD NOT BE WIRED AS WRITTEN. It sent
 * nothing. It stamped `open_house_attendees.feedback_collected_at = now()` and
 * returned success — recording that feedback had been COLLECTED at the moment
 * it was merely REQUESTED, for a request that was never composed or dispatched.
 * That column has a real writer already (open-house-automation.ts:submitFeedback,
 * which stamps it alongside the rating and comments the visitor actually gave),
 * and two screens read it as truth: this listing's post-event panel filters
 * "awaiting feedback" on `!feedback_collected_at`, so every attendee asked would
 * have vanished from the follow-up list having said nothing at all.
 *
 * MERGE, not deletion. The named rival that really sends is
 * app/actions/open-house-automation.ts:sendFeedbackRequestToAttendee — it builds
 * the feedback URL and calls sendFeedbackRequest, and it reads that sender's
 * verdict instead of assuming delivery. The one thing it does NOT do is bound
 * the tenant: it resolves the attendee through the RLS client, and the live
 * policy on open_house_attendees is `brokerage_id IS NULL OR brokerage_id =
 * current_user_brokerage_id()`, so an attendee row whose brokerage_id was never
 * stamped is visible to EVERY brokerage. That check is the capability this
 * function has and the rival lacks, so it is what survives here: the ownership
 * proof is done first, against the true stored tenant read through the service
 * client, and an untenanted row is refused outright rather than silently
 * accepted. Delivery is then delegated to the sender that exists. Nothing
 * writes a timestamp claiming feedback that has not arrived.
 */
export async function requestFeedbackFromAttendee(params: {
  attendeeId: string
  listingId: string
}) {
  if (!isValidUUID(params.attendeeId)) return { success: false, error: "Invalid attendee ID" }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  // Read the STORED tenant through the service client. Reading it through RLS
  // would hand back an untenanted row without saying so, which is the whole
  // hole this check exists to close.
  const svc = createServiceClient()
  const { data: attendee, error: readErr } = await svc
    .from("open_house_attendees")
    .select("id, brokerage_id, contact_id, feedback_collected_at")
    .eq("id", params.attendeeId)
    .maybeSingle()

  if (readErr) return { success: false, error: readErr.message }
  if (!attendee) return { success: false, error: "Attendee not found" }
  if (!attendee.brokerage_id) {
    return {
      success: false,
      error: "This attendee record has no brokerage on it — it cannot be shown to belong to you",
    }
  }
  if (attendee.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden" }

  if (attendee.feedback_collected_at) {
    return { success: false, error: "This attendee has already given feedback" }
  }

  // Delegate delivery to the sender that actually sends, and return ITS verdict.
  const { sendFeedbackRequestToAttendee } = await import("@/app/actions/open-house-automation")
  const sent = await sendFeedbackRequestToAttendee(params.attendeeId)
  if (!sent.success) {
    return { success: false, error: sent.error ?? "The feedback request was not delivered" }
  }

  revalidatePath(`/dashboard/listings/${params.listingId}/open-house`)
  return { success: true, feedbackUrl: sent.feedbackUrl ?? null }
}

// ─── POST-EVENT: GENERATE AI SUMMARY ─────────────────────────────────────────

/**
 * A debrief of who actually walked through the door.
 *
 * This reads open_house_attendees — the table endOpenHouseEvent's scoring pass
 * writes — so it can speak for any completed event. Its neighbour
 * open-house-automation.ts:generatePerformanceInsights reads
 * open_house_analytics instead, and the only writer of that table is
 * open-house-automation.ts:createOpenHouseEvent, which is NOT the create path
 * the open-house screen uses (that is seller-open-house.ts:createOpenHouseEvent,
 * eighty lines above). Events made through the product therefore have no
 * analytics row and the AI insights card answers "Analytics data not found"
 * forever. These two are not duplicates: one summarises visitors, the other
 * grades a row that does not exist yet.
 *
 * The select is narrowed to the fields the summary actually says out loud —
 * email and phone were being read and never used, which is PII fetched for
 * nothing.
 */
export async function generateOpenHouseAISummary(params: { eventId: string }) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const evOwn = await verifyEventOwnership(params.eventId, auth.brokerageId)
  if (!evOwn.ok) return { success: false, error: evOwn.error }

  const supabase = await createClient()

  const { data: attendees, error: attendeeErr } = await supabase
    .from("open_house_attendees")
    .select("name, working_with_agent, interest_level, ai_lead_score, notes")
    .eq("event_id", params.eventId)
    .eq("brokerage_id", auth.brokerageId)

  // A refused read is not an empty open house. `data ?? []` would have rendered
  // an RLS denial as "nobody came".
  if (attendeeErr) {
    return { success: false, error: `Could not read the attendee list: ${attendeeErr.message}` }
  }

  if (!attendees?.length) {
    return { success: true, summary: "No attendees recorded for this open house event." }
  }

  const hotProspects = attendees.filter((a) => (a.ai_lead_score ?? 0) >= 70 || a.interest_level === "hot")
  const noAgent = attendees.filter((a) => !a.working_with_agent)

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

// ─── KIOSK: LOAD EVENT INFO (public — no auth) ───────────────────────────────

/**
 * THE ONLY UNAUTHENTICATED READER IN THIS FILE.
 *
 * It is reached from /open-house/[eventId]/signin, a tablet on a hall table
 * that anyone at the event can pick up, and it runs on the SERVICE client, so
 * RLS is not a second line of defence — whatever this returns is public. Every
 * field below is something a stranger standing in the doorway can already see,
 * and everything else is deliberately absent:
 *
 *   NOT returned: listing_id, brokerage_id, agent_id, the agent's users.id or
 *   email, list_price, max_attendees, the event's internal notes, and anything
 *   at all about other attendees. The page this replaces handed its client
 *   component the raw listing row (brokerage_id and agent_id included) plus the
 *   agent's id and email address — all of which are serialised into the public
 *   HTML payload.
 *
 * STATUS. The old filter was `.eq("status", "scheduled")`. open_house_events'
 * live CHECK constraint is scheduled | marketing | active | completed |
 * cancelled — so the moment an event went 'active', which is what it is DURING
 * the open house, this returned null and the sign-in kiosk 404'd at exactly the
 * hour it exists for. The three states below are the ones checkInAttendee will
 * still accept a check-in for; completed and cancelled are refused by both,
 * which is why they match.
 *
 * IDENTITY CLASSES. open_house_events.agent_id FKs agents(id) — verified live.
 * The page looked that value up in `users` by id: an agents.id used in the
 * users.id space, matching nothing, so no agent name has ever appeared on the
 * kiosk. Resolving agents -> agents.user_id -> users is the fix; no `??`
 * bridges the two spaces.
 */
export async function getOpenHouseEventPublic(eventId: string): Promise<{
  eventId: string
  eventDate: string
  startTime: string | null
  endTime: string | null
  listing: { address: string; city: string | null; state: string | null } | null
  brokerageName: string | null
  branding: { appName: string | null; logoUrl: string | null; primaryColor: string | null } | null
  agent: { displayName: string | null; photoUrl: string | null } | null
} | null> {
  if (!isValidUUID(eventId)) return null

  const serviceClient = createServiceClient()

  // ONE string literal — a select built by concatenation loses supabase-js's
  // row inference and degrades every field access to GenericStringError.
  const { data: event, error: eventErr } = await serviceClient
    .from("open_house_events")
    .select(
      "id, event_date, start_time, end_time, status, brokerage_id, agent_id, listings:listing_id (address, city, state, brokerages:brokerage_id (name))"
    )
    .eq("id", eventId)
    .in("status", ["scheduled", "marketing", "active"])
    .maybeSingle()

  if (eventErr || !event) return null

  const listingRow = (event.listings ?? null) as unknown as
    | { address: string | null; city: string | null; state: string | null; brokerages?: { name: string | null } | null }
    | null

  // Agent display identity: agents.id -> agents.user_id -> users. Name and photo
  // only; the ids and the email stay on the server.
  let agent: { displayName: string | null; photoUrl: string | null } | null = null
  if (event.agent_id) {
    const { data: agentRow } = await serviceClient
      .from("agents")
      .select("user_id, photo_url")
      .eq("id", event.agent_id)
      .maybeSingle()

    if (agentRow?.user_id) {
      const { data: userRow } = await serviceClient
        .from("users")
        .select("first_name, last_name")
        .eq("id", agentRow.user_id)
        .maybeSingle()

      const displayName =
        [userRow?.first_name, userRow?.last_name].filter(Boolean).join(" ") || null
      agent = { displayName, photoUrl: agentRow.photo_url ?? null }
    }
  }

  // Brokerage branding, scoped to THIS event's brokerage — never "the first
  // settings row in the table".
  let branding: { appName: string | null; logoUrl: string | null; primaryColor: string | null } | null = null
  if (event.brokerage_id) {
    const { data: settings } = await serviceClient
      .from("global_settings")
      .select("app_name, app_logo_url, primary_color")
      .eq("brokerage_id", event.brokerage_id)
      .maybeSingle()

    if (settings) {
      branding = {
        appName: settings.app_name ?? null,
        logoUrl: settings.app_logo_url ?? null,
        primaryColor: settings.primary_color ?? null,
      }
    }
  }

  return {
    eventId: event.id,
    eventDate: event.event_date,
    startTime: event.start_time ?? null,
    endTime: event.end_time ?? null,
    listing: listingRow?.address
      ? { address: listingRow.address, city: listingRow.city ?? null, state: listingRow.state ?? null }
      : null,
    brokerageName: listingRow?.brokerages?.name ?? null,
    branding,
    agent,
  }
}

// ─── INTELLIGENCE TAB: LOAD POST-EVENT DATA ──────────────────────────────────

export async function getPostEventIntelligence(listingId: string) {
  if (!isValidUUID(listingId)) return null

  const auth = await requireCaller()
  if (!auth.ok) return null
  const own = await verifyListingOwnership(listingId, auth.brokerageId)
  if (!own.ok) return null

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
