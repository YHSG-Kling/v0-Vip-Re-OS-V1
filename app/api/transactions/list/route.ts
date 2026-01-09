import { type NextRequest, NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const agentId = searchParams.get("agent_id") || undefined

    console.log("[v0] API /api/transactions/list called with agentId:", agentId)

    const transactions = await supabaseService.getTransactions(agentId)

    console.log("[v0] API fetched transactions:", transactions?.length || 0)

    return NextResponse.json({
      success: true,
      transactions: transactions || [],
      total: transactions?.length || 0,
    })
  } catch (error: any) {
    console.error("[Transactions List API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}
