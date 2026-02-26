import { type NextRequest, NextResponse } from "next/server"
import { logEventAndTrigger } from "@/lib/events"
import { createServerClient } from "@/lib/supabase/server"

// =====================================================
// GOHIGHLEVEL WEBHOOK HANDLER
// Receives events from GoHighLevel CRM
// =====================================================

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json()

    console.log("[v0] GoHighLevel webhook received:", payload)

    // Verify webhook signature (implement based on GHL docs)
    // const signature = request.headers.get("x-ghl-signature")
    // if (!verifySignature(signature, payload)) {
    //   return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
    // }

    // Map GHL events to internal events
    const eventType = mapGHLEventType(payload.type)
    if (!eventType) {
      return NextResponse.json({ message: "Event type not supported" }, { status: 200 })
    }

    // Get brokerage_id from GHL custom field or location
    const supabase = await createServerClient()
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
