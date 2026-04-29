import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { NextResponse } from "next/server"

export async function POST(request: Request) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const body = await request.json()
    // agent_id is NOT accepted from the body — it was an authorization bypass.
    // The caller only supplies the approval item id and optional notes.
    const { id, notes } = body

    if (!id) {
      return NextResponse.json(
        { error: "Missing required field: id" },
        { status: 400 }
      )
    }

    // Fetch the approval item scoped to the caller's brokerage.
    // Brokers/admins may approve any item in their brokerage.
    // Agents may only approve items assigned to themselves.
    let fetchQuery = supabase
      .from("approval_items")
      .select("id, agent_id, brokerage_id, status")
      .eq("id", id)
      .eq("brokerage_id", auth.brokerageId)

    if (auth.userType === "agent" && auth.agentId) {
      fetchQuery = fetchQuery.eq("agent_id", auth.agentId)
    }

    const { data: existingItem, error: fetchError } = await fetchQuery.maybeSingle()

    if (fetchError || !existingItem) {
      return NextResponse.json(
        { error: "Approval item not found or access denied" },
        { status: 404 }
      )
    }

    const { error: updateError } = await supabase
      .from("approval_items")
      .update({
        status:      "approved",
        reviewed_by: auth.userId,
        reviewed_at: new Date().toISOString(),
        review_notes: notes ?? null,
      })
      .eq("id", id)
      .eq("brokerage_id", auth.brokerageId)

    if (updateError) {
      console.error("[Approvals Approve] DB error:", updateError)
      return NextResponse.json({ error: "Failed to approve item" }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[Approvals Approve] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
