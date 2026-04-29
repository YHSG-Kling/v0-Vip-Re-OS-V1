import { type NextRequest, NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const auth = await requireAuth(supabase)
    if (!auth.ok) return auth.response

    const listingData = await request.json()

    // Inject agent and brokerage from session — never trust body-supplied values
    const enriched = {
      ...listingData,
      agent_id: auth.agentId,
      brokerage_id: auth.brokerageId,
    }

    const listing = await supabaseService.createListing(enriched)

    if (!listing) {
      return NextResponse.json({ success: false, error: "Failed to create listing" }, { status: 500 })
    }

    return NextResponse.json({ success: true, listing })
  } catch (error: any) {
    console.error("[Listing Create API] Error:", error)
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
