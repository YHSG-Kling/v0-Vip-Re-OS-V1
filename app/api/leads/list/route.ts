import { type NextRequest, NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const agentId = searchParams.get("agent_id") || undefined

    console.log("[v0] API /api/leads/list called with agentId:", agentId)

    const leads = await supabaseService.getLeads(agentId)

    console.log("[v0] API fetched leads:", leads?.length || 0)

    return NextResponse.json({
      success: true,
      leads: leads || [],
      total: leads?.length || 0,
    })
  } catch (error: any) {
    console.error("[Leads List API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}
