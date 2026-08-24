import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { supabaseService } from "@/services/supabaseService"

// TOMBSTONE — this handler took the framework's Request object and read NOTHING
// from it: no query string, no body, no header. Every input it uses comes from the
// SESSION (CLAUDE.md §4 — the tenant is never a request field). A route handler
// may be declared with no parameters at all, and leaving an unread `request` in the
// signature advertises a filter this endpoint does not honour.
export async function GET() {
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

    const commissions = await supabaseService.getCommissions({ agentId })

    console.log("[v0] API fetched commissions:", commissions?.length || 0)

    return NextResponse.json({
      success: true,
      commissions: commissions || [],
      total: commissions?.length || 0,
    })
  } catch (error: any) {
    console.error("[Commissions API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}
