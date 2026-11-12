// app/api/webhooks/zoom/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// ZOOM RECORDING/TRANSCRIPT + EVENT ATTENDANCE WEBHOOK (round 39; wave 148 lane 148H
// adds attendance). Register this URL in the Zoom app's Event Subscriptions (events:
// recording.transcript_completed, recording.completed, meeting.participant_joined,
// meeting.participant_left, meeting.ended — plus webinar.participant_joined/_left for
// a Zoom Webinars host) with ZOOM_WEBHOOK_SECRET_TOKEN set to the app's "Secret Token".
//
// Security (the Vapi-webhook gate idiom): if ZOOM_WEBHOOK_SECRET_TOKEN is not
// set, the endpoint REJECTS everything — without the gate any caller could
// attach fabricated "transcripts" to contacts. Every request is verified
// against Zoom's documented x-zm-signature scheme
// (v0=HMAC_SHA256(`v0:{ts}:{body}`)); Zoom's endpoint.url_validation challenge
// is answered per spec so the subscription can be activated.
//
// Processing is thin — the transcript fetch + contact/tenant attach + insight
// enrichment live in lib/connections/zoom-transcripts.ts.

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { verifyZoomWebhook, zoomUrlValidationResponse, ZOOM_PARTICIPANT_EVENTS } from "@/lib/connections/zoom"
import { processZoomRecordingEvent } from "@/lib/connections/zoom-transcripts"
import { recordZoomParticipantEvent, recordZoomMeetingEnded } from "@/lib/open-house/event-attendance"

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text()
    const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN

    let payload: any
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
    }

    // Zoom's endpoint validation challenge (sent when the subscription is
    // saved). Requires the secret — no secret, no activation.
    if (payload?.event === "endpoint.url_validation") {
      const plainToken = payload?.payload?.plainToken
      if (!secret || typeof plainToken !== "string") {
        return NextResponse.json({ error: "Webhook secret not configured" }, { status: 401 })
      }
      return NextResponse.json(zoomUrlValidationResponse(plainToken, secret))
    }

    const verified = verifyZoomWebhook({
      rawBody,
      timestamp: req.headers.get("x-zm-request-timestamp"),
      signatureHeader: req.headers.get("x-zm-signature"),
      secretToken: secret,
    })
    if (!verified) {
      return NextResponse.json({ error: "Invalid or missing webhook signature" }, { status: 401 })
    }

    if (payload?.event === "recording.transcript_completed" || payload?.event === "recording.completed") {
      const svc = createServiceClient()
      const result = await processZoomRecordingEvent(svc, payload)
      // Always 200 to acknowledged, verified deliveries — Zoom retries on
      // non-2xx and an unmatched meeting (no OS calendar event) is not an error.
      return NextResponse.json({ success: true, ...result })
    }

    // C22 ATTENDANCE (wave 148, lane 148H — owner ruling 20: "participant join/leave webhooks to verify attendance; an anonymous
    // join click is not attendance"). Subscribe the same Zoom app to meeting.participant_joined / meeting.participant_left /
    // meeting.ended (and webinar.participant_joined / _left for a Zoom Webinars host). The event row is found by its Zoom meeting
    // id and carries the tenant; identity is matched ONLY to a registration of that event (registrant id / exact e-mail); an
    // unmatched join is recorded as evidence and never becomes anyone's attendance (lib/open-house/event-attendance.ts).
    if ((ZOOM_PARTICIPANT_EVENTS as readonly string[]).includes(String(payload?.event))) {
      const svc = createServiceClient()
      const result = await recordZoomParticipantEvent(svc, payload)
      // 200 for every VERIFIED delivery: Zoom retries on non-2xx, and a participant of a meeting that is not an event (an
      // appointment) or a redelivery is not an error. The evidence row's dedupe key makes a retry a no-op.
      return NextResponse.json({ success: true, ...result })
    }
    if (payload?.event === "meeting.ended") {
      const svc = createServiceClient()
      const result = await recordZoomMeetingEnded(svc, payload)
      return NextResponse.json({ success: true, ...result })
    }

    // Verified but unhandled event type — acknowledge without side effects.
    return NextResponse.json({ success: true, handled: false, event: payload?.event ?? null })
  } catch (error: any) {
    console.error("[Zoom Webhook] Error:", error)
    return NextResponse.json({ error: error?.message ?? "Internal error" }, { status: 500 })
  }
}
