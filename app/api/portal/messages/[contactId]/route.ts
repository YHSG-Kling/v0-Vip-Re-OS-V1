import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

/**
 * GET /api/portal/messages/[contactId]
 * Returns all messages for a contact ordered by created_at ascending.
 *
 * Access rules (matches portal layout gate):
 *  1. Authenticated user whose email matches contact.email (contact self-service)
 *  2. Assigned agent (agents.id === contacts.agent_id AND agents.user_id === user.id)
 *  3. Admin/broker of same brokerage
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

    // Load contact to validate access
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("id, email, agent_id, brokerage_id")
      .eq("id", contactId)
      .maybeSingle()

    if (contactError || !contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 })
    }

    // ── Access gate ────────────────────────────────────────────────────────────
    let accessGranted = false

    // Rule 1: Contact's own email (client self-service)
    if (user.email?.toLowerCase() === contact.email?.toLowerCase()) {
      accessGranted = true
    }

    // Rule 2: Assigned agent (agents.user_id === user.id AND agents.id === contact.agent_id)
    if (!accessGranted && contact.agent_id) {
      const { data: ag } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", user.id)
        .eq("id", contact.agent_id)
        .maybeSingle()
      if (ag) accessGranted = true
    }

    // Rule 3: Admin/broker of same brokerage
    if (!accessGranted) {
      const { data: ur } = await supabase
        .from("users")
        .select("user_type, brokerage_id")
        .eq("id", user.id)
        .maybeSingle()
      if (
        ur?.brokerage_id === contact.brokerage_id &&
        ["admin", "broker", "superadmin"].includes(ur.user_type ?? "")
      ) {
        accessGranted = true
      }
    }

    if (!accessGranted) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // Fetch messages scoped to contact + brokerage
    const { data: messages, error: fetchError } = await supabase
      .from("client_portal_messages")
      .select("*")
      .eq("contact_id", contactId)
      .eq("brokerage_id", contact.brokerage_id)
      .order("created_at", { ascending: true })

    if (fetchError) {
      return NextResponse.json({ error: "Failed to load messages" }, { status: 500 })
    }

    return NextResponse.json({ messages: messages || [] })
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
