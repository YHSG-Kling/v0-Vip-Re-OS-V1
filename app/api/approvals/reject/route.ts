import { createClient } from "@/lib/supabase/server"
import { NextResponse } from "next/server"

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    // Check authentication
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Parse request body
    const body = await request.json()
    const { id, agent_id, reason } = body

    if (!id || !agent_id) {
      return NextResponse.json({ error: "Missing required fields: id, agent_id" }, { status: 400 })
    }

    // Verify the approval item belongs to the agent
    const { data: existingItem, error: fetchError } = await supabase
      .from("approval_items")
      .select("*")
      .eq("id", id)
      .eq("agent_id", agent_id)
      .single()

    if (fetchError || !existingItem) {
      return NextResponse.json({ error: "Approval item not found" }, { status: 404 })
    }

    // Update approval item
    const { error: updateError } = await supabase
      .from("approval_items")
      .update({
        status: "rejected",
        approved_by: user.id,
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
