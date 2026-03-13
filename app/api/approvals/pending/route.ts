import { createClient } from "@/lib/supabase/server"
import { NextResponse } from "next/server"
import { getAgentContext } from "@/lib/identity"

export async function GET() {
  try {
    const { agentId, brokerageId } = await getAgentContext()
    const supabase = await createClient()

    // Build query - filter by agent_id if user is an agent, otherwise show brokerage-wide for admins/brokers
    let query = supabase
      .from("approval_items")
      .select("*", { count: "exact" })
      .eq("brokerage_id", brokerageId)
      .eq("status", "pending")
      .order("submitted_at", { ascending: false })

    // If user is an agent, only show their approvals
    if (agentId) {
      query = query.eq("agent_id", agentId)
    }

    const { data, error, count } = await query

    if (error) {
      console.error("[v0] Error fetching pending approvals:", error)
      return NextResponse.json({ error: "Failed to fetch pending approvals" }, { status: 500 })
    }

    return NextResponse.json({
      items: data || [],
      total: count || 0,
    })
  } catch (error) {
    console.error("[v0] Unexpected error in pending approvals:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
