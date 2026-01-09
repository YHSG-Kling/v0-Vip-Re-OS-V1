import { NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const leadId = searchParams.get("leadId")

    if (!leadId) {
      return NextResponse.json({ success: false, error: "leadId is required" }, { status: 400 })
    }

    const contact = await supabaseService.getContactById(leadId)
    const engagementData = await supabaseService.getVideoEngagement(leadId)

    return NextResponse.json({
      success: true,
      lead: contact,
      engagementEvents: engagementData,
      videos: engagementData,
    })
  } catch (error: any) {
    console.error("[v0] Error fetching video engagement:", error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}
