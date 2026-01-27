import { type NextRequest, NextResponse } from "next/server"
import { logEventAndTrigger } from "@/lib/events/event-helpers"

// =====================================================
// ZAPIER WEBHOOK HANDLER
// Generic webhook for Zapier integrations
// =====================================================

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json()

    console.log("[v0] Zapier webhook received:", payload)

    // Zapier payload should include:
    // - brokerage_id
    // - user_id
    // - event_type
    // - data (event payload)

    if (!payload.brokerage_id || !payload.event_type) {
      return NextResponse.json({ error: "Missing required fields: brokerage_id, event_type" }, { status: 400 })
    }

    // Log event to trigger automation
    await logEventAndTrigger({
      brokerage_id: payload.brokerage_id,
      user_id: payload.user_id,
      event_type: payload.event_type,
      payload: payload.data || {},
      source: "webhook",
      dedupe_key: payload.dedupe_key || `zapier_${payload.event_type}_${Date.now()}`,
    })

    return NextResponse.json({ success: true, message: "Event processed" })
  } catch (error) {
    console.error("[v0] Error processing Zapier webhook:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
