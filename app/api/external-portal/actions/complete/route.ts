import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function POST(request: NextRequest) {
  try {
    const { actionId, context } = await request.json()

    if (!actionId || !context?.partnerId || !context?.partnerType) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      )
    }

    const { partnerId, partnerType, transactionId } = context

    // Initialize Supabase server client
    const supabase = await createClient()

    // Verify referral partner exists and matches the requested type
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

    // Log action completion to audit_log for compliance tracking
    await supabase
      .from("audit_log")
      .insert({
        action: "action_completed",
        entity_type: "partner_action",
        entity_id: actionId,
        user_id: null, // External partner action, not user-initiated
        after: {
          action_id: actionId,
          partner_id: partnerId,
          partner_type: partnerType,
          transaction_id: transactionId,
          completed_at: new Date().toISOString(),
        },
      })
      .catch((err) => {
        console.error("[v0] Failed to log audit entry:", err)
        // Don't fail the request if audit logging fails
      })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Error completing action:", error)
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    )
  }
}
