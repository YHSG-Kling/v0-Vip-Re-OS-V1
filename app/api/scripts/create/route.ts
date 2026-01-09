import { type NextRequest, NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"

export async function POST(request: NextRequest) {
  try {
    const scriptData = await request.json()

    console.log("[v0] API POST /api/scripts/create called")

    const script = await supabaseService.createScript(scriptData)

    if (!script) {
      return NextResponse.json(
        {
          success: false,
          error: "Failed to create script",
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      script,
    })
  } catch (error: any) {
    console.error("[Script Create API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}
