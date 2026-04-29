import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const auth = await requireAuth(supabase)
    if (!auth.ok) return auth.response

    const { user, agentId, brokerageId, userType } = auth

    if (!agentId) {
      return NextResponse.json({ success: false, error: "Agent profile not found" }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const dataType = searchParams.get("type")

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
          .from("showings")
          .select("*")
          .eq("agent_id", agentId)
          .gte("scheduled_at", new Date().toISOString())
          .order("scheduled_at", { ascending: true })
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
          .from("agent_reviews")
          .select("*, contacts(*)")
          .eq("agent_id", agentId)
          .order("created_at", { ascending: false })
        data = reviews || []
        break

      case "expenses":
        const { data: expenses } = await supabase
          .from("business_expenses")
          .select("*")
          .eq("agent_id", agentId)
          .order("expense_date", { ascending: false })
        data = expenses || []
        break

      case "commissions":
        const { data: commissions } = await supabase
          .from("commissions")
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
          .eq("user_id", user.id)
          .eq("read", false)
          .order("created_at", { ascending: false })
          .limit(50)
        data = notifications || []
        break

      case "documents":
        const { data: documents } = await supabase
          .from("transaction_documents")
          .select("*, transactions(*)")
          .eq("uploaded_by", agentId)
          .order("created_at", { ascending: false })
        data = documents || []
        break

      case "agents":
        if (userType === "broker" || userType === "admin") {
          const { data: agents } = await supabase
            .from("agents")
            .select("*, users(*)")
            .eq("brokerage_id", brokerageId)
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
          .eq("brokerage_id", brokerageId)
          .eq("is_active", true)
          .order("rating", { ascending: false })
        data = vendors || []
        break

      case "communications":
        const contactId = searchParams.get("contact_id")
        let commQuery = supabase
          .from("messages")
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
