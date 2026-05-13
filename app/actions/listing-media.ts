"use server"

import { createClient } from "@/lib/supabase/server"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel"

// ─────────────────────────────────────────────────────────────
// LISTING MEDIA
// ─────────────────────────────────────────────────────────────

export async function getListingMedia(listingId: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("listing_media")
    .select("*")
    .eq("listing_id", listingId)
    .order("sort_order", { ascending: true })
  if (error) return { data: null, error: error.message }
  return { data, error: null }
}

export async function uploadListingMedia(params: {
  listingId: string
  brokerageId: string
  mediaType: "photo" | "video" | "floor_plan" | "virtual_tour" | "document"
  fileUrl: string
  thumbnailUrl?: string
  caption?: string
  altText?: string
  tags?: string[]
  isPrimary?: boolean
  approvalRequired?: boolean
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: "Not authenticated" }

  const { data, error } = await supabase
    .from("listing_media")
    .insert({
      listing_id:         params.listingId,
      brokerage_id:       params.brokerageId,
      media_type:         params.mediaType,
      file_url:           params.fileUrl,
      thumbnail_url:      params.thumbnailUrl ?? null,
      caption:            params.caption ?? null,
      alt_text:           params.altText ?? null,
      tags:               params.tags ?? [],
      is_primary:         params.isPrimary ?? false,
      approval_required:  params.approvalRequired ?? true,
      is_approved:        false,
      kernel_compliance_passed: false,
      uploaded_by:        user.id,
      sort_order:         0,
    })
    .select("id")
    .single()

  if (error) return { data: null, error: error.message }

  // Run brand compliance check immediately after upload
  const compliance = await checkBrandCompliance({
    contentType: "listing_media",
    contentId:   data.id,
    brokerageId: params.brokerageId,
  })

  return { data: { ...data, compliance }, error: null }
}

export async function approveListingMedia(mediaId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const { error } = await supabase
    .from("listing_media")
    .update({
      is_approved:  true,
      approved_by:  user.id,
      approved_at:  new Date().toISOString(),
      rejection_notes: null,
    })
    .eq("id", mediaId)

  return error ? { success: false, error: error.message } : { success: true }
}

export async function rejectListingMedia(mediaId: string, notes: string) {
  const supabase = await createClient()
  const { error } = await supabase
    .from("listing_media")
    .update({ is_approved: false, rejection_notes: notes })
    .eq("id", mediaId)
  return error ? { success: false, error: error.message } : { success: true }
}

export async function deleteListingMedia(mediaId: string) {
  const supabase = await createClient()
  const { error } = await supabase
    .from("listing_media")
    .delete()
    .eq("id", mediaId)
  return error ? { success: false, error: error.message } : { success: true }
}

export async function setPrimaryMedia(mediaId: string, listingId: string) {
  const supabase = await createClient()
  // Clear existing primary
  await supabase
    .from("listing_media")
    .update({ is_primary: false })
    .eq("listing_id", listingId)
  // Set new primary
  const { error } = await supabase
    .from("listing_media")
    .update({ is_primary: true })
    .eq("id", mediaId)
  return error ? { success: false, error: error.message } : { success: true }
}

export async function runComplianceCheck(mediaId: string, brokerageId: string) {
  const result = await checkBrandCompliance({
    contentType: "listing_media",
    contentId:   mediaId,
    brokerageId,
  })
  return result
}

// ─────────────────────────────────────────────────────────────
// AI VIDEO PROJECTS
// ─────────────────────────────────────────────────────────────

export async function getVideoProjects(listingId: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("ai_video_projects")
    .select("*")
    .eq("listing_id", listingId)
    .order("created_at", { ascending: false })
  return error ? { data: null, error: error.message } : { data, error: null }
}

export async function getVideoTemplates() {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("video_templates")
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
  return error ? { data: null, error: error.message } : { data, error: null }
}

export async function createVideoProject(params: {
  listingId: string
  brokerageId: string
  title: string
  scriptContent: string
  videoType: string
  templateId?: string
  heygenAvatarId?: string
  heygenVoiceId?: string
  heygenTemplateId?: string
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: "Not authenticated" }

  // Resolve agent record for agent_id (NOT NULL)
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!agent?.id) return { data: null, error: "No agent record found" }

  // Migration 1052: resolve the actual provider (D-ID default, with agent
  // + brokerage overrides). Listing videos are customer-facing by default
  // and must pass compliance at distribute time.
  const { resolveVideoProvider, initialProviderColumns } = await import("@/lib/marketing/video-provider-resolver")
  const provider = await resolveVideoProvider(supabase, {
    brokerageId: params.brokerageId,
    agentUserId: user.id,
  })
  const providerCols = initialProviderColumns(provider)

  const { data, error } = await supabase
    .from("ai_video_projects")
    .insert({
      listing_id:          params.listingId,
      brokerage_id:        params.brokerageId,
      agent_id:            agent.id,
      title:               params.title,
      script_content:      params.scriptContent,
      video_type:          params.videoType,
      video_provider:      provider,
      ...providerCols,
      status:              "planning",
      audience_type:       "customer_facing",
      heygen_avatar_id:    params.heygenAvatarId ?? null,
      heygen_voice_id:     params.heygenVoiceId ?? null,
      heygen_template_id:  params.heygenTemplateId ?? null,
    })
    .select("id")
    .single()

  if (error) return { data: null, error: error.message }

  // Emit brand compliance check
  await checkBrandCompliance({
    contentType: "video",
    contentId:   data.id,
    brokerageId: params.brokerageId,
  })

  return { data, error: null }
}

export async function deleteVideoProject(projectId: string) {
  const supabase = await createClient()
  const { error } = await supabase
    .from("ai_video_projects")
    .delete()
    .eq("id", projectId)
  return error ? { success: false, error: error.message } : { success: true }
}

// ─────────────────────────────────────────────────────────────
// SOCIAL POSTS
// ─────────────────────────────────────────────────────────────

export async function getSocialPosts(listingId: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("social_posts")
    .select("*")
    .eq("listing_id", listingId)
    .order("created_at", { ascending: false })
  return error ? { data: null, error: error.message } : { data, error: null }
}

export async function getSocialAccounts(brokerageId: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("social_media_accounts")
    .select("id, platform, account_name, is_active, scope")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .order("platform")
  return error ? { data: null, error: error.message } : { data, error: null }
}

export async function createSocialPost(params: {
  listingId: string
  brokerageId: string
  platform: string
  postType: string
  content: string
  hashtags?: string[]
  mediaUrls?: string[]
  scheduledFor?: string
  socialAccountId?: string
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: "Not authenticated" }

  // Resolve agent_id
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  const { data, error } = await supabase
    .from("social_posts")
    .insert({
      listing_id:          params.listingId,
      brokerage_id:        params.brokerageId,
      user_id:             user.id,
      agent_id:            agent?.id ?? null,
      platform:            params.platform,
      post_type:           params.postType,
      content:             params.content,
      hashtags:            params.hashtags ?? [],
      media_urls:          params.mediaUrls ?? [],
      scheduled_for:       params.scheduledFor ?? null,
      social_account_id:   params.socialAccountId ?? null,
      status:              params.scheduledFor ? "scheduled" : "draft",
      approval_status:     "pending",
      brand_compliance_passed: false,
    })
    .select("id")
    .single()

  if (error) return { data: null, error: error.message }

  // Run compliance check
  await checkBrandCompliance({
    contentType: "social_post",
    contentId:   data.id,
    brokerageId: params.brokerageId,
  })

  return { data, error: null }
}

export async function approveSocialPost(postId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const { error } = await supabase
    .from("social_posts")
    .update({
      approval_status: "approved",
      approved_by:     user.id,
      approved_at:     new Date().toISOString(),
    })
    .eq("id", postId)

  return error ? { success: false, error: error.message } : { success: true }
}

export async function deleteSocialPost(postId: string) {
  const supabase = await createClient()
  const { error } = await supabase
    .from("social_posts")
    .delete()
    .eq("id", postId)
  return error ? { success: false, error: error.message } : { success: true }
}
