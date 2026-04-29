import { createClient } from "@/lib/supabase/server"
import { NextResponse } from "next/server"
import { requireAuth } from "@/lib/kernel/api-auth"

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const auth = await requireAuth(supabase)
    if (!auth.ok) return auth.response

    const body = await request.json()
    const { id, reason } = body

    if (!id) {
      return NextResponse.json({ error: "Missing required field: id" }, { status: 400 })
    }

    // Verify the approval item belongs to this user's brokerage (never trust body-supplied agent_id)
    const { data: existingItem, error: fetchError } = await supabase
      .from("approval_items")
      .select("*")
      .eq("id", id)
      .eq("brokerage_id", auth.brokerageId)
      .single()

    if (fetchError || !existingItem) {
      return NextResponse.json({ error: "Approval item not found" }, { status: 404 })
    }

    const { error: updateError } = await supabase
      .from("approval_items")
      .update({
        status: "rejected",
        approved_by: auth.user.id,
        approved_at: new Date().toISOString(),
        notes: reason || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)

    if (updateError) {
      console.error("[v0] Error rejecting item:", updateError)
      return NextResponse.json({ error: "Failed to reject item" }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Unexpected error in reject endpoint:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
