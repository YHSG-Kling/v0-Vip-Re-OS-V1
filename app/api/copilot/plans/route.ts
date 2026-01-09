import { NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const leadId = searchParams.get("leadId")

    if (!leadId) {
      return NextResponse.json({ success: false, error: "leadId is required" }, { status: 400 })
    }

    const plans = await supabaseService.getCopilotPlans(leadId)

    return NextResponse.json({ success: true, plans })
  } catch (error: any) {
    console.error("[v0] Error fetching copilot plans:", error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}
