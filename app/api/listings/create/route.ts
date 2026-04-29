import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const body = await request.json()

    // Inject agent_id and brokerage_id from session — never from body
    const { data: listing, error } = await supabase
      .from("listings")
      .insert({
        ...body,
        agent_id:    auth.agentId,        // agents.id from server session
        brokerage_id: auth.brokerageId,   // from users table via session
        created_at:  new Date().toISOString(),
      })
      .select()
      .single()

    if (error) {
      console.error("[Listing Create] DB error:", error)
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, listing })
  } catch (error: any) {
    console.error("[Listing Create] Error:", error)
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
