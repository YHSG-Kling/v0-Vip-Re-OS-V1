import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

// TOMBSTONE — this handler took the framework's Request object and read NOTHING
// from it: no query string, no body, no header. Every input it uses comes from the
// SESSION (CLAUDE.md §4 — the tenant is never a request field). A route handler
// may be declared with no parameters at all, and leaving an unread `request` in the
// signature advertises a filter this endpoint does not honour.
export async function GET() {
  // Auth guard — agentId and brokerageId always from session
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    // Agents see only their own contacts; brokers/admins see all in the brokerage
    let query = supabase
      .from("contacts")
      .select("*")
      .eq("brokerage_id", auth.brokerageId)
      .is("deleted_at", null)

    // contacts.agent_id → agents.id (FK corrected in migration 114)
    if (auth.agentId && !isAdminOrBroker({ user_type: auth.userType })) {
      query = query.eq("agent_id", auth.agentId)
    }

    const { data: contacts, error } = await query

    if (error) {
      console.error("[Analytics] Error:", error)
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    const analytics = {
      total: contacts?.length || 0,
      with_login: contacts?.filter((c) => c.has_login).length || 0,
      by_type: {} as Record<string, number>,
      by_persona: {} as Record<string, number>,
      by_status: {} as Record<string, number>,
      by_timeline: {} as Record<string, number>,
      conversion_rate: 0,
    }

    contacts?.forEach((contact) => {
      if (contact.contact_type)
        analytics.by_type[contact.contact_type] = (analytics.by_type[contact.contact_type] || 0) + 1
      if (contact.contact_persona)
        analytics.by_persona[contact.contact_persona] = (analytics.by_persona[contact.contact_persona] || 0) + 1
      if (contact.status)
        analytics.by_status[contact.status] = (analytics.by_status[contact.status] || 0) + 1
      if (contact.timeline)
        analytics.by_timeline[contact.timeline] = (analytics.by_timeline[contact.timeline] || 0) + 1
    })

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

    return NextResponse.json({ success: true, analytics })
  } catch (error: any) {
    console.error("[Analytics] Error:", error)
    return NextResponse.json({ success: false, error: error.message || "Internal server error" }, { status: 500 })
  }
}
