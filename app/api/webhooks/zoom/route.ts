// app/api/webhooks/zoom/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// ZOOM RECORDING/TRANSCRIPT WEBHOOK (round 39). Register this URL in the Zoom
// app's Event Subscriptions (events: recording.transcript_completed,
// recording.completed) with ZOOM_WEBHOOK_SECRET_TOKEN set to the app's
// "Secret Token".
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
import { verifyZoomWebhook, zoomUrlValidationResponse } from "@/lib/connections/zoom"
import { processZoomRecordingEvent } from "@/lib/connections/zoom-transcripts"

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

    // Verified but unhandled event type — acknowledge without side effects.
    return NextResponse.json({ success: true, handled: false, event: payload?.event ?? null })
  } catch (error: any) {
    console.error("[Zoom Webhook] Error:", error)
    return NextResponse.json({ error: error?.message ?? "Internal error" }, { status: 500 })
  }
}
