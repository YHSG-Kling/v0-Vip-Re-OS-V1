import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

/**
 * GET /api/portal/messages/[contactId]
 * Returns all messages for a contact ordered by created_at ascending.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ contactId: string }> }
) {
  try {
    const { contactId } = await params
    const supabase = await createClient()

    // Validate auth
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Validate contactId
    if (!contactId) {
      return NextResponse.json({ error: "Contact ID is required" }, { status: 400 })
    }

    // Fetch messages
    const { data: messages, error: fetchError } = await supabase
      .from("client_portal_messages")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: true })

    if (fetchError) {
      console.error("[Portal Messages API] Fetch error:", fetchError)
      return NextResponse.json({ error: "Failed to load messages" }, { status: 500 })
    }

    return NextResponse.json({ messages: messages || [] })
  } catch (error) {
    console.error("[Portal Messages API] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
