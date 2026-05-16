import { type NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { logEventAndTrigger } from "@/lib/events"
import { createServiceClient } from "@/lib/supabase/service"

// =====================================================
// GOHIGHLEVEL WEBHOOK HANDLER
// Receives events from GoHighLevel CRM.
//
// HMAC-SHA256 of raw body, verified against GHL_WEBHOOK_SECRET. Sent as
// X-GHL-Signature (hex digest). Rejects if env var or signature is missing
// so an unconfigured deploy can't be exploited by arbitrary POSTs that fire
// internal kernel events.
//
// Uses the service client because there is no user session — the RLS-enforced
// server client would block the brokerage lookup and event insert.
// =====================================================

function verifyGoHighLevelSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.GHL_WEBHOOK_SECRET
  if (!secret) {
    console.warn("[gohighlevel-webhook] GHL_WEBHOOK_SECRET not set — rejecting request")
    return false
  }
  if (!signatureHeader) return false

  const computed = createHmac("sha256", secret).update(rawBody, "utf-8").digest("hex")
  try {
    const a = Buffer.from(computed, "hex")
    const b = Buffer.from(signatureHeader, "hex")
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text()
    const signatureHeader = request.headers.get("x-ghl-signature")

    if (!verifyGoHighLevelSignature(rawBody, signatureHeader)) {
      return NextResponse.json({ error: "Invalid or missing webhook signature" }, { status: 401 })
    }

    const payload = JSON.parse(rawBody)

    // Map GHL events to internal events
    const eventType = mapGHLEventType(payload.type)
    if (!eventType) {
      return NextResponse.json({ message: "Event type not supported" }, { status: 200 })
    }

    // Get brokerage_id from GHL custom field or location
    const supabase = createServiceClient()
    const { data: brokerage } = await supabase
      .from("brokerages")
      .select("id")
      .eq("ghl_location_id", payload.locationId)
      .single()

    if (!brokerage) {
      console.error("[v0] No brokerage found for GHL location:", payload.locationId)
      return NextResponse.json({ error: "Brokerage not found" }, { status: 404 })
    }

    // Log event to trigger automation
    await logEventAndTrigger({
      brokerage_id: brokerage.id,
      user_id: payload.userId,
      event_type: eventType,
      payload: payload.data,
      source: "webhook",
      dedupe_key: payload.id || `ghl_${payload.type}_${payload.contactId}_${Date.now()}`,
    })

    return NextResponse.json({ success: true, message: "Event processed" })
  } catch (error) {
    console.error("[v0] Error processing GHL webhook:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

function mapGHLEventType(ghlType: string): string | null {
  const mapping: Record<string, string> = {
    "contact.created": "lead.created",
    "contact.tagged": "lead.tagged_hot",
    "appointment.scheduled": "listing.appointment_set",
    "opportunity.status_change": "transaction.milestone_overdue",
  }

  return mapping[ghlType] || null
}
