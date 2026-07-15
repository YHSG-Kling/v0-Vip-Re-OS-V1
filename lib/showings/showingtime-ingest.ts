// lib/showings/showingtime-ingest.ts
//
// ShowingTime appointment.requested → showing_requests, ONE path for the
// webhook AND the ingress reconciler (the two can never drift). The webhook
// previously acknowledged an unresolvable listing with 200 ignored:true — a
// buyer's agent requested a showing on OUR listing and the request
// evaporated (classic race: the listing row hasn't carried its mls_number
// yet when ShowingTime fires). Now the route parks it and this module
// replays it the moment the listing resolves. Idempotent: an identical
// pending request (same listing + date + start + requesting agent) is
// recognized, never duplicated — which also de-dupes ShowingTime's own
// webhook retries.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export interface ShowingTimeApptPayload {
  id: string
  property: { address?: string; city?: string; state?: string; mls_number?: string; listing_id?: string }
  buyer_agent: { name?: string; email?: string; phone?: string; license?: string }
  requested_at: string
  duration_minutes?: number
  notes?: string
}

/** Resolve the listing (and its brokerage) the appointment belongs to. */
export async function resolveShowingTimeListing(svc: Svc, input: {
  listingId?: string | null
  mlsNumber?: string | null
  brokerageId?: string | null
}): Promise<{ listingId: string; brokerageId: string } | null> {
  if (input.listingId && input.brokerageId) return { listingId: input.listingId, brokerageId: input.brokerageId }
  if (input.mlsNumber) {
    const { data: l } = await svc.from("listings")
      .select("id, brokerage_id").eq("mls_number", input.mlsNumber).maybeSingle()
    if ((l as any)?.id && ((l as any).brokerage_id ?? input.brokerageId)) {
      return { listingId: (l as any).id, brokerageId: (l as any).brokerage_id ?? input.brokerageId }
    }
  }
  return null
}

/** PURE: the request's time window from the appointment facts. */
export function showingTimeWindow(requestedAtIso: string, durationMinutes?: number): { date: string; start: string; end: string } {
  const startDate = new Date(requestedAtIso)
  const startHHMM = startDate.toISOString().slice(11, 16)
  const endTotal = startDate.getUTCHours() * 60 + startDate.getUTCMinutes() + (durationMinutes ?? 30)
  const endHH = Math.floor(endTotal / 60) % 24
  const endMM = endTotal % 60
  return {
    date: requestedAtIso.slice(0, 10),
    start: `${startHHMM}:00`,
    end: `${String(endHH).padStart(2, "0")}:${String(endMM).padStart(2, "0")}:00`,
  }
}

/**
 * Create the showing_requests row + notify listing agent and seller — the
 * exact rail the webhook ran inline before. Idempotent on (listing, date,
 * start, requesting agent email/name).
 */
export async function ingestShowingTimeRequest(svc: Svc, input: {
  appt: ShowingTimeApptPayload
  listingId: string
  brokerageId: string
}): Promise<{ ok: boolean; showingRequestId?: string; deduped?: boolean }> {
  const { appt, listingId, brokerageId } = input
  const win = showingTimeWindow(appt.requested_at, appt.duration_minutes)

  // Idempotence: the same appointment replayed (or redelivered) must not
  // double-book the agent's queue.
  let dupQ = svc.from("showing_requests").select("id")
    .eq("listing_id", listingId).eq("requested_date", win.date).eq("requested_start_time", win.start)
    .eq("source", "external_agent").limit(1)
  dupQ = appt.buyer_agent.email
    ? dupQ.eq("buyer_agent_email", appt.buyer_agent.email)
    : dupQ.eq("buyer_agent_name", appt.buyer_agent.name ?? "")
  const { data: dup } = await dupQ.maybeSingle()
  if (dup) return { ok: true, showingRequestId: (dup as any).id, deduped: true }

  const { data: showing, error } = await svc.from("showing_requests").insert({
    listing_id:           listingId,
    brokerage_id:         brokerageId,
    contact_id:           null,
    source:               "external_agent",
    buyer_agent_name:     appt.buyer_agent.name ?? null,
    buyer_agent_email:    appt.buyer_agent.email ?? null,
    buyer_agent_phone:    appt.buyer_agent.phone ?? null,
    buyer_agent_license:  appt.buyer_agent.license ?? null,
    property_address:     [appt.property.address, appt.property.city, appt.property.state].filter(Boolean).join(", "),
    mls_number:           appt.property.mls_number ?? null,
    requested_date:       win.date,
    requested_start_time: win.start,
    requested_end_time:   win.end,
    message:              appt.notes ?? "",
    status:               "pending",
  }).select("id").single()
  if (error || !showing) return { ok: false }

  // Notify the listing agent + seller — same path as in-portal requests.
  const { data: listing } = await svc.from("listings")
    .select("agent_id, seller_contact_id, address").eq("id", listingId).maybeSingle()
  if ((listing as any)?.agent_id) {
    const { data: a } = await svc.from("agents").select("user_id").eq("id", (listing as any).agent_id).maybeSingle()
    if ((a as any)?.user_id) {
      await svc.from("notifications").insert({
        user_id:      (a as any).user_id,
        brokerage_id: brokerageId,
        type:         "showing.request.listing.showingtime",
        title:        "ShowingTime request",
        body:         `${appt.buyer_agent.name ?? "An agent"} requested a showing on ${(listing as any).address ?? "your listing"} via ShowingTime.`,
        entity_type:  "showing_request",
        entity_id:    (showing as any).id,
        priority:     "high",
        channel:      "in_app",
      }).then(() => null, () => null)
    }
  }
  if ((listing as any)?.seller_contact_id) {
    await svc.from("notifications").insert({
      contact_id:   (listing as any).seller_contact_id,
      brokerage_id: brokerageId,
      type:         "showing.request.seller",
      title:        "Showing request on your home",
      body:         "An agent requested a showing through ShowingTime. Your agent will follow up to confirm.",
      entity_type:  "showing_request",
      entity_id:    (showing as any).id,
      priority:     "high",
      channel:      "in_app",
    }).then(() => null, () => null)
  }
  return { ok: true, showingRequestId: (showing as any).id }
}
