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

    // The vendor directory is per-brokerage. This route used to pass only `category`
    // to a service-role query, so any authenticated agent received every tenant's
    // vendors. The brokerage comes from the caller's own profile — never the request.
    const { data: profile } = await supabase
      .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
    const brokerageId = (profile as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
    if (!brokerageId) {
      return NextResponse.json({ success: false, error: "No brokerage" }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const category = searchParams.get("category") || undefined

    const vendors = await supabaseService.getVendors(brokerageId, category)

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
