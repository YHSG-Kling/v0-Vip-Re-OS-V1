import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { NextResponse } from "next/server"
import { cascadeReject } from "@/lib/kernel/approval-queue-aggregator"

/**
 * Reject endpoint — cascades to the right source table based on the
 * prefixed id. Same routing as /approve; flips approval_status to
 * 'rejected' on the source row (or publish_status='rejected' for blog).
 * For of:-prefixed OFFER items this is the canonical rejectOffer kernel
 * command — the optional `reason` body field is passed through and lands
 * in offers.notes (the kernel's reason column).
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const body = await request.json()
    const { id, reason } = body

    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Missing required field: id" }, { status: 400 })
    }

    const agentScopeId =
      auth.userType === "agent" && auth.agentId ? auth.agentId : null

    const result = await cascadeReject(id, {
      brokerageId: auth.brokerageId,
      agentScopeId,
      reviewerUserId: auth.userId,
      notes: reason,
    })

    if (!result.success) {
      return NextResponse.json(
        { error: result.error ?? "Failed to reject item" },
        { status: 400 },
      )
    }

    return NextResponse.json({ success: true, type: result.type, target_id: result.targetId })
  } catch (error) {
    console.error("[Approvals Reject] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
