import { NextResponse } from "next/server"
import { getAgentContext } from "@/lib/identity"
import { aggregatePendingApprovals } from "@/lib/kernel/approval-queue-aggregator"

/**
 * Daily approval queue — unified across content channels.
 *
 * Previously this only queried approval_items (which nothing inserts into
 * across the codebase, so the queue was empty). Refactored to aggregate
 * from each canonical content table that already has a 'pending' approval
 * column, so the staged content visible to the agent in /approvals matches
 * what the canonical creators (createNewsletterCampaign, createEmailCampaign,
 * generateAdCreative, etc.) actually produce.
 *
 * Sources (live schema verified):
 *   - newsletter_campaigns.approval_status in ('pending','pending_review')
 *   - email_campaigns.approval_status='pending'
 *   - ad_creative_variations.approval_status='draft' (pre-launch review)
 *   - video_snippets.approval_status='pending'
 *   - blog_posts.publish_status='draft' (not rejected)
 *   - podcast_episodes.approval_status='pending_review'
 *   - ai_video_projects.approval_status='pending_review' (commissioned renders)
 *   - offers (DEAL DECISIONS, own 'deals' section — inbound offers on our
 *     seller listings, status pending/submitted, awaiting accept/reject/
 *     counter; outbound buyer offers on outside properties never appear)
 *   - property_alerts voice/text criteria proposals
 *   - approval_items.status='pending' (legacy table — still surfaced)
 *
 * Each item carries a prefixed id (nl:/em:/acv:/vsn:/bp:/pc:/vp:/of:/pa:) so
 * the approve/reject routes know which source table to cascade to.
 */
export async function GET() {
  try {
    const { agentId, brokerageId, userType } = await getAgentContext()

    if (!brokerageId) {
      return NextResponse.json({ items: [], total: 0 })
    }

    // Brokers / admins see brokerage-wide; agents see their own only.
    const agentScopeId = userType === "agent" && agentId ? agentId : null

    const items = await aggregatePendingApprovals(brokerageId, agentScopeId)

    return NextResponse.json({ items, total: items.length })
  } catch (error) {
    console.error("[Approvals Pending] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
