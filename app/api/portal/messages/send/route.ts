import { NextRequest, NextResponse } from "next/server"
import { sendPortalMessage } from "@/app/actions/portal-messages"

/**
 * POST /api/portal/messages/send
 * Send a new portal message.
 * Body: { contactId, messageBody, channel?, direction, transactionId? }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { contactId, messageBody, channel, direction, transactionId } = body

    // Validate required fields
    if (!contactId) {
      return NextResponse.json({ error: "contactId is required" }, { status: 400 })
    }
    if (!messageBody) {
      return NextResponse.json({ error: "messageBody is required" }, { status: 400 })
    }
    if (!direction || !["inbound", "outbound"].includes(direction)) {
      return NextResponse.json({ error: "direction must be 'inbound' or 'outbound'" }, { status: 400 })
    }

    // Call server action
    const result = await sendPortalMessage({
      contactId,
      messageBody,
      channel: channel || "portal",
      direction,
      transactionId,
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    return NextResponse.json({ message: result.message }, { status: 201 })
  } catch (error) {
    console.error("[Portal Messages Send API] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
