import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const body = await request.json()
    const { contactId } = body

    if (!contactId) {
      return NextResponse.json(
        { success: false, error: "Contact ID required" },
        { status: 400 }
      )
    }

    // Verify the contact belongs to this agent's brokerage before acting.
    // RLS enforces this too, but the explicit check gives a clear error message.
    const { data: contact } = await supabase
      .from("contacts")
      .select("id, agent_id, brokerage_id, contact_user_id")
      .eq("id", contactId)
      .eq("brokerage_id", auth.brokerageId)
      .is("deleted_at", null)
      .maybeSingle()

    if (!contact) {
      return NextResponse.json(
        { success: false, error: "Contact not found or access denied" },
        { status: 404 }
      )
    }

    // Soft delete — set deleted_at and record who deleted it.
    // Hard deletes are not performed via this route; use an admin action.
    const { error: deleteError } = await supabase
      .from("contacts")
      .update({
        deleted_at: new Date().toISOString(),
      })
      .eq("id", contactId)
      .eq("brokerage_id", auth.brokerageId)

    if (deleteError) {
      console.error("[Contact Delete] DB error:", deleteError)
      return NextResponse.json(
        { success: false, error: deleteError.message },
        { status: 500 }
      )
    }

    // Log a lifecycle event for the deletion (do NOT delete the auth user — admin action only)
    if (contact.contact_user_id) {
      await supabase.from("activities").insert({
        activity_type: "contact_deleted",
        agent_id:      auth.agentId,
        brokerage_id:  auth.brokerageId,
        contact_id:    contactId,
        notes:         JSON.stringify({
          contact_user_id: contact.contact_user_id,
          deleted_by:      auth.userId,
          reason:          "agent_initiated_delete",
        }),
        created_at: new Date().toISOString(),
      })
    }

    return NextResponse.json({ success: true, message: "Contact deleted successfully" })
  } catch (error: any) {
    console.error("[Contact Delete] Error:", error)
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
