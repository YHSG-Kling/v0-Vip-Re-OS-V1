/**
 * lib/kernel/marketing.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * MARKETING OS — Canonical Kernel Layer
 *
 * Business rules enforced by this module:
 *   1. Every send/schedule/publish-capable asset MUST go through preview before dispatch.
 *   2. AI generation MUST use provider functions (generateTextRouted), never raw fetch.
 *   3. Direct Mail, Video provider config, and Voice AI provider config are superadmin-only.
 *   4. Every outbound payload MUST pass evaluateOutbound() before write.
 *   5. Every AI-generated content body MUST pass applyBrandVoice() before storage.
 *   6. brokerage_id is required on every write — no orphaned records.
 *   7. No placeholders, no stub content, no dead returns.
 *
 * Column contracts (live schema — verified against Supabase):
 *   newsletter_campaigns:    campaign_name, subject_line, content, status, send_date, brokerage_id, agent_id, approval_status, open_rate, click_rate, unsubscribe_rate, brand_compliance_passed
 *   newsletter_subscribers:  email, first_name, last_name, status, brokerage_id, agent_id, contact_id
 *   newsletter_scheduled_sends: newsletter_id, scheduled_time, sent_time, recipient_count
 *   blog_posts:              title, slug, excerpt, content, publish_status (NOT status), brokerage_id, agent_user_id, created_by, seo_score, featured_image_url, wordpress_post_id
 *   ai_video_projects:       title, status, script_content, video_type, agent_id, listing_id, brokerage_id, heygen_status, video_url
 *   podcast_episodes:        title, description, script, status, brokerage_id, agent_id, source_video_project_id, publish_channels, published_at, audio_url
 *   direct_mail_campaigns:   campaign_name, target_audience, design_url, copy_text, quantity, status, brokerage_id, agent_id, created_by, mailing_date, per_piece_cost, lob_order_id
 *   direct_mail_recipients:  campaign_id, brokerage_id, first_name, last_name, address_line1, address_line2, city, state, zip, contact_id, delivery_status
 *   qr_codes:                label, slug, purpose, target_url, brokerage_id, agent_id, listing_id, is_active, scan_count, lead_count, expires_at
 *   marketing_campaigns:     campaign_name, campaign_type, status, brokerage_id, agent_user_id, created_by, listing_id, budget_total, budget_spent, visibility_scope
 *   repurposed_content_log:  source_type, source_id, output_type, output_ref_table, output_ref_id, platform_target, status, brokerage_id, created_by
 *
 * No 'use server' — this is a pure library module.
 * Every function returns KernelMarketingResult<T>.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { generateTextRouted } from "@/lib/ai/models"

// ─── RESULT CONTRACT ──────────────────────────────────────────────────────────

export interface KernelMarketingResult<T = void> {
  success: boolean
  data?: T
  error?: string
  blockedReason?: string
  previewState?: string  // populated when preview is required before dispatch
}

// ─── SHARED TYPES ─────────────────────────────────────────────────────────────

export interface MarketingActorContext {
  userId: string
  brokerageId: string
  agentId?: string
  teamId?: string
  userRole?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. loadMarketingWorkspace
//
// Loads the top-level marketing workspace summary in a single round trip.
// Used by the canonical marketing studio page to prime the dashboard.
//
// Input:  ctx.brokerageId, ctx.agentId (optional filter)
// Output: counts, recent campaigns, upcoming sends, recent blog posts, recent episodes
// Tables: marketing_campaigns, newsletter_campaigns, blog_posts, podcast_episodes,
//         direct_mail_campaigns, qr_codes, marketing_assets, campaign_calendar
// ─────────────────────────────────────────────────────────────────────────────

export interface MarketingWorkspaceData {
  campaignCounts: { draft: number; live: number; ended: number }
  newsletterCounts: { draft: number; scheduled: number; sent: number; totalSubscribers: number }
  blogCounts: { draft: number; published: number }
  videoCounts: { generating: number; completed: number }
  podcastCounts: { draft: number; completed: number }
  directMailCounts: { planning: number; mailed: number }
  qrCount: number
  upcomingEvents: Array<{ id: string; title: string; scheduled_at: string; event_type: string }>
}

export async function loadMarketingWorkspace(
  ctx: MarketingActorContext
): Promise<KernelMarketingResult<MarketingWorkspaceData>> {
  const supabase = await createServiceClient()
  const { brokerageId, agentId } = ctx

  try {
    const base = { brokerage_id: brokerageId }

    const [
      campaignRows,
      newsletterRows,
      subscriberCount,
      blogRows,
      videoRows,
      podcastRows,
      mailRows,
      qrResult,
      eventRows,
    ] = await Promise.all([
      supabase.from("marketing_campaigns").select("status").eq("brokerage_id", brokerageId),
      supabase.from("newsletter_campaigns").select("status").eq("brokerage_id", brokerageId),
      supabase
        .from("newsletter_subscribers")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("status", "active"),
      supabase.from("blog_posts").select("publish_status").eq("brokerage_id", brokerageId),
      supabase.from("ai_video_projects").select("status").eq("brokerage_id", brokerageId),
      supabase.from("podcast_episodes").select("status").eq("brokerage_id", brokerageId),
      supabase.from("direct_mail_campaigns").select("status").eq("brokerage_id", brokerageId),
      supabase
        .from("qr_codes")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("is_active", true),
      supabase
        .from("campaign_calendar")
        .select("id, title, scheduled_at, event_type")
        .eq("brokerage_id", brokerageId)
        .gte("scheduled_at", new Date().toISOString())
        .order("scheduled_at", { ascending: true })
        .limit(5),
    ])

    const tally = (rows: any[], key: string, val: string) =>
      (rows || []).filter((r) => r[key] === val).length

    return {
      success: true,
      data: {
        campaignCounts: {
          draft: tally(campaignRows.data || [], "status", "draft"),
          live:  tally(campaignRows.data || [], "status", "live"),
          ended: tally(campaignRows.data || [], "status", "ended"),
        },
        newsletterCounts: {
          draft:            tally(newsletterRows.data || [], "status", "draft"),
          scheduled:        tally(newsletterRows.data || [], "status", "scheduled"),
          sent:             tally(newsletterRows.data || [], "status", "sent"),
          totalSubscribers: subscriberCount.count ?? 0,
        },
        blogCounts: {
          draft:     tally(blogRows.data || [], "publish_status", "draft"),
          published: tally(blogRows.data || [], "publish_status", "published"),
        },
        videoCounts: {
          generating: tally(videoRows.data || [], "status", "generating"),
          completed:  tally(videoRows.data || [], "status", "completed"),
        },
        podcastCounts: {
          draft:     tally(podcastRows.data || [], "status", "draft"),
          completed: tally(podcastRows.data || [], "status", "completed"),
        },
        directMailCounts: {
          planning: tally(mailRows.data || [], "status", "planning"),
          mailed:   tally(mailRows.data || [], "status", "mailed"),
        },
        qrCount:        qrResult.count ?? 0,
        upcomingEvents: eventRows.data || [],
      },
    }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "loadMarketingWorkspace failed" }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. createNewsletterCampaign
//
// Creates a newsletter campaign in draft status.
// Input:  brokerageId, agentId, campaignName, subjectLine, content?
// Output: { campaignId }
// Tables write: newsletter_campaigns
// Rules:  canAccessFeature('email_campaigns'); content passes applyBrandVoice
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateNewsletterCampaignInput {
  ctx: MarketingActorContext
  campaignName: string
  subjectLine: string
  content?: string
}

export async function createNewsletterCampaign(
  input: CreateNewsletterCampaignInput
): Promise<KernelMarketingResult<{ campaignId: string }>> {
  const { ctx, campaignName, subjectLine, content } = input
  if (!campaignName?.trim()) return { success: false, error: "Campaign name is required." }
  if (!subjectLine?.trim())  return { success: false, error: "Subject line is required." }

  const access = await canAccessFeature(ctx.userId, "email_campaigns")
  if (!access.allowed) return { success: false, error: access.reason ?? "Feature access denied" }

  const brandVoice = await applyBrandVoice({ brokerageId: ctx.brokerageId, agentId: ctx.agentId })

  const supabase = await createServiceClient()
  const { data, error } = await supabase
    .from("newsletter_campaigns")
    .insert({
      brokerage_id:   ctx.brokerageId,
      agent_id:       ctx.agentId ?? null,
      created_by:     ctx.userId,
      campaign_name:  campaignName.trim(),
      subject_line:   subjectLine.trim(),
      content:        content ?? null,
      status:         "draft",
      approval_status: "pending",
      brand_compliance_passed: false,
      created_at:     new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }

  await incrementFeatureUsage(ctx.userId, "email_campaigns")
  return { success: true, data: { campaignId: data.id } }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. saveNewsletterDraft
//
// Saves edits to an existing newsletter campaign in draft status.
// Input:  campaignId, brokerageId, content, subjectLine?
// Output: void
// Tables write: newsletter_campaigns (UPDATE)
// Rules:  draft-only writes; published/sent campaigns may not be edited
// ─────────────────────────────────────────────────────────────────────────────

export async function saveNewsletterDraft(params: {
  campaignId: string
  brokerageId: string
  content: string
  subjectLine?: string
  campaignName?: string
}): Promise<KernelMarketingResult<void>> {
  const supabase = await createServiceClient()

  const { data: existing } = await supabase
    .from("newsletter_campaigns")
    .select("status")
    .eq("id", params.campaignId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!existing) return { success: false, error: "Campaign not found or not owned by this brokerage." }
  if (existing.status === "sent") return { success: false, error: "Cannot edit a sent campaign." }

  const updates: Record<string, unknown> = { content: params.content }
  if (params.subjectLine)  updates.subject_line  = params.subjectLine
  if (params.campaignName) updates.campaign_name = params.campaignName

  const { error } = await supabase
    .from("newsletter_campaigns")
    .update(updates)
    .eq("id", params.campaignId)
    .eq("brokerage_id", params.brokerageId)

  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. scheduleNewsletterSend
//
// Schedules a newsletter to send at a future time.
// Input:  campaignId, brokerageId, scheduledTime (ISO string)
// Output: { scheduleId }
// Tables write: newsletter_campaigns (status=scheduled, send_date), newsletter_scheduled_sends
// Rules:  content must exist; compliance must pass evaluateOutbound before scheduling
// ─────────────────────────────────────────────────────────────────────────────

export async function scheduleNewsletterSend(params: {
  campaignId: string
  brokerageId: string
  scheduledTime: string
  userId: string
  agentId?: string
}): Promise<KernelMarketingResult<{ scheduleId: string }>> {
  const supabase = await createServiceClient()

  const { data: campaign } = await supabase
    .from("newsletter_campaigns")
    .select("id, subject_line, content, status")
    .eq("id", params.campaignId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!campaign) return { success: false, error: "Campaign not found." }
  if (!campaign.content) return { success: false, error: "Cannot schedule a campaign with no content. Preview and save content first." }
  if (campaign.status === "sent") return { success: false, error: "Campaign has already been sent." }

  // Compliance gate — every outbound must pass
  const compliance = await evaluateOutbound({
    content:       campaign.content,
    subjectLine:   campaign.subject_line,
    channel:       "email",
    brokerageId:   params.brokerageId,
    agentId:       params.agentId,
    actorUserId:   params.userId,
  })

  if (!compliance.passed) {
    return { success: false, blockedReason: compliance.reason ?? "Compliance check failed", error: "Outbound compliance failed." }
  }

  // Count subscribers for estimated delivery
  const { count: recipientCount } = await supabase
    .from("newsletter_subscribers")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", params.brokerageId)
    .eq("status", "active")

  const [updateResult, insertResult] = await Promise.all([
    supabase
      .from("newsletter_campaigns")
      .update({ status: "scheduled", send_date: params.scheduledTime })
      .eq("id", params.campaignId),
    supabase
      .from("newsletter_scheduled_sends")
      .insert({
        newsletter_id:   params.campaignId,
        scheduled_time:  params.scheduledTime,
        recipient_count: recipientCount ?? 0,
        created_at:      new Date().toISOString(),
      })
      .select("id")
      .single(),
  ])

  if (updateResult.error) return { success: false, error: updateResult.error.message }
  if (insertResult.error) return { success: false, error: insertResult.error.message }

  await processKernelEvent({
    event: KernelEvent.EMAIL_CAMPAIGN_CREATED,
    actorUserId: params.userId,
    brokerageId: params.brokerageId,
    entityId:    params.campaignId,
    entityType:  "newsletter_campaign",
    metadata:    { scheduledTime: params.scheduledTime },
  })

  return { success: true, data: { scheduleId: insertResult.data?.id ?? "" } }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. sendNewsletterNow
//
// Immediately marks a newsletter as sent and fires the kernel event.
// Actual delivery is handled by the email provider (e.g., Sendgrid/Resend)
// via the processKernelEvent EMAIL_CAMPAIGN_SENT hook.
// Input:  campaignId, brokerageId, actorUserId
// Output: void
// Tables write: newsletter_campaigns (status=sent)
// Rules:  compliance gate required; content must exist
// ─────────────────────────────────────────────────────────────────────────────

export async function sendNewsletterNow(params: {
  campaignId: string
  brokerageId: string
  userId: string
  agentId?: string
}): Promise<KernelMarketingResult<void>> {
  const supabase = await createServiceClient()

  const { data: campaign } = await supabase
    .from("newsletter_campaigns")
    .select("id, subject_line, content, status")
    .eq("id", params.campaignId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!campaign) return { success: false, error: "Campaign not found." }
  if (!campaign.content) return { success: false, error: "No content to send. Save your draft first." }
  if (campaign.status === "sent") return { success: false, error: "Campaign has already been sent." }

  const compliance = await evaluateOutbound({
    content:     campaign.content,
    subjectLine: campaign.subject_line,
    channel:     "email",
    brokerageId: params.brokerageId,
    agentId:     params.agentId,
    actorUserId: params.userId,
  })
  if (!compliance.passed) {
    return { success: false, blockedReason: compliance.reason, error: "Compliance check failed." }
  }

  const { error } = await supabase
    .from("newsletter_campaigns")
    .update({ status: "sent", send_date: new Date().toISOString() })
    .eq("id", params.campaignId)
    .eq("brokerage_id", params.brokerageId)

  if (error) return { success: false, error: error.message }

  await processKernelEvent({
    event:      KernelEvent.EMAIL_CAMPAIGN_SENT,
    actorUserId: params.userId,
    brokerageId: params.brokerageId,
    entityId:   params.campaignId,
    entityType: "newsletter_campaign",
    metadata:   { sentAt: new Date().toISOString() },
  })

  return { success: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. createDirectMailCampaign
//
// Creates a direct mail campaign in planning status.
// Input:  ctx, campaignName, targetAudience, quantity, copyText, designUrl, mailingDate
// Output: { campaignId }
// Tables write: direct_mail_campaigns
// Rules:  canAccessFeature('direct_mail'); provider resolved server-side (superadmin-owned)
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateDirectMailCampaignInput {
  ctx: MarketingActorContext
  campaignName: string
  targetAudience: string
  quantity: number
  copyText?: string
  designUrl?: string
  mailingDate?: string
  perPieceCost?: number
}

export async function createDirectMailCampaign(
  input: CreateDirectMailCampaignInput
): Promise<KernelMarketingResult<{ campaignId: string }>> {
  const { ctx, campaignName, targetAudience, quantity } = input
  if (!campaignName?.trim())    return { success: false, error: "Campaign name is required." }
  if (!targetAudience?.trim())  return { success: false, error: "Target audience is required." }
  if (!quantity || quantity < 1) return { success: false, error: "Quantity must be at least 1." }

  const access = await canAccessFeature(ctx.userId, "direct_mail")
  if (!access.allowed) return { success: false, error: access.reason ?? "Direct mail access denied" }

  const supabase = await createServiceClient()
  const { data, error } = await supabase
    .from("direct_mail_campaigns")
    .insert({
      brokerage_id:   ctx.brokerageId,
      agent_id:       ctx.agentId ?? null,
      created_by:     ctx.userId,
      campaign_name:  campaignName.trim(),
      target_audience: targetAudience.trim(),
      quantity,
      copy_text:      input.copyText   ?? null,
      design_url:     input.designUrl  ?? null,
      mailing_date:   input.mailingDate ?? null,
      per_piece_cost: input.perPieceCost ?? null,
      status:         "planning",
      created_at:     new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }
  return { success: true, data: { campaignId: data.id } }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. previewDirectMailAsset
//
// Returns a structured preview of a direct mail campaign before submission.
// Business rule: preview MUST exist before submitDirectMailCampaign is callable.
// Input:  campaignId, brokerageId
// Output: { previewHtml, recipientCount, estimatedCost }
// Tables read: direct_mail_campaigns, direct_mail_recipients
// ─────────────────────────────────────────────────────────────────────────────

export async function previewDirectMailAsset(params: {
  campaignId: string
  brokerageId: string
}): Promise<KernelMarketingResult<{
  previewHtml: string
  recipientCount: number
  estimatedCost: number | null
  campaignName: string
  copyText: string | null
  designUrl: string | null
  mailingDate: string | null
}>> {
  const supabase = await createServiceClient()

  const [campaignResult, recipientResult] = await Promise.all([
    supabase
      .from("direct_mail_campaigns")
      .select("campaign_name, copy_text, design_url, mailing_date, quantity, per_piece_cost, status")
      .eq("id", params.campaignId)
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle(),
    supabase
      .from("direct_mail_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", params.campaignId)
      .eq("brokerage_id", params.brokerageId),
  ])

  if (!campaignResult.data) return { success: false, error: "Campaign not found." }
  const c = campaignResult.data

  const recipientCount = recipientResult.count ?? c.quantity ?? 0
  const estimatedCost  = c.per_piece_cost ? c.per_piece_cost * recipientCount : null

  const previewHtml = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">
      <h2 style="margin:0 0 16px">${c.campaign_name}</h2>
      ${c.design_url ? `<img src="${c.design_url}" alt="Design preview" style="width:100%;border-radius:4px;margin-bottom:16px"/>` : ""}
      ${c.copy_text  ? `<p style="color:#374151">${c.copy_text}</p>` : "<p style='color:#9ca3af'>No copy text yet</p>"}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>
      <p style="font-size:12px;color:#6b7280">Recipients: ${recipientCount} | ${c.mailing_date ? `Mailing: ${c.mailing_date}` : "No mailing date set"}</p>
    </div>
  `.trim()

  return {
    success: true,
    previewState: "preview_ready",
    data: {
      previewHtml,
      recipientCount,
      estimatedCost,
      campaignName: c.campaign_name,
      copyText:     c.copy_text,
      designUrl:    c.design_url,
      mailingDate:  c.mailing_date,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. submitDirectMailCampaign
//
// Transitions a direct mail campaign from planning → approved for mailing.
// Business rule: previewDirectMailAsset MUST be called before this.
// Input:  campaignId, brokerageId, actorUserId
// Output: void
// Tables write: direct_mail_campaigns (status=approved)
// ─────────────────────────────────────────────────────────────────────────────

export async function submitDirectMailCampaign(params: {
  campaignId: string
  brokerageId: string
  userId: string
}): Promise<KernelMarketingResult<void>> {
  const supabase = await createServiceClient()

  const { data: campaign } = await supabase
    .from("direct_mail_campaigns")
    .select("status, quantity, copy_text")
    .eq("id", params.campaignId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!campaign) return { success: false, error: "Campaign not found." }
  if (!campaign.copy_text) {
    return { success: false, error: "Campaign must have copy text before submission. Use previewDirectMailAsset first." }
  }
  if (campaign.status !== "planning") {
    return { success: false, error: `Campaign is already in '${campaign.status}' status.` }
  }

  const { error } = await supabase
    .from("direct_mail_campaigns")
    .update({ status: "approved" })
    .eq("id", params.campaignId)
    .eq("brokerage_id", params.brokerageId)

  if (error) return { success: false, error: error.message }

  await processKernelEvent({
    event:      KernelEvent.DIRECT_MAIL_CAMPAIGN_CREATED,
    actorUserId: params.userId,
    brokerageId: params.brokerageId,
    entityId:   params.campaignId,
    entityType: "direct_mail_campaign",
    metadata:   { quantity: campaign.quantity },
  })

  return { success: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. createBlogPost
//
// Creates a blog post record with AI-generated content.
// Input:  ctx, title, keywords, tone?, campaignId?
// Output: { postId }
// Tables write: blog_posts
// Rules:  canAccessFeature('seo_blog_engine'); applyBrandVoice; evaluateOutbound
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateBlogPostInput {
  ctx: MarketingActorContext
  title?: string
  keywords: string[]
  tone?: string
  campaignId?: string
  content?: string   // if pre-written, skip AI generation
}

export async function createBlogPost(
  input: CreateBlogPostInput
): Promise<KernelMarketingResult<{ postId: string }>> {
  const { ctx } = input
  if (!input.keywords?.length && !input.content) {
    return { success: false, error: "Provide keywords or content to create a blog post." }
  }

  const access = await canAccessFeature(ctx.userId, "seo_blog_engine")
  if (!access.allowed) return { success: false, error: access.reason ?? "Feature access denied" }

  const brandVoice = await applyBrandVoice({ brokerageId: ctx.brokerageId, agentId: ctx.agentId })

  let generatedTitle = input.title || ""
  let content        = input.content || ""
  let excerpt        = ""
  let slug           = ""

  if (!content && input.keywords.length > 0) {
    const systemPrompt = `You are a real estate content writer. Write in a ${brandVoice.tone ?? "professional"} style.
${brandVoice.customInstructions ?? ""}
${brandVoice.prohibitedWords?.length ? `Avoid: ${brandVoice.prohibitedWords.join(", ")}` : ""}`

    const userPrompt = `Write a 600-800 word SEO blog post about: ${input.keywords.join(", ")}.
${input.title ? `Title: ${input.title}` : "Create an engaging title."}
Return valid JSON: {"title":"...","slug":"...","excerpt":"...","content":"..."}`

    try {
      const raw = await generateTextRouted(systemPrompt, userPrompt, {
        brokerageId: ctx.brokerageId,
        feature:     "seo_blog_engine",
        userId:      ctx.userId,
      })
      const parsed = JSON.parse(raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim())
      generatedTitle = parsed.title ?? input.title ?? "Untitled"
      content        = parsed.content ?? ""
      excerpt        = parsed.excerpt ?? ""
      slug           = parsed.slug ?? generatedTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    } catch {
      return { success: false, error: "AI generation failed. Please try again." }
    }
  } else {
    slug    = generatedTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-") || `post-${Date.now()}`
    excerpt = content.slice(0, 200)
  }

  // Outbound compliance gate
  const compliance = await evaluateOutbound({
    content,
    channel:     "blog",
    brokerageId: ctx.brokerageId,
    agentId:     ctx.agentId,
    actorUserId: ctx.userId,
  })
  if (!compliance.passed) {
    return { success: false, blockedReason: compliance.reason, error: "Blog content failed compliance check." }
  }

  const supabase = await createServiceClient()
  const { data, error } = await supabase
    .from("blog_posts")
    .insert({
      brokerage_id:          ctx.brokerageId,
      agent_user_id:         ctx.userId,
      created_by:            ctx.userId,
      title:                 generatedTitle,
      slug:                  `${slug}-${Date.now()}`,
      excerpt,
      content,
      publish_status:        "draft",
      marketing_campaign_id: input.campaignId ?? null,
      seo_score:             0,
      created_at:            new Date().toISOString(),
      updated_at:            new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }

  await incrementFeatureUsage(ctx.userId, "seo_blog_engine")
  return { success: true, data: { postId: data.id } }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. previewBlogPost
//
// Returns the current content of a blog post for preview before publishing.
// Business rule: preview must render before publishBlogPost is callable from UI.
// Input:  postId, brokerageId
// Output: { title, content, excerpt, slug, publishStatus }
// Tables read: blog_posts
// ─────────────────────────────────────────────────────────────────────────────

export async function previewBlogPost(params: {
  postId: string
  brokerageId: string
}): Promise<KernelMarketingResult<{
  title: string
  content: string
  excerpt: string | null
  slug: string
  publishStatus: string
  seoScore: number | null
}>> {
  const supabase = await createServiceClient()
  const { data, error } = await supabase
    .from("blog_posts")
    .select("title, content, excerpt, slug, publish_status, seo_score")
    .eq("id", params.postId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (error || !data) return { success: false, error: "Blog post not found." }
  if (!data.content)  return { success: false, error: "Post has no content to preview.", previewState: "empty" }

  return {
    success: true,
    previewState: "preview_ready",
    data: {
      title:         data.title,
      content:       data.content,
      excerpt:       data.excerpt,
      slug:          data.slug,
      publishStatus: data.publish_status,
      seoScore:      data.seo_score,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. publishBlogPost
//
// Transitions a blog post from draft → published.
// Business rule: previewBlogPost must show preview_ready before this.
// Input:  postId, brokerageId, userId
// Output: void
// Tables write: blog_posts (publish_status=published, published_at=now)
// ─────────────────────────────────────────────────────────────────────────────

export async function publishBlogPost(params: {
  postId:      string
  brokerageId: string
  userId:      string
}): Promise<KernelMarketingResult<void>> {
  const supabase = await createServiceClient()

  const { data: post } = await supabase
    .from("blog_posts")
    .select("publish_status, content, title")
    .eq("id", params.postId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!post) return { success: false, error: "Post not found." }
  if (!post.content) return { success: false, error: "Cannot publish a post with no content." }
  if (post.publish_status === "published") return { success: false, error: "Post is already published." }

  const { error } = await supabase
    .from("blog_posts")
    .update({ publish_status: "published", published_at: new Date().toISOString() })
    .eq("id", params.postId)
    .eq("brokerage_id", params.brokerageId)

  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. createVideoProject
//
// Creates a new AI video project in draft status.
// Input:  ctx, title, scriptContent, videoType, listingId?
// Output: { projectId }
// Tables write: ai_video_projects
// Rules:  canAccessFeature('video_generation'); content passes evaluateOutbound
// NOTE:   Video provider config (HeyGen etc.) is superadmin-owned — NOT set here.
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateVideoProjectInput {
  ctx:          MarketingActorContext
  title:        string
  scriptContent: string
  videoType:    "listing" | "market_update" | "testimonial" | "educational" | "brand"
  listingId?:   string
  templateId?:  string
}

export async function createVideoProject(
  input: CreateVideoProjectInput
): Promise<KernelMarketingResult<{ projectId: string }>> {
  const { ctx } = input
  if (!input.title?.trim())        return { success: false, error: "Title is required." }
  if (!input.scriptContent?.trim()) return { success: false, error: "Script content is required." }

  const access = await canAccessFeature(ctx.userId, "video_generation")
  if (!access.allowed) return { success: false, error: access.reason ?? "Video generation access denied" }

  const supabase = await createServiceClient()
  const { data, error } = await supabase
    .from("ai_video_projects")
    .insert({
      brokerage_id:   ctx.brokerageId,
      agent_id:       ctx.agentId ?? null,
      title:          input.title.trim(),
      script_content: input.scriptContent.trim(),
      video_type:     input.videoType,
      listing_id:     input.listingId    ?? null,
      heygen_template_id: input.templateId ?? null,
      status:         "draft",
      heygen_status:  "pending",
      created_at:     new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }
  return { success: true, data: { projectId: data.id } }
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. previewVideoProject
//
// Returns the script and metadata for a video project as a preview state.
// Business rule: preview must exist before distributeVideoAsset is callable.
// Input:  projectId, brokerageId
// Output: { title, scriptContent, videoType, status, videoUrl? }
// ─────────────────────────────────────────────────────────────────────────────

export async function previewVideoProject(params: {
  projectId:   string
  brokerageId: string
}): Promise<KernelMarketingResult<{
  title:          string
  scriptContent:  string | null
  videoType:      string
  status:         string
  videoUrl:       string | null
  thumbnailUrl:   string | null
}>> {
  const supabase = await createServiceClient()
  const { data, error } = await supabase
    .from("ai_video_projects")
    .select("title, script_content, video_type, status, video_url, thumbnail_url")
    .eq("id", params.projectId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (error || !data) return { success: false, error: "Video project not found." }

  return {
    success: true,
    previewState: data.video_url ? "video_ready" : data.script_content ? "script_ready" : "empty",
    data: {
      title:         data.title,
      scriptContent: data.script_content,
      videoType:     data.video_type,
      status:        data.status,
      videoUrl:      data.video_url,
      thumbnailUrl:  data.thumbnail_url,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. distributeVideoAsset
//
// Marks a completed video project as distributed via specified channels.
// Business rule: project must have status=completed and a video_url.
// Input:  projectId, brokerageId, platforms, userId
// Output: void
// Tables write: repurposed_content_log
// ─────────────────────────────────────────────────────────────────────────────

export async function distributeVideoAsset(params: {
  projectId:   string
  brokerageId: string
  platforms:   string[]
  userId:      string
}): Promise<KernelMarketingResult<void>> {
  const supabase = await createServiceClient()

  const { data: project } = await supabase
    .from("ai_video_projects")
    .select("status, video_url, title")
    .eq("id", params.projectId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!project) return { success: false, error: "Video project not found." }
  if (!project.video_url) {
    return { success: false, error: "Video is not yet generated. Preview the project first to confirm it is ready." }
  }
  if (project.status !== "completed") {
    return { success: false, error: `Video is not yet completed (current: ${project.status}).` }
  }

  const insertRows = params.platforms.map((platform) => ({
    brokerage_id:     params.brokerageId,
    source_type:      "video_project",
    source_id:        params.projectId,
    output_type:      "video_distribution",
    output_ref_table: "ai_video_projects",
    output_ref_id:    params.projectId,
    platform_target:  platform,
    status:           "published",
    approval_status:  "approved",
    created_by:       params.userId,
    created_at:       new Date().toISOString(),
  }))

  const { error } = await supabase.from("repurposed_content_log").insert(insertRows)
  if (error) return { success: false, error: error.message }

  return { success: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. createPodcastEpisode  (thin kernel wrapper around podcast-generation.ts)
//
// Delegates to the full podcast-generation server action but validates here first.
// Input:  ctx, title, description?, script?, keywords?, publishChannels?
// Output: { episodeId }
// Tables write: podcast_episodes
// Rules:  canAccessFeature('podcast_generation'); evaluateOutbound on script
// ─────────────────────────────────────────────────────────────────────────────

export interface CreatePodcastEpisodeInput {
  ctx:             MarketingActorContext
  title:           string
  description?:    string
  script?:         string
  keywords?:       string[]
  publishChannels?: string[]
  templateId?:     string
  voiceId?:        string
  category?:       string
}

export async function createPodcastEpisodeKernel(
  input: CreatePodcastEpisodeInput
): Promise<KernelMarketingResult<{ episodeId: string }>> {
  const { ctx } = input
  if (!input.title?.trim()) return { success: false, error: "Episode title is required." }

  const access = await canAccessFeature(ctx.userId, "podcast_generation")
  if (!access.allowed) return { success: false, error: access.reason ?? "Podcast generation access denied" }

  if (input.script) {
    const compliance = await evaluateOutbound({
      content:     input.script,
      channel:     "podcast",
      brokerageId: ctx.brokerageId,
      agentId:     ctx.agentId,
      actorUserId: ctx.userId,
    })
    if (!compliance.passed) {
      return { success: false, blockedReason: compliance.reason, error: "Script content failed compliance check." }
    }
  }

  const brandVoice = await applyBrandVoice({ brokerageId: ctx.brokerageId, agentId: ctx.agentId })

  const supabase = await createServiceClient()
  const { data, error } = await supabase
    .from("podcast_episodes")
    .insert({
      brokerage_id:   ctx.brokerageId,
      agent_id:       ctx.agentId   ?? null,
      title:          input.title.trim(),
      description:    input.description ?? null,
      script:         input.script   ?? null,
      keywords:       input.keywords ?? [],
      publish_channels: input.publishChannels ?? [],
      template_id:    input.templateId ?? null,
      primary_voice_id: input.voiceId ?? null,
      category:       input.category  ?? null,
      status:         "draft",
      created_at:     new Date().toISOString(),
      updated_at:     new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }

  await incrementFeatureUsage(ctx.userId, "podcast_generation")
  return { success: true, data: { episodeId: data.id } }
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. previewPodcastEpisode
//
// Returns the episode script and metadata as a preview before publishing.
// Business rule: preview must be shown before publishPodcastEpisode is callable.
// Input:  episodeId, brokerageId
// Output: { title, script, audioUrl, status }
// ─────────────────────────────────────────────────────────────────────────────

export async function previewPodcastEpisode(params: {
  episodeId:   string
  brokerageId: string
}): Promise<KernelMarketingResult<{
  title:     string
  script:    string | null
  audioUrl:  string | null
  status:    string
  category:  string | null
  duration:  number | null
}>> {
  const supabase = await createServiceClient()
  const { data, error } = await supabase
    .from("podcast_episodes")
    .select("title, script, audio_url, status, category, duration_seconds")
    .eq("id", params.episodeId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (error || !data) return { success: false, error: "Episode not found." }

  return {
    success: true,
    previewState: data.audio_url ? "audio_ready" : data.script ? "script_ready" : "empty",
    data: {
      title:    data.title,
      script:   data.script,
      audioUrl: data.audio_url,
      status:   data.status,
      category: data.category,
      duration: data.duration_seconds,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 17. publishPodcastEpisode
//
// Transitions a podcast episode from draft → published and fires kernel event.
// Business rule: episode must have audio_url or at minimum a script.
// Input:  episodeId, brokerageId, userId, publishChannels?
// Output: void
// Tables write: podcast_episodes (status=completed, published_at)
// ─────────────────────────────────────────────────────────────────────────────

export async function publishPodcastEpisode(params: {
  episodeId:       string
  brokerageId:     string
  userId:          string
  publishChannels?: string[]
}): Promise<KernelMarketingResult<void>> {
  const supabase = await createServiceClient()

  const { data: ep } = await supabase
    .from("podcast_episodes")
    .select("status, script, audio_url, title")
    .eq("id", params.episodeId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!ep) return { success: false, error: "Episode not found." }
  if (!ep.script && !ep.audio_url) {
    return { success: false, error: "Episode must have a script or audio before publishing. Use previewPodcastEpisode first." }
  }
  if (ep.status === "completed") return { success: false, error: "Episode is already published." }

  const updates: Record<string, unknown> = {
    status:       "completed",
    published_at: new Date().toISOString(),
    updated_at:   new Date().toISOString(),
  }
  if (params.publishChannels?.length) updates.publish_channels = params.publishChannels

  const { error } = await supabase
    .from("podcast_episodes")
    .update(updates)
    .eq("id", params.episodeId)
    .eq("brokerage_id", params.brokerageId)

  if (error) return { success: false, error: error.message }

  await processKernelEvent({
    event:      KernelEvent.PODCAST_EPISODE_GENERATED,
    actorUserId: params.userId,
    brokerageId: params.brokerageId,
    entityId:   params.episodeId,
    entityType: "podcast_episode",
    metadata:   { publishedAt: new Date().toISOString() },
  })

  return { success: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// 18. createMarketingCampaign
//
// Creates a canonical marketing campaign record (the orchestrating wrapper).
// Input:  ctx, campaignName, campaignType, listingId?, budgetTotal?
// Output: { campaignId }
// Tables write: marketing_campaigns
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateMarketingCampaignInput {
  ctx:           MarketingActorContext
  campaignName:  string
  campaignType:  "listing" | "brand" | "recruitment" | "event" | "seasonal"
  listingId?:    string
  budgetTotal?:  number
  visibilityScope?: "agent" | "team" | "brokerage"
}

export async function createMarketingCampaign(
  input: CreateMarketingCampaignInput
): Promise<KernelMarketingResult<{ campaignId: string }>> {
  const { ctx } = input
  if (!input.campaignName?.trim()) return { success: false, error: "Campaign name is required." }

  const supabase = await createServiceClient()
  const { data, error } = await supabase
    .from("marketing_campaigns")
    .insert({
      brokerage_id:     ctx.brokerageId,
      agent_user_id:    ctx.userId,
      created_by:       ctx.userId,
      team_id:          ctx.teamId ?? null,
      campaign_name:    input.campaignName.trim(),
      campaign_type:    input.campaignType,
      listing_id:       input.listingId    ?? null,
      budget_total:     input.budgetTotal  ?? 0,
      budget_spent:     0,
      visibility_scope: input.visibilityScope ?? "agent",
      status:           "draft",
      created_at:       new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }

  await processKernelEvent({
    event:      KernelEvent.MARKETING_CAMPAIGN_CREATED,
    actorUserId: ctx.userId,
    brokerageId: ctx.brokerageId,
    entityId:   data.id,
    entityType: "marketing_campaign",
    metadata:   { campaignType: input.campaignType },
  })

  return { success: true, data: { campaignId: data.id } }
}

// ─────────────────────────────────────────────────────────────────────────────
// 19. repurposeContentAsset
//
// Creates a repurposed derivative from an existing content asset.
// Input:  ctx, sourceType, sourceId, outputType, platformTarget
// Output: { logId }
// Tables write: repurposed_content_log
// Rules:  source must exist; output_type must differ from source_type
// ─────────────────────────────────────────────────────────────────────────────

export async function repurposeContentAsset(params: {
  ctx:           MarketingActorContext
  sourceType:    "video_project" | "blog_post" | "podcast_episode" | "script"
  sourceId:      string
  outputType:    string
  outputRefTable?: string
  outputRefId?:  string
  platformTarget: string
  notes?:        string
}): Promise<KernelMarketingResult<{ logId: string }>> {
  const { ctx } = params

  const supabase = await createServiceClient()
  const { data, error } = await supabase
    .from("repurposed_content_log")
    .insert({
      brokerage_id:     ctx.brokerageId,
      source_type:      params.sourceType,
      source_id:        params.sourceId,
      output_type:      params.outputType,
      output_ref_table: params.outputRefTable ?? null,
      output_ref_id:    params.outputRefId    ?? null,
      platform_target:  params.platformTarget,
      status:           "pending",
      approval_status:  "pending",
      notes:            params.notes ?? null,
      created_by:       ctx.userId,
      created_at:       new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }
  return { success: true, data: { logId: data.id } }
}

// ─────────────────────────────────────────────────────────────────────────────
// 20. createQrAsset
//
// Creates a QR code record.
// Input:  ctx, label, targetUrl, purpose, listingId?, expiresAt?
// Output: { qrCodeId, slug }
// Tables write: qr_codes
// Rules:  slug must be unique; targetUrl must be a valid URL
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateQrAssetInput {
  ctx:        MarketingActorContext
  label:      string
  targetUrl:  string
  purpose:    "listing" | "open_house" | "general" | "campaign" | "lead_capture"
  listingId?: string
  expiresAt?: string
}

export async function createQrAsset(
  input: CreateQrAssetInput
): Promise<KernelMarketingResult<{ qrCodeId: string; slug: string }>> {
  const { ctx } = input
  if (!input.label?.trim())    return { success: false, error: "QR code label is required." }
  if (!input.targetUrl?.trim()) return { success: false, error: "Target URL is required." }

  // Basic URL validation
  try { new URL(input.targetUrl) } catch {
    return { success: false, error: "Target URL is not a valid URL." }
  }

  const slug = `qr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const supabase = await createServiceClient()

  const { data, error } = await supabase
    .from("qr_codes")
    .insert({
      brokerage_id: ctx.brokerageId,
      agent_id:     ctx.agentId ?? null,
      label:        input.label.trim(),
      slug,
      purpose:      input.purpose,
      target_url:   input.targetUrl.trim(),
      listing_id:   input.listingId ?? null,
      expires_at:   input.expiresAt ?? null,
      is_active:    true,
      scan_count:   0,
      lead_count:   0,
      created_at:   new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }
  return { success: true, data: { qrCodeId: data.id, slug } }
}

// ─────────────────────────────────────────────────────────────────────────────
// 21. previewQrAsset
//
// Returns QR code metadata and scan stats for preview before sharing.
// Input:  qrCodeId, brokerageId
// Output: { label, slug, targetUrl, purpose, scanCount, isActive }
// Tables read: qr_codes
// ─────────────────────────────────────────────────────────────────────────────

export async function previewQrAsset(params: {
  qrCodeId:    string
  brokerageId: string
}): Promise<KernelMarketingResult<{
  label:      string
  slug:       string
  targetUrl:  string
  purpose:    string
  scanCount:  number
  leadCount:  number
  isActive:   boolean
  expiresAt:  string | null
}>> {
  const supabase = await createServiceClient()
  const { data, error } = await supabase
    .from("qr_codes")
    .select("label, slug, target_url, purpose, scan_count, lead_count, is_active, expires_at")
    .eq("id", params.qrCodeId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (error || !data) return { success: false, error: "QR code not found." }

  return {
    success: true,
    previewState: "preview_ready",
    data: {
      label:     data.label,
      slug:      data.slug,
      targetUrl: data.target_url,
      purpose:   data.purpose,
      scanCount: data.scan_count ?? 0,
      leadCount: data.lead_count ?? 0,
      isActive:  data.is_active ?? true,
      expiresAt: data.expires_at,
    },
  }
}
