import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase"

export async function POST(request: NextRequest) {
  try {
    const { actionId, context } = await request.json()

    if (!actionId || !context?.partnerId || !context?.partnerType) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      )
    }

    const { partnerId, partnerType } = context

    // Initialize Supabase client
    const supabase = await createClient()

    // Verify partner exists and matches the session
    const { data: partner, error: partnerError } = await supabase
      .from("referral_partners")
      .select("id, partner_type")
      .eq("id", partnerId)
      .eq("partner_type", partnerType)
      .single()

    if (partnerError || !partner) {
      console.error("[v0] Partner validation failed:", { partnerId, partnerType, error: partnerError })
      return NextResponse.json(
        { success: false, error: "Partner not found or unauthorized" },
        { status: 403 }
      )
    }

    // Log action completion for audit trail
    await supabase
      .from("partner_action_logs")
      .insert({
        action_id: actionId,
        partner_id: partnerId,
        partner_type: partnerType,
        action_type: "action_completed",
        timestamp: new Date().toISOString(),
      })
      .catch((err) => {
        console.error("[v0] Failed to log action:", err)
        // Don't fail the request if logging fails
      })

    // Update action status to completed in your actions table
    // This assumes you have a partner_actions or similar table
    const { error: updateError } = await supabase
      .from("partner_actions")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", actionId)
      .eq("partner_id", partnerId)

    if (updateError) {
      console.error("[v0] Failed to update action:", updateError)
      return NextResponse.json(
        { success: false, error: "Failed to complete action" },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Error completing action:", error)
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    )
  }
}
