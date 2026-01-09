import { type NextRequest, NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const category = searchParams.get("category") || undefined

    console.log("[v0] API /api/vendors/list called with category:", category)

    const vendors = await supabaseService.getVendors(category)

    console.log("[v0] API fetched vendors:", vendors?.length || 0)

    return NextResponse.json({
      success: true,
      vendors: vendors || [],
      total: vendors?.length || 0,
    })
  } catch (error: any) {
    console.error("[Vendors List API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}
