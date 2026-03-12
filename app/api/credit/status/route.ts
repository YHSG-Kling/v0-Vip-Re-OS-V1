import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }
    const agentId = await resolveAgentId(supabase, user.id)
    if (!agentId) {
      return NextResponse.json({ success: false, error: "Agent profile not found" }, { status: 403 })
    }

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
