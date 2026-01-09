import { type NextRequest, NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const userId = searchParams.get("user_id") || undefined

    console.log("[v0] API /api/compliance/flags called with userId:", userId)

    const flags = await supabaseService.getComplianceFlags(userId)

    console.log("[v0] API fetched compliance flags:", flags?.length || 0)

    return NextResponse.json({
      success: true,
      flags: flags || [],
      total: flags?.length || 0,
    })
  } catch (error: any) {
    console.error("[Compliance Flags API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { flagId, status, notes } = await request.json()

    console.log("[v0] API PATCH /api/compliance/flags called with flagId:", flagId)

    const flag = await supabaseService.updateComplianceFlag(flagId, status, notes)

    if (!flag) {
      return NextResponse.json(
        {
          success: false,
          error: "Failed to update compliance flag",
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      flag,
    })
  } catch (error: any) {
    console.error("[Compliance Flag Update API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}
