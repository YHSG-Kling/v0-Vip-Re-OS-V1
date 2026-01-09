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
    const creditStatus = await supabaseService.getCreditStatus(leadId)
    const interactionHistory = await supabaseService.getInteractionHistory(leadId)

    return NextResponse.json({
      success: true,
      lead: contact,
      creditStatus,
      creditLog: interactionHistory.filter((i) => i.interaction_type === "credit-related"),
    })
  } catch (error: any) {
    console.error("[v0] Error fetching credit status:", error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}
