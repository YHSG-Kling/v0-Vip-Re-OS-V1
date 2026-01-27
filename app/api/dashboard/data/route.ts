"use server"

import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Consolidated API endpoint for fetching dashboard data
// Reduces duplicate API routes and centralizes data fetching

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const dataType = searchParams.get("type")
    const agentId = searchParams.get("agent_id") || user.id

    let data: any = null

    switch (dataType) {
      case "transactions":
        const { data: transactions } = await supabase
          .from("transactions")
          .select("*, listings(*), contacts(*)")
          .eq("agent_id", agentId)
          .order("created_at", { ascending: false })
        data = transactions || []
        break

      case "contacts":
        const { data: contacts } = await supabase
          .from("contacts")
          .select("*")
          .eq("agent_id", agentId)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
        data = contacts || []
        break

      case "listings":
        const { data: listings } = await supabase
          .from("listings")
          .select("*")
          .eq("agent_id", agentId)
          .order("created_at", { ascending: false })
        data = listings || []
        break

      case "appointments":
        const { data: appointments } = await supabase
          .from("appointments")
          .select("*")
          .eq("agent_id", agentId)
          .gte("start_time", new Date().toISOString())
          .order("start_time", { ascending: true })
        data = appointments || []
        break

      case "showings":
        const { data: showings } = await supabase
          .from("showings")
          .select("*, listings(*), contacts(*)")
          .eq("agent_id", agentId)
          .order("showing_date", { ascending: false })
        data = showings || []
        break

      case "offers":
        const { data: offers } = await supabase
          .from("offers")
          .select("*, listings(*), contacts(*)")
          .eq("agent_id", agentId)
          .order("created_at", { ascending: false })
        data = offers || []
        break

      case "referrals":
        const { data: referrals } = await supabase
          .from("referrals")
          .select("*, referrer:contacts!referrer_contact_id(*), referred:contacts!referred_contact_id(*)")
          .eq("agent_id", agentId)
          .order("created_at", { ascending: false })
        data = referrals || []
        break

      case "reviews":
        const { data: reviews } = await supabase
          .from("reviews")
          .select("*, contacts(*)")
          .eq("agent_id", agentId)
          .order("created_at", { ascending: false })
        data = reviews || []
        break

      case "expenses":
        const { data: expenses } = await supabase
          .from("expenses")
          .select("*")
          .eq("agent_id", agentId)
          .order("expense_date", { ascending: false })
        data = expenses || []
        break

      case "commissions":
        const { data: commissions } = await supabase
          .from("commission_records")
          .select("*, transactions(*)")
          .eq("agent_id", agentId)
          .order("created_at", { ascending: false })
        data = commissions || []
        break

      case "open_houses":
        const { data: openHouses } = await supabase
          .from("open_house_events")
          .select("*, listings(*)")
          .eq("agent_id", agentId)
          .order("event_date", { ascending: false })
        data = openHouses || []
        break

      case "tasks":
        const { data: tasks } = await supabase
          .from("tasks")
          .select("*")
          .eq("assigned_to", agentId)
          .eq("completed", false)
          .order("due_date", { ascending: true })
        data = tasks || []
        break

      case "notifications":
        const { data: notifications } = await supabase
          .from("notifications")
          .select("*")
          .eq("user_id", agentId)
          .eq("read", false)
          .order("created_at", { ascending: false })
          .limit(50)
        data = notifications || []
        break

      case "documents":
        const { data: documents } = await supabase
          .from("documents")
          .select("*, transactions(*)")
          .eq("uploaded_by", agentId)
          .order("created_at", { ascending: false })
        data = documents || []
        break

      case "agents":
        // For admin/broker views
        const { data: profile } = await supabase
          .from("user_profiles")
          .select("brokerage_id, role")
          .eq("id", user.id)
          .single()

        if (profile?.role === "broker" || profile?.role === "admin") {
          const { data: agents } = await supabase
            .from("agents")
            .select("*, user_profiles(*)")
            .eq("brokerage_id", profile.brokerage_id)
            .order("created_at", { ascending: false })
          data = agents || []
        } else {
          data = []
        }
        break

      case "tours":
        const { data: tours } = await supabase
          .from("tours")
          .select("*, tour_stops(*, listings(*)), contacts(*)")
          .eq("agent_id", agentId)
          .order("tour_date", { ascending: false })
        data = tours || []
        break

      case "vendors":
        const { data: vendors } = await supabase
          .from("vendors")
          .select("*")
          .eq("is_active", true)
          .order("rating", { ascending: false })
        data = vendors || []
        break

      case "communications":
        const contactId = searchParams.get("contact_id")
        let commQuery = supabase
          .from("communications")
          .select("*, contacts(*)")
          .order("created_at", { ascending: false })
          .limit(100)
        
        if (contactId) {
          commQuery = commQuery.eq("contact_id", contactId)
        } else {
          commQuery = commQuery.eq("agent_id", agentId)
        }
        
        const { data: communications } = await commQuery
        data = communications || []
        break

      default:
        return NextResponse.json(
          { success: false, error: `Unknown data type: ${dataType}` },
          { status: 400 }
        )
    }

    return NextResponse.json({
      success: true,
      data,
      count: Array.isArray(data) ? data.length : 0,
    })
  } catch (error: any) {
    console.error("[Dashboard Data API] Error:", error)
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
