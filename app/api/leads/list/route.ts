import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const auth = await requireAuth(supabase)
    if (!auth.ok) return auth.response

    // ACCESS POLICY (owner): LEADS = BROKERAGE + PLATFORM ONLY. This route was
    // previously open to ANY user with an agents row (agent-scoped leads) —
    // agents work CONTACTS only (post-promotion), so lead reads are now
    // restricted to brokerage-LEVEL roles + platform staff. team_lead / TC /
    // compliance are excluded deliberately.
    const leadVisibleRoles = ["broker", "broker_owner", "broker_admin", "admin", "superadmin", "support"]
    if (!leadVisibleRoles.includes(auth.userType)) {
      return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 })
    }

    // NOTE: supabaseService.getLeads delegates to contacts — scope to the
    // caller's brokerage (and their agent profile when one exists).
    const agentId = await resolveAgentId(supabase, auth.userId)
    const leads = await supabaseService.getLeads(agentId ?? undefined, auth.brokerageId)

    return NextResponse.json({
      success: true,
      leads: leads || [],
      total: leads?.length || 0,
    })
  } catch (error: any) {
    console.error("[Leads List API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}
