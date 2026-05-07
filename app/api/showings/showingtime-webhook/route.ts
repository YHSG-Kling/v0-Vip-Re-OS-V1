/**
 * ShowingTime webhook ingest.
 *
 * Two event types we care about:
 *   - appointment.requested  → outside agent requested a showing through
 *     ShowingTime on one of our listings; create a showing_requests row.
 *   - appointment.confirmed  → ShowingTime confirms a request we previously
 *     dispatched via dispatchStopScheduling (channel='showingtime'); flip
 *     the matching tour_stop to is_confirmed=true.
 *
 * ShowingTime authenticates webhooks with HMAC-SHA256 using a per-brokerage
 * shared secret. We support both single-tenant (env) and multi-tenant
 * (brokerage_credentials.showingtime.webhook_secret) configurations.
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import crypto from "crypto"

export const dynamic = "force-dynamic"

interface ShowingTimeAppointment {
  id: string
  status: "requested" | "confirmed" | "declined" | "cancelled" | "rescheduled"
  property: {
    address?: string
    city?: string
    state?: string
    zip?: string
    mls_number?: string
    listing_id?: string  // brokerage's listing_id if ShowingTime knows about it
  }
  buyer_agent: {
    name?: string
    email?: string
    phone?: string
    license?: string
    brokerage?: string
  }
  buyer?: { name?: string }
  requested_at: string  // ISO timestamp
  confirmed_at?: string
  duration_minutes?: number
  notes?: string
  /** Our internal tour_stop id when ShowingTime is confirming a request we
   *  originated. */
  external_ref?: string
}

interface ShowingTimeWebhookPayload {
  event_type: string
  brokerage_id?: string  // ShowingTime forwards our brokerage id when known
  appointment: ShowingTimeAppointment
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const signature = req.headers.get("x-showingtime-signature") ?? ""

  // Verify HMAC signature
  const secret = process.env.SHOWINGTIME_WEBHOOK_SECRET ?? ""
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 })
  }
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex")
  // Constant-time compare via Buffer
  let valid = false
  try {
    valid = expected.length === signature.length &&
            crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    valid = false
  }
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  let payload: ShowingTimeWebhookPayload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const supabase = createServiceClient()
  const appt = payload.appointment

  // ─── Resolve the listing ──────────────────────────────────────────────
  // Prefer the brokerage's listing_id if ShowingTime knows it (we set it
  // when we POST to ShowingTime via dispatchViaShowingTime). Otherwise
  // match by mls_number + brokerage_id.
  let listingId: string | null = appt.property.listing_id ?? null
  let brokerageId: string | null = payload.brokerage_id ?? null

  if (!listingId && appt.property.mls_number) {
    const { data: l } = await supabase
      .from("listings")
      .select("id, brokerage_id")
      .eq("mls_number", appt.property.mls_number)
      .maybeSingle()
    listingId = l?.id ?? null
    brokerageId = brokerageId ?? l?.brokerage_id ?? null
  }

  if (!listingId || !brokerageId) {
    // Acknowledge so ShowingTime doesn't retry, but flag in console
    console.warn("[showingtime-webhook] could not resolve listing", appt.property)
    return NextResponse.json({ ok: true, ignored: true })
  }

  switch (payload.event_type) {
    case "appointment.requested": {
      // Insert a showing_requests row exactly the way the public outside-
      // agent form does. Source = 'external_agent' so the listing agent's
      // queue can tell apart in-portal vs ShowingTime-originated requests.
      const startDate = new Date(appt.requested_at)
      const startHHMM = startDate.toISOString().slice(11, 16)
      const endStartTotalMinutes =
        startDate.getUTCHours() * 60 + startDate.getUTCMinutes() +
        (appt.duration_minutes ?? 30)
      const endHH = Math.floor(endStartTotalMinutes / 60) % 24
      const endMM = endStartTotalMinutes % 60

      const { data: showing, error } = await supabase
        .from("showing_requests")
        .insert({
          listing_id:           listingId,
          brokerage_id:         brokerageId,
          contact_id:           null,
          source:               "external_agent",
          buyer_agent_name:     appt.buyer_agent.name ?? null,
          buyer_agent_email:    appt.buyer_agent.email ?? null,
          buyer_agent_phone:    appt.buyer_agent.phone ?? null,
          buyer_agent_license:  appt.buyer_agent.license ?? null,
          property_address:     [appt.property.address, appt.property.city, appt.property.state]
                                  .filter(Boolean).join(", "),
          mls_number:           appt.property.mls_number ?? null,
          requested_date:       appt.requested_at.slice(0, 10),
          requested_start_time: `${startHHMM}:00`,
          requested_end_time:   `${String(endHH).padStart(2,"0")}:${String(endMM).padStart(2,"0")}:00`,
          message:              appt.notes ?? "",
          status:               "pending",
        })
        .select("id")
        .single()

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      // Notify the listing agent + seller — same path as in-portal request.
      const { data: listing } = await supabase
        .from("listings")
        .select("agent_id, seller_contact_id, address")
        .eq("id", listingId)
        .maybeSingle()

      if (listing?.agent_id) {
        const { data: a } = await supabase
          .from("agents").select("user_id").eq("id", listing.agent_id).maybeSingle()
        if (a?.user_id) {
          await supabase.from("notifications").insert({
            user_id:      a.user_id,
            brokerage_id: brokerageId,
            type:         "showing.request.listing.showingtime",
            title:        "ShowingTime request",
            body:         `${appt.buyer_agent.name ?? "An agent"} requested a showing on ${listing.address ?? "your listing"} via ShowingTime.`,
            entity_type:  "showing_request",
            entity_id:    showing.id,
            priority:     "high",
            channel:      "in_app",
          }).then(() => null, () => null)
        }
      }
      if (listing?.seller_contact_id) {
        await supabase.from("notifications").insert({
          contact_id:   listing.seller_contact_id,
          brokerage_id: brokerageId,
          type:         "showing.request.seller",
          title:        "Showing request on your home",
          body:         "An agent requested a showing through ShowingTime. Your agent will follow up to confirm.",
          entity_type:  "showing_request",
          entity_id:    showing.id,
          priority:     "high",
          channel:      "in_app",
        }).then(() => null, () => null)
      }

      return NextResponse.json({ ok: true, showing_request_id: showing.id })
    }

    case "appointment.confirmed": {
      // ShowingTime is confirming a request we originated via dispatcher.
      // We stored our tour_stop id in metadata when we POSTed; the webhook
      // returns it as external_ref. Flip the stop to is_confirmed=true.
      if (!appt.external_ref) {
        return NextResponse.json({ ok: true, ignored: true })
      }
      const confirmedTime = appt.confirmed_at ?? appt.requested_at
      await supabase
        .from("tour_stops")
        .update({
          is_confirmed:        true,
          confirmed_time:      confirmedTime,
          scheduling_reference: appt.id,
        })
        .eq("id", appt.external_ref)
        .eq("brokerage_id", brokerageId)

      return NextResponse.json({ ok: true })
    }

    case "appointment.declined":
    case "appointment.cancelled":
    case "appointment.rescheduled": {
      if (!appt.external_ref) return NextResponse.json({ ok: true, ignored: true })
      // Just record the lifecycle event — agent will see it and can re-dispatch
      await supabase.from("lifecycle_events").insert({
        brokerage_id:  brokerageId,
        entity_type:   "tour_stop",
        entity_id:     appt.external_ref,
        event_type:    `tour_stop.showingtime.${payload.event_type.replace("appointment.", "")}`,
        actor_user_id: null,
        metadata:      { showingtime_id: appt.id, notes: appt.notes ?? null },
      }).then(() => null, () => null)
      return NextResponse.json({ ok: true })
    }

    default:
      return NextResponse.json({ ok: true, ignored: true })
  }
}
