import { type NextRequest, NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status") || undefined

    console.log("[v0] API /api/scripts/list called with status:", status)

    const scripts = await supabaseService.getScripts(status)

    console.log("[v0] API fetched scripts:", scripts?.length || 0)

    return NextResponse.json({
      success: true,
      scripts: scripts || [],
      total: scripts?.length || 0,
    })
  } catch (error: any) {
    console.error("[Scripts List API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}
