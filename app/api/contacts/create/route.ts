import { type NextRequest, NextResponse } from "next/server"
import { createContact } from "@/lib/services"
import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import type { ContactFormData } from "@/types/contact"
import { enrichContact } from "@/app/actions/contact-enrichment"

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

    // Get agent_id from auth
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }

    const { data: agent } = await supabase.from("agents").select("id, brokerage_id").eq("user_id", user.id).maybeSingle()
    const { data: userRecord } = await supabase.from("users").select("role").eq("id", user.id).maybeSingle()

    if (!userRecord) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 401 })
    }

    const userRole = userRecord.role
    const canCreateContacts = ["broker", "admin", "agent"].includes(userRole?.toLowerCase())
    if (!canCreateContacts) {
      return NextResponse.json(
        { success: false, error: "You don't have permission to create contacts" },
        { status: 403 },
      )
    }

    // Use agent.id directly instead of separate resolveAgentId call
    const agentId = userRole?.toLowerCase() === "agent" 
      ? agent?.id 
      : body.agent_id || agent?.id
    if (!agentId) {
      return NextResponse.json({ success: false, error: "Agent profile not found" }, { status: 403 })
    }

    // Use consolidated contact management service
    const result = await createContact({
      agentId,
      firstName: body.first_name,
      lastName: body.last_name,
      email: body.email,
      phone: body.phone,
      source: body.source,
      status: body.status || "new",
      contactType: body.contact_type,
      persona: body.contact_persona,
      timeline: body.timeline,
      notes: body.notes,
    })

    if (!result.success || !result.contact) {
      return NextResponse.json({ success: false, error: result.error || "Failed to create contact" }, { status: 500 })
    }

    const contact = result.contact

    enrichContact(contact.id, { source: "manual" }).catch((err) => {
      console.error("[Contact Create] Enrichment error:", err)
    })

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
