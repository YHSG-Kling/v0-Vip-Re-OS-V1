import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }
    const agentId = await resolveAgentId(supabase, user.id)
    if (!agentId) {
      return NextResponse.json({ success: false, error: "Agent profile not found" }, { status: 403 })
    }

    const expenses = await supabaseService.getBusinessExpenses({ agentId })

    console.log("[v0] API fetched expenses:", expenses?.length || 0)

    return NextResponse.json({
      success: true,
      expenses: expenses || [],
      total: expenses?.length || 0,
    })
  } catch (error: any) {
    console.error("[Expenses API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }
    const agentId = await resolveAgentId(supabase, user.id)
    if (!agentId) {
      return NextResponse.json({ success: false, error: "Agent profile not found" }, { status: 403 })
    }

    const expenseData = await request.json()

    const expense = await supabaseService.createBusinessExpense({ ...expenseData, agent_id: agentId })

    if (!expense) {
      return NextResponse.json(
        {
          success: false,
          error: "Failed to create expense",
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      expense,
    })
  } catch (error: any) {
    console.error("[Expense Create API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}
