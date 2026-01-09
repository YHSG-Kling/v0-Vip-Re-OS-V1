import { type NextRequest, NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const agentId = searchParams.get("agent_id") || undefined

    console.log("[v0] API /api/financial/commissions called with agentId:", agentId)

    const commissions = await supabaseService.getCommissions(agentId)

    console.log("[v0] API fetched commissions:", commissions?.length || 0)

    return NextResponse.json({
      success: true,
      commissions: commissions || [],
      total: commissions?.length || 0,
    })
  } catch (error: any) {
    console.error("[Commissions API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}
