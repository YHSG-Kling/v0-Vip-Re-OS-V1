import { type NextRequest, NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"
import { supabase } from "@/services/supabase"

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json()
    const { contactId } = body

    if (!contactId) {
      return NextResponse.json({ success: false, error: "Contact ID is required" }, { status: 400 })
    }

    const contact = await supabaseService.getContactById(contactId)

    if (!contact) {
      return NextResponse.json({ success: false, error: "Contact not found" }, { status: 404 })
    }

    const success = await supabaseService.deleteContact(contactId)

    if (!success) {
      return NextResponse.json({ success: false, error: "Failed to delete contact" }, { status: 500 })
    }

    // Delete associated auth user if exists
    if (contact.contact_user_id) {
      try {
        await supabase.auth.admin.deleteUser(contact.contact_user_id)
      } catch (authError) {
        console.error("[Contact Delete] Failed to delete auth user:", authError)
      }
    }

    return NextResponse.json({
      success: true,
      message: "Contact deleted successfully",
    })
  } catch (error: any) {
    console.error("[Contact Delete] Error:", error)
    return NextResponse.json({ success: false, error: error.message || "Internal server error" }, { status: 500 })
  }
}
