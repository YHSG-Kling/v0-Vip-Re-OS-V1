import { type NextRequest, NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const agentId = searchParams.get("agent_id") || undefined

    console.log("[v0] API /api/financial/expenses called with agentId:", agentId)

    const expenses = await supabaseService.getBusinessExpenses(agentId)

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
    const expenseData = await request.json()

    console.log("[v0] API POST /api/financial/expenses called")

    const expense = await supabaseService.createBusinessExpense(expenseData)

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
