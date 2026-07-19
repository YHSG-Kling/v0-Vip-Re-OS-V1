import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { NextResponse } from "next/server"
import { cascadeApprove } from "@/lib/kernel/approval-queue-aggregator"

/**
 * Approve endpoint — cascades to the right source table based on the
 * prefixed id from the unified queue (/api/approvals/pending).
 *
 * Prefix → table:
 *   nl:    newsletter_campaigns
 *   em:    email_campaigns
 *   acv:   ad_creative_variations
 *   vsn:   video_snippets
 *   bp:    blog_posts
 *   pc:    podcast_episodes
 *   vp:    ai_video_projects (commissioned video renders)
 *   of:    offers (approve = the canonical acceptOffer from /offers)
 *   pa:    property_alerts (criteria proposals)
 *   <bare> approval_items (legacy)
 *
 * Authority: agents may approve only their own items (per-table scope key
 * varies — newsletter/email/video-render/offer use agents.id, blog/podcast
 * use users.id and act brokerage-wide; cascade handles each). Brokers /
 * admins may approve any item in their brokerage.
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const body = await request.json()
    const { id, notes } = body

    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Missing required field: id" }, { status: 400 })
    }

    const agentScopeId =
      auth.userType === "agent" && auth.agentId ? auth.agentId : null

    const result = await cascadeApprove(id, {
      brokerageId: auth.brokerageId,
      agentScopeId,
      reviewerUserId: auth.userId,
      notes,
    })

    if (!result.success) {
      return NextResponse.json(
        { error: result.error ?? "Failed to approve item" },
        { status: 400 },
      )
    }

    return NextResponse.json({ success: true, type: result.type, target_id: result.targetId })
  } catch (error) {
    console.error("[Approvals Approve] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
