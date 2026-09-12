"use server"

/**
 * /dashboard/marketing/review — server actions.
 *
 * Pulls every "AI prepared this for you to review" item into a single payload
 * so the agent can triage in one place. Sources:
 *
 *   - ai_message_drafts   (status='pending' + trigger_event from media events)
 *   - social_posts        (ai_generated=true, status in scheduled/draft/compliance_review)
 *   - listing_media       (approval_required AND is_approved=false)
 *   - qr_codes            (recently created, listing/open_house/event/general)
 *
 * Inline actions also live here so the client can dismiss/approve without
 * shipping new endpoints — the existing approveListingMedia / rejectListingMedia
 * actions in app/actions/listing-media.ts are reused.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

const MEDIA_TRIGGERS = ["video.generated", "image.generated"]

export interface MarketingReviewSnapshot {
  drafts: Array<{
    id:               string
    channel:          string
    draft_subject:    string | null
    draft_body:       string
    contact_name:     string | null
    contact_id:       string | null
    trigger_event:    string | null
    context_summary:  string | null
    created_at:       string
  }>
  socialPosts: Array<{
    id:             string
    platform:       string
    content:        string | null
    media_urls:     string[]
    listing_id:     string | null
    status:         string
    scheduled_for:  string | null
    created_at:     string
  }>
  pendingMedia: Array<{
    id:            string
    listing_id:    string
    listing_label: string | null
    media_type:    string
    file_url:      string
    thumbnail_url: string | null
    created_at:    string
  }>
  recentQrCodes: Array<{
    id:           string
    label:        string
    slug:         string
    target_url:   string
    purpose:      string
    listing_id:   string | null
    scan_count:   number
    created_at:   string
  }>
}

export async function loadMarketingReview(params: {
  brokerageId: string
  agentUserId: string | null
  isAgentScope: boolean
}): Promise<MarketingReviewSnapshot> {
  const svc = createServiceClient()
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString()

  // 1. AI message drafts from media events
  let draftsQuery = svc
    .from("ai_message_drafts")
    .select(`
      id, channel, draft_subject, draft_body, context_summary,
      trigger_event, created_at, contact_id, agent_user_id,
      contacts!contact_id(first_name, last_name)
    `)
    .eq("brokerage_id", params.brokerageId)
    .eq("status", "pending")
    .in("trigger_event", MEDIA_TRIGGERS)
    .order("created_at", { ascending: false })
    .limit(30)
  if (params.isAgentScope && params.agentUserId) {
    draftsQuery = draftsQuery.eq("agent_user_id", params.agentUserId)
  }

  // 2. Social posts: AI-generated + unfinalised. social_posts.status CHECK
  // only allows {draft, scheduled, publishing, published, failed, cancelled},
  // so we filter to the two states the agent can still act on.
  let socialQuery = svc
    .from("social_posts")
    .select(`
      id, platform, content, media_urls, listing_id, status,
      scheduled_for, created_at, user_id, ai_generated
    `)
    .eq("brokerage_id", params.brokerageId)
    .eq("ai_generated", true)
    .in("status", ["scheduled", "draft"])
    .order("created_at", { ascending: false })
    .limit(30)
  if (params.isAgentScope && params.agentUserId) {
    socialQuery = socialQuery.eq("user_id", params.agentUserId)
  }

  // 3. Listing media awaiting approval — joined to listings for the address
  let mediaQuery = svc
    .from("listing_media")
    .select(`
      id, listing_id, media_type, file_url, thumbnail_url, created_at,
      listings!listing_id(address, agent_id)
    `)
    .eq("brokerage_id", params.brokerageId)
    .eq("approval_required", true)
    .eq("is_approved", false)
    .order("created_at", { ascending: false })
    .limit(30)

  // 4. Recently minted QR codes (listings, opens, events). agent scope handled below
  let qrQuery = svc
    .from("qr_codes")
    .select("id, label, slug, target_url, purpose, listing_id, scan_count, created_at, agent_id")
    .eq("brokerage_id", params.brokerageId)
    .gte("created_at", since7d)
    .order("created_at", { ascending: false })
    .limit(20)

  const [draftsRes, socialRes, mediaRes, qrRes, agentRowRes] = await Promise.all([
    draftsQuery,
    socialQuery,
    mediaQuery,
    qrQuery,
    // resolve agents.id once for QR scoping (qr_codes.agent_id references agents.id, not users.id)
    params.isAgentScope && params.agentUserId
      ? svc.from("agents").select("id").eq("user_id", params.agentUserId).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const agentRowId = (agentRowRes as { data: { id: string } | null }).data?.id ?? null

  const drafts = (draftsRes.data ?? []).map((d: any) => ({
    id:              d.id,
    channel:         d.channel,
    draft_subject:   d.draft_subject ?? null,
    draft_body:      d.draft_body ?? "",
    trigger_event:   d.trigger_event ?? null,
    context_summary: d.context_summary ?? null,
    created_at:      d.created_at,
    contact_id:      d.contact_id ?? null,
    contact_name: d.contacts
      ? `${d.contacts.first_name ?? ""} ${d.contacts.last_name ?? ""}`.trim() || null
      : null,
  }))

  const socialPosts = (socialRes.data ?? []).map((p: any) => ({
    id:            p.id,
    platform:      p.platform,
    content:       p.content ?? null,
    media_urls:    (p.media_urls ?? []) as string[],
    listing_id:    p.listing_id ?? null,
    status:        p.status,
    scheduled_for: p.scheduled_for ?? null,
    created_at:    p.created_at,
  }))

  const pendingMedia = (mediaRes.data ?? [])
    .filter((m: any) => {
      // Agent scope: only listing media for listings owned by this agent's
      // agents.id row. listings.agent_id FKs agents(id), so match against agentRowId.
      if (!params.isAgentScope) return true
      return agentRowId !== null && m.listings?.agent_id === agentRowId
    })
    .map((m: any) => ({
      id:            m.id,
      listing_id:    m.listing_id,
      listing_label: m.listings?.address ?? null,
      media_type:    m.media_type,
      file_url:      m.file_url,
      thumbnail_url: m.thumbnail_url ?? null,
      created_at:    m.created_at,
    }))

  const recentQrCodes = (qrRes.data ?? [])
    .filter((q: any) => !params.isAgentScope || q.agent_id === agentRowId)
    .map((q: any) => ({
      id:         q.id,
      label:      q.label,
      slug:       q.slug,
      target_url: q.target_url,
      purpose:    q.purpose,
      listing_id: q.listing_id ?? null,
      scan_count: q.scan_count ?? 0,
      created_at: q.created_at,
    }))

  return { drafts, socialPosts, pendingMedia, recentQrCodes }
}

/**
 * Mark an AI message draft as dismissed. The CHECK constraint on
 * ai_message_drafts.status only allows {pending, accepted, edited, dismissed,
 * sent}, so we always use 'dismissed' here — not 'rejected'.
 */
export async function dismissDraft(draftId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { error } = await svc
    .from("ai_message_drafts")
    .update({ status: "dismissed", acted_at: new Date().toISOString() })
    .eq("id", draftId)
    .eq("status", "pending")
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/**
 * Cancel an auto-drafted social post the agent decided not to publish.
 * social_posts.status CHECK allows: scheduled/publishing/published/failed/
 * cancelled/draft (or similar — verified against the live schema). We use
 * 'cancelled' which is the canonical "agent chose not to send" state.
 */
export async function cancelSocialPost(postId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { error } = await svc
    .from("social_posts")
    .update({ status: "cancelled" })
    .eq("id", postId)
    .in("status", ["scheduled", "draft"])
  if (error) return { success: false, error: error.message }
  return { success: true }
}
