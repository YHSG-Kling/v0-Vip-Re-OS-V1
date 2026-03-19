import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: NextRequest) {
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
    const category = searchParams.get("category") || undefined

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
