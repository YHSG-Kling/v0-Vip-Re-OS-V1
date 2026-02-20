import { createClient } from "@/lib/supabase/server"
import { NextResponse } from "next/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export async function GET() {
  try {
    const { agentId, brokerageId } = await getAgentContext()
    const supabase = await createClient()

    // Fetch pending approval items
    const { data, error, count } = await supabase
      .from("approval_items")
      .select("*", { count: "exact" })
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })

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
