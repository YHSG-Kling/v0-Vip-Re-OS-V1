import { type NextRequest, NextResponse } from "next/server"
import { supabase } from "@/services/supabase"

export async function GET(request: NextRequest) {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }

    // Get all contacts for agent
    const { data: contacts, error } = await supabase
      .from("contacts")
      .select("*")
      .eq("agent_id", user.id)
      .is("deleted_at", null)

    if (error) {
      console.error("[Analytics] Error:", error)
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    // Calculate analytics
    const analytics = {
      total: contacts?.length || 0,
      with_login: contacts?.filter((c) => c.has_login).length || 0,
      by_type: {} as Record<string, number>,
      by_persona: {} as Record<string, number>,
      by_status: {} as Record<string, number>,
      by_timeline: {} as Record<string, number>,
      conversion_rate: 0,
    }

    // Count by type, persona, status, timeline
    contacts?.forEach((contact) => {
      analytics.by_type[contact.contact_type] = (analytics.by_type[contact.contact_type] || 0) + 1
      analytics.by_persona[contact.contact_persona] = (analytics.by_persona[contact.contact_persona] || 0) + 1
      analytics.by_status[contact.status] = (analytics.by_status[contact.status] || 0) + 1
      analytics.by_timeline[contact.timeline] = (analytics.by_timeline[contact.timeline] || 0) + 1
    })

    // Calculate conversion rate (qualified+ / total)
    const qualifiedStatuses = [
      "qualified",
      "appointment_booked",
      "signed_agreement",
      "pre_listing",
      "active_listing",
      "contingent",
      "pending",
      "sold",
      "lifetime_customer",
    ]
    const qualifiedCount = contacts?.filter((c) => qualifiedStatuses.includes(c.status)).length || 0
    analytics.conversion_rate = analytics.total > 0 ? (qualifiedCount / analytics.total) * 100 : 0

    return NextResponse.json({
      success: true,
      analytics,
    })
  } catch (error: any) {
    console.error("[Analytics] Error:", error)
    return NextResponse.json({ success: false, error: error.message || "Internal server error" }, { status: 500 })
  }
}
