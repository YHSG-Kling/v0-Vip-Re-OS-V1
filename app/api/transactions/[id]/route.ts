import { type NextRequest, NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    console.log("[v0] API /api/transactions/[id] called with id:", id)

    const transaction = await supabaseService.getTransactionById(id)

    if (!transaction) {
      return NextResponse.json(
        {
          success: false,
          error: "Transaction not found",
        },
        { status: 404 },
      )
    }

    console.log("[v0] API fetched transaction:", transaction.id)

    return NextResponse.json({
      success: true,
      transaction,
    })
  } catch (error: any) {
    console.error("[Transaction Detail API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const updates = await request.json()

    console.log("[v0] API PATCH /api/transactions/[id] called with updates:", updates)

    const transaction = await supabaseService.updateTransaction(id, updates)

    if (!transaction) {
      return NextResponse.json(
        {
          success: false,
          error: "Failed to update transaction",
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      transaction,
    })
  } catch (error: any) {
    console.error("[Transaction Update API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}
