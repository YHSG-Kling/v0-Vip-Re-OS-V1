import { type NextRequest, NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"

export async function POST(request: NextRequest) {
  try {
    const listingData = await request.json()

    console.log("[v0] API POST /api/listings/create called with data:", listingData)

    const listing = await supabaseService.createListing(listingData)

    if (!listing) {
      return NextResponse.json(
        {
          success: false,
          error: "Failed to create listing",
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      listing,
    })
  } catch (error: any) {
    console.error("[Listing Create API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}
