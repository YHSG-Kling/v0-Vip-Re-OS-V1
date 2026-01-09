import { type NextRequest, NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"
import { supabase } from "@/services/supabase"
import type { ContactFormData } from "@/types/contact"

export async function POST(request: NextRequest) {
  try {
    const body: ContactFormData = await request.json()

    // Validate required fields
    const requiredFields = ["first_name", "last_name", "email", "contact_type", "contact_persona", "timeline", "source"]
    for (const field of requiredFields) {
      if (!body[field as keyof ContactFormData]) {
        return NextResponse.json({ success: false, error: `Missing required field: ${field}` }, { status: 400 })
      }
    }

    // Get agent_id from auth (placeholder - implement your auth)
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }

    const { data: userData, error: userError } = await supabase.from("auth").select("role").eq("id", user.id).single()

    if (userError || !userData) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 401 })
    }

    const userRole = userData.role
    const canCreateContacts = ["broker", "admin", "agent"].includes(userRole?.toLowerCase())
    if (!canCreateContacts) {
      return NextResponse.json(
        { success: false, error: "You don't have permission to create contacts" },
        { status: 403 },
      )
    }

    const agentId = userRole?.toLowerCase() === "agent" ? user.id : body.agent_id || user.id

    const contact = await supabaseService.createContact({
      first_name: body.first_name,
      last_name: body.last_name,
      email: body.email,
      phone: body.phone,
      contact_type: body.contact_type,
      contact_persona: body.contact_persona,
      timeline: body.timeline,
      source: body.source,
      status: body.status || "new",
      notes: body.notes,
      agent_id: agentId,
    })

    if (!contact) {
      return NextResponse.json({ success: false, error: "Failed to create contact" }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      contact,
      message: "Contact created successfully",
    })
  } catch (error: any) {
    console.error("[Contact Create] Error:", error)
    return NextResponse.json({ success: false, error: error.message || "Internal server error" }, { status: 500 })
  }
}
