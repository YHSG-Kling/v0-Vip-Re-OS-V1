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

  // ─── SCHEMA ADAPTATION (owner: self-heal when the provider's shape drifts) ──
  // The raw appointment is normalized to the canonical contract BEFORE any
  // code touches it: renames/nesting changes remap through aliases, safe type
  // drift coerces, unknown fields are captured. A payload missing REQUIRED
  // facts QUARANTINES (parks for review) instead of corrupting downstream.
  const { adaptPayload, SHOWINGTIME_APPOINTMENT_CONTRACT } = await import("@/lib/kernel/schema-adaptation")
  const adapted = adaptPayload(SHOWINGTIME_APPOINTMENT_CONTRACT, payload.appointment)
  if (!adapted.ok) {
    const { parkIngressEvent } = await import("@/lib/kernel/ingress-continuity")
    const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
    const quarantineRef = `stq:${(payload.appointment as any)?.id ?? (payload.appointment as any)?.appointment_id ?? Date.now()}`
    await parkIngressEvent(supabase, {
      provider: "showingtime",
      eventKind: "schema_drift_quarantine",
      externalRef: quarantineRef,
      payload: { source: "showingtime_appointment", event_type: payload.event_type, raw: payload.appointment, missing: adapted.missingRequired },
    })
    await recordSelfHeal(supabase, {
      brokerageId: null, domain: "data_flow", subject: quarantineRef, action: "none", outcome: "escalated",
      detail: { flow: "schema_drift", connector: "showingtime", missing: adapted.missingRequired, reason: "provider payload is missing required facts — quarantined for review, never guessed" },
    })
    return NextResponse.json({ ok: true, quarantined: true, missing: adapted.missingRequired })
  }
  const c = adapted.canonical
  const appt: ShowingTimeAppointment = {
    id: String(c.id),
    status: "requested" as any,
    property: { address: (c.address as string) ?? undefined, city: (c.city as string) ?? undefined, state: (c.state as string) ?? undefined, mls_number: (c.mls_number as string) ?? undefined, listing_id: (c.listing_id as string) ?? undefined },
    buyer_agent: { name: (c.agent_name as string) ?? undefined, email: (c.agent_email as string) ?? undefined, phone: (c.agent_phone as string) ?? undefined, license: (c.agent_license as string) ?? undefined },
    requested_at: String(c.requested_at),
    confirmed_at: (c.confirmed_at as string) ?? undefined,
    duration_minutes: (c.duration_minutes as number) ?? undefined,
    notes: (c.notes as string) ?? undefined,
    external_ref: (c.external_ref as string) ?? undefined,
  }
  // Drift the OS absorbed (alias/coercion/default repairs) is a real self-heal — ledgered.
  if (adapted.driftRepairs > 0) {
    const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
    await recordSelfHeal(supabase, {
      brokerageId: null, domain: "data_flow", subject: `st:${appt.id}`, action: "adapt_payload", outcome: "healed",
      detail: { flow: "schema_drift", connector: "showingtime", repairs: adapted.repairs.filter((r) => r.kind !== "direct").slice(0, 12) },
    })
  }

  // ─── Resolve the listing (shared with the ingress reconciler) ─────────
  const { resolveShowingTimeListing, ingestShowingTimeRequest } = await import("@/lib/showings/showingtime-ingest")
  const resolved = await resolveShowingTimeListing(supabase, {
    listingId: appt.property.listing_id ?? null,
    mlsNumber: appt.property.mls_number ?? null,
    brokerageId: payload.brokerage_id ?? null,
  })

  if (!resolved) {
    // INGRESS CONTINUITY: an appointment.requested we can't place yet (the
    // listing row hasn't carried its mls_number — a real showing request on
    // OUR listing) is PARKED for the daily reconciler, never lost behind
    // this 200. Other event kinds with no resolution have nothing to replay.
    if (payload.event_type === "appointment.requested" && appt.property.mls_number && appt.id) {
      const { parkIngressEvent } = await import("@/lib/kernel/ingress-continuity")
      await parkIngressEvent(supabase, {
        provider: "showingtime",
        eventKind: "showingtime_appointment_requested",
        externalRef: String(appt.id),
        payload: { appointment: appt },
      })
      return NextResponse.json({ ok: true, parked: true })
    }
    console.warn("[showingtime-webhook] could not resolve listing", appt.property)
    return NextResponse.json({ ok: true, ignored: true })
  }
  const { listingId, brokerageId } = resolved

  switch (payload.event_type) {
    case "appointment.requested": {
      // ONE ingest path, shared with the reconciler (idempotent — a
      // ShowingTime redelivery never double-books the agent's queue).
      const r = await ingestShowingTimeRequest(supabase, { appt: appt as any, listingId, brokerageId })
      if (!r.ok) {
        return NextResponse.json({ error: "could not record showing request" }, { status: 500 })
      }
      return NextResponse.json({ ok: true, showing_request_id: r.showingRequestId, deduped: r.deduped ?? false })
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
