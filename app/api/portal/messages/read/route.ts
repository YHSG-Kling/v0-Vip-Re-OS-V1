import { NextRequest, NextResponse } from "next/server"
import { markMessagesRead } from "@/app/actions/portal-messages"

/**
 * POST /api/portal/messages/read
 * Mark messages as read for a contact.
 * Body: { contactId, direction }
 * 
 * - When contact opens messages: direction = 'agent_to_client' (marks agent's messages as read)
 * - When agent opens messages: direction = 'client_to_agent' (marks contact's messages as read)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { contactId, direction } = body

    // Validate required fields
    if (!contactId) {
      return NextResponse.json({ error: "contactId is required" }, { status: 400 })
    }
    if (!direction || !["agent_to_client", "client_to_agent"].includes(direction)) {
      return NextResponse.json({ error: "direction must be 'agent_to_client' or 'client_to_agent'" }, { status: 400 })
    }

    // Call server action
    const result = await markMessagesRead({ contactId, direction: direction as "agent_to_client" | "client_to_agent" })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    return NextResponse.json({ count: result.count })
  } catch (error) {
    console.error("[Portal Messages Read API] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
