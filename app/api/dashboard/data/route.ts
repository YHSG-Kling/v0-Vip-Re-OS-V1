import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"

// Consolidated API endpoint for fetching dashboard data.
// Reduces duplicate API routes and centralises data fetching.
//
// SECURITY:
//   - agent_id is NEVER accepted from query params — always resolved from session.
//   - brokerage_id is NEVER accepted from query params — resolved from users table.
//   - Both are derived server-side from the authenticated session only.

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const dataType = searchParams.get("type")

    // Resolve agentId from agents table — NEVER from query params (security invariant)
    const agentId = await resolveAgentId(supabase, user.id)

    // Resolve brokerageId from users table — NEVER from query params
    const { data: userData } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .maybeSingle()

    const brokerageId = userData?.brokerage_id
    if (!brokerageId) {
      return NextResponse.json(
        { success: false, error: "Brokerage not configured" },
        { status: 403 }
      )
    }

    if (!agentId) {
      return NextResponse.json(
        { success: false, error: "Agent profile not found" },
        { status: 403 }
      )
    }

    let data: any = null

    switch (dataType) {
      case "transactions": {
        const { data: transactions } = await supabase
          .from("transactions")
          .select("*, listings(*), contacts(*)")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
        data = transactions || []
        break
      }

      case "contacts": {
        // contacts.agent_id → agents.id (FK corrected + backfilled in migration 114)
        const { data: contacts } = await supabase
          .from("contacts")
          .select("*")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
        data = contacts || []
        break
      }

      case "listings": {
        const { data: listings } = await supabase
          .from("listings")
          .select("*")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
        data = listings || []
        break
      }

      case "appointments": {
        const { data: appointments } = await supabase
          .from("showings")
          .select("*")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .gte("scheduled_at", new Date().toISOString())
          .order("scheduled_at", { ascending: true })
        data = appointments || []
        break
      }

      case "showings": {
        // showings.brokerage_id added to scope correctly
        const { data: showings } = await supabase
          .from("showings")
          .select("*, listings(*), contacts(*)")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("scheduled_at", { ascending: false })
        data = showings || []
        break
      }

      case "offers": {
        // offers.brokerage_id added to scope correctly
        const { data: offers } = await supabase
          .from("offers")
          .select("*, listings(*), contacts(*)")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
        data = offers || []
        break
      }

      case "referrals": {
        // referrals.brokerage_id added to scope correctly
        const { data: referrals } = await supabase
          .from("referrals")
          .select("*")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
        data = referrals || []
        break
      }

      case "reviews": {
        const { data: reviews } = await supabase
          .from("agent_reviews")
          .select("*, contacts(*)")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
        data = reviews || []
        break
      }

      case "expenses": {
        const { data: expenses } = await supabase
          .from("business_expenses")
          .select("*")
          .eq("agent_id", agentId)
          .order("expense_date", { ascending: false })
        data = expenses || []
        break
      }

      case "commissions": {
        const { data: commissions } = await supabase
          .from("agent_commissions")
          .select("*, transactions(*)")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
        data = commissions || []
        break
      }

      case "open_houses": {
        const { data: openHouses } = await supabase
          .from("open_house_events")
          .select("*, listings(*)")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("event_date", { ascending: false })
        data = openHouses || []
        break
      }

      case "tasks": {
        const { data: tasks } = await supabase
          .from("tasks")
          .select("*")
          .eq("assigned_to_agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("due_date", { ascending: true })
        data = tasks || []
        break
      }

      case "notifications": {
        // notifications.user_id stores auth user ID (users.id), not agents.id
        const { data: notifications } = await supabase
          .from("notifications")
          .select("*")
          .eq("user_id", user.id)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
          .limit(50)
        data = notifications || []
        break
      }

      case "documents": {
        const { data: documents } = await supabase
          .from("transaction_documents")
          .select("*, transactions(*)")
          .eq("uploaded_by", user.id)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
        data = documents || []
        break
      }

      case "agents": {
        // Broker/admin view only — verify role before exposing team roster
        const { data: userRow } = await supabase
          .from("users")
          .select("user_type")
          .eq("id", user.id)
          .maybeSingle()

        if (
          userRow?.user_type === "broker" ||
          userRow?.user_type === "admin" ||
          userRow?.user_type === "superadmin"
        ) {
          const { data: agents } = await supabase
            .from("agents")
            .select("*")
            .eq("brokerage_id", brokerageId)
            .order("created_at", { ascending: false })
          data = agents || []
        } else {
          data = []
        }
        break
      }

      case "tours": {
        const { data: tours } = await supabase
          .from("tours")
          .select("*, tour_stops(*, listings(*)), contacts(*)")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("tour_date", { ascending: false })
        data = tours || []
        break
      }

      case "vendors": {
        // vendors.brokerage_id added — was previously missing (zero brokerage scoping)
        const { data: vendors } = await supabase
          .from("vendors")
          .select("*")
          .eq("brokerage_id", brokerageId)
          .order("rating", { ascending: false })
        data = vendors || []
        break
      }

      case "communications": {
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
      }

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
