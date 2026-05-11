/**
 * Content-staging — shared helpers used by both:
 *   - app/actions/wizard-staging.ts  (auth-resolved, called from
 *                                     /api/internal/ai-chat tools)
 *   - app/api/agent-assistant/tool-call (ElevenLabs webhook with
 *                                        session.user_id + brokerage_id)
 *
 * Each helper takes a (brokerageId, userId) explicitly so it works from both
 * paths. Each writes a draft row in the existing canonical table and returns
 * { success, draftId, openUrl, summary } so the AI tool layer can speak it
 * back to the agent.
 *
 * No new tables. No new RLS. Schema verified against live Supabase before
 * coding — each insert uses only columns that actually exist.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

// ─── Shared result shape ─────────────────────────────────────────────────────

export interface ContentStageResult {
  success: boolean
  draftId?: string
  openUrl?: string
  summary?: string
  error?: string
}

interface AgentCtx {
  brokerageId: string
  userId: string
}

async function resolveAgentRowId(
  svc: ReturnType<typeof createServiceClient>,
  userId: string,
): Promise<string | null> {
  const { data } = await svc.from("agents").select("id").eq("user_id", userId).maybeSingle()
  return data?.id ?? null
}

// ─── 1) Newsletter ───────────────────────────────────────────────────────────
// newsletter_campaigns columns: id, campaign_name, subject_line, content,
// status, send_date, created_by, brokerage_id, agent_id, approval_status,
// brand_compliance_passed, open_rate, click_rate, unsubscribe_rate,
// kernel_event_id, created_at

export interface NewsletterIntake {
  title: string                 // mapped to campaign_name
  subjectLine?: string
  topic?: string                // seeded into content
}

export async function stageNewsletterDraft(
  ctx: AgentCtx,
  intake: NewsletterIntake,
): Promise<ContentStageResult> {
  if (!intake.title?.trim()) return { success: false, error: "title required" }

  const svc = createServiceClient()
  const agentId = await resolveAgentRowId(svc, ctx.userId)

  const { data, error } = await svc
    .from("newsletter_campaigns")
    .insert({
      brokerage_id: ctx.brokerageId,
      agent_id: agentId,
      campaign_name: intake.title,
      subject_line: intake.subjectLine ?? intake.title,
      content: intake.topic
        ? JSON.stringify([{ type: "intro", body: intake.topic }])
        : "",
      status: "draft",
      approval_status: "pending",
      brand_compliance_passed: false,
      created_by: ctx.userId,
    })
    .select("id, campaign_name")
    .maybeSingle()

  if (error || !data) return { success: false, error: error?.message ?? "Newsletter insert failed" }

  return {
    success: true,
    draftId: data.id,
    openUrl: `/newsletters?draft=${data.id}`,
    summary: `Newsletter draft "${data.campaign_name}" staged. Agent opens the newsletter editor to add sections and schedule send.`,
  }
}

// ─── 2) Email Campaign ───────────────────────────────────────────────────────
// email_campaigns: brokerage_id, agent_id, campaign_name, subject_line,
// content, status, approval_status, created_by, send_date,
// brand_compliance_passed

export interface EmailCampaignIntake {
  campaignName: string
  subjectLine?: string
  content?: string
  sendDate?: string
}

export async function stageEmailCampaign(
  ctx: AgentCtx,
  intake: EmailCampaignIntake,
): Promise<ContentStageResult> {
  if (!intake.campaignName?.trim()) return { success: false, error: "campaign_name required" }

  const svc = createServiceClient()
  const agentId = await resolveAgentRowId(svc, ctx.userId)

  const { data, error } = await svc
    .from("email_campaigns")
    .insert({
      brokerage_id: ctx.brokerageId,
      agent_id: agentId,
      campaign_name: intake.campaignName,
      subject_line: intake.subjectLine ?? intake.campaignName,
      content: intake.content ?? "",
      status: "draft",
      approval_status: "pending",
      created_by: ctx.userId,
      send_date: intake.sendDate ?? null,
      brand_compliance_passed: false,
    })
    .select("id, campaign_name")
    .maybeSingle()

  if (error || !data) return { success: false, error: error?.message ?? "Email insert failed" }

  return {
    success: true,
    draftId: data.id,
    openUrl: `/dashboard/marketing/studio?email_draft=${data.id}`,
    summary: `Email campaign "${data.campaign_name}" staged as draft (pending approval). Agent reviews content and clicks Send.`,
  }
}

// ─── 3) Open House ───────────────────────────────────────────────────────────
// open_house_events: id, listing_id, event_date, start_time, end_time, notes,
// created_by, agent_id, brokerage_id, status, description, max_attendees,
// registration_required, qr_code_id, packet_url, event_type

export interface OpenHouseIntake {
  listingId: string
  date: string         // YYYY-MM-DD
  startTime: string    // HH:MM
  endTime: string      // HH:MM
  maxAttendees?: number
  notes?: string
  publicDescription?: string
}

export async function stageOpenHouse(
  ctx: AgentCtx,
  intake: OpenHouseIntake,
): Promise<ContentStageResult> {
  if (!intake.listingId) return { success: false, error: "listing_id required" }
  if (!intake.date || !intake.startTime || !intake.endTime) {
    return { success: false, error: "date + start_time + end_time required" }
  }

  const svc = createServiceClient()

  // Brokerage scoping: verify listing belongs to this brokerage
  const { data: listing } = await svc
    .from("listings")
    .select("brokerage_id, agent_id")
    .eq("id", intake.listingId)
    .maybeSingle()
  if (!listing || listing.brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Listing not found in your brokerage" }
  }

  const { data, error } = await svc
    .from("open_house_events")
    .insert({
      listing_id: intake.listingId,
      brokerage_id: ctx.brokerageId,
      agent_id: listing.agent_id ?? null,
      created_by: ctx.userId,
      event_date: intake.date,
      start_time: intake.startTime,
      end_time: intake.endTime,
      max_attendees: intake.maxAttendees ?? null,
      notes: intake.notes ?? null,
      description: intake.publicDescription ?? null,
      status: "scheduled",
      registration_required: false,
    })
    .select("id, event_date, start_time, end_time")
    .maybeSingle()

  if (error || !data) return { success: false, error: error?.message ?? "Open house insert failed" }

  return {
    success: true,
    draftId: data.id,
    openUrl: `/dashboard/listings/${intake.listingId}/open-house`,
    summary: `Open house scheduled for ${data.event_date} ${data.start_time}-${data.end_time}. Agent opens listing → Open House tab to invite contacts and set up QR check-in.`,
  }
}

// ─── 4) Blog post ────────────────────────────────────────────────────────────
// blog_posts: id, brokerage_id, team_id, agent_user_id, created_by,
// visibility_scope, marketing_campaign_id, title, slug, excerpt, content,
// featured_image_url, publish_status, seo_score, wordpress_post_id,
// published_at, kernel_event_id, category, call_to_action

export interface BlogPostIntake {
  title: string
  topic?: string
  category?: string
}

export async function stageBlogDraft(
  ctx: AgentCtx,
  intake: BlogPostIntake,
): Promise<ContentStageResult> {
  if (!intake.title?.trim()) return { success: false, error: "title required" }

  const svc = createServiceClient()

  const slug =
    intake.title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || `post-${Date.now()}`

  const { data, error } = await svc
    .from("blog_posts")
    .insert({
      brokerage_id: ctx.brokerageId,
      agent_user_id: ctx.userId,
      created_by: ctx.userId,
      title: intake.title,
      slug,
      content: intake.topic ? `# ${intake.title}\n\n${intake.topic}` : `# ${intake.title}\n\n`,
      publish_status: "draft",
      category: intake.category ?? null,
    })
    .select("id, title")
    .maybeSingle()

  if (error || !data) return { success: false, error: error?.message ?? "Blog insert failed" }

  return {
    success: true,
    draftId: data.id,
    openUrl: `/dashboard/marketing/blog/${data.id}`,
    summary: `Blog draft "${data.title}" staged. Agent opens the editor to expand the content and publish.`,
  }
}

// ─── 5) Podcast episode ──────────────────────────────────────────────────────
// podcast_episodes: id, brokerage_id, agent_id, template_id,
// marketing_campaign_id, source_video_project_id, source_video_asset_id,
// title, description, script, keywords, primary_voice_id, voice_settings,
// category, status, audio_url, duration_seconds, generation_started_at,
// generation_completed_at, published_at, publish_channels, segments,
// error_message, kernel_event_id, scheduled_at
// NOTE: no created_by column

export interface PodcastEpisodeIntake {
  title: string
  description?: string
  script?: string
  category?: string
  keywords?: string[]
}

export async function stagePodcastEpisode(
  ctx: AgentCtx,
  intake: PodcastEpisodeIntake,
): Promise<ContentStageResult> {
  if (!intake.title?.trim()) return { success: false, error: "title required" }

  const svc = createServiceClient()
  const agentId = await resolveAgentRowId(svc, ctx.userId)

  const { data, error } = await svc
    .from("podcast_episodes")
    .insert({
      brokerage_id: ctx.brokerageId,
      agent_id: agentId,
      title: intake.title,
      description: intake.description ?? null,
      script: intake.script ?? null,
      category: intake.category ?? "market_update",
      keywords: intake.keywords ?? [],
      status: "draft",
    })
    .select("id, title")
    .maybeSingle()

  if (error || !data) return { success: false, error: error?.message ?? "Podcast insert failed" }

  return {
    success: true,
    draftId: data.id,
    openUrl: `/dashboard/marketing/podcast?episode=${data.id}`,
    summary: `Podcast episode "${data.title}" staged as draft. Agent opens the podcast studio to write/refine the script and generate audio.`,
  }
}

// ─── 6) Video project ────────────────────────────────────────────────────────
// ai_video_projects: id, listing_id, agent_id, brokerage_id, title,
// script_content, status, video_url, heygen_*, duration_seconds, completed_at,
// video_metadata, retry_count, error_message, video_provider, video_type,
// provider_*, thumbnail_url, background_type, background_url, format,
// captions_enabled
// NOTE: no created_by column; agent_id stores agents.id (per createVideoProject)

export interface VideoProjectIntake {
  title: string
  script?: string
  videoType?: string
  format?: "vertical" | "horizontal" | "square"
  durationSeconds?: number
  listingId?: string
}

export async function stageVideoProject(
  ctx: AgentCtx,
  intake: VideoProjectIntake,
): Promise<ContentStageResult> {
  if (!intake.title?.trim()) return { success: false, error: "title required" }

  const svc = createServiceClient()
  const agentId = await resolveAgentRowId(svc, ctx.userId)

  const { data, error } = await svc
    .from("ai_video_projects")
    .insert({
      brokerage_id: ctx.brokerageId,
      agent_id: agentId ?? ctx.userId,    // fallback when no agents row (some roles)
      title: intake.title,
      script_content: intake.script ?? "",
      video_type: intake.videoType ?? "market_update",
      background_type: "office_modern",
      format: intake.format ?? "vertical",
      duration_seconds: intake.durationSeconds ?? 45,
      captions_enabled: true,
      listing_id: intake.listingId ?? null,
      status: "draft",
      retry_count: 0,
      video_provider: "heygen",
    })
    .select("id, title")
    .maybeSingle()

  if (error || !data) return { success: false, error: error?.message ?? "Video insert failed" }

  return {
    success: true,
    draftId: data.id,
    openUrl: `/dashboard/videos/create?project=${data.id}`,
    summary: `Video project "${data.title}" staged as draft. Agent opens video studio to refine the script and generate.`,
  }
}

// ─── 7) Direct mail campaign ─────────────────────────────────────────────────
// direct_mail_campaigns: id, campaign_name, target_audience, design_url,
// quantity, status, created_by, contact_id, lead_id, brokerage_id, agent_id,
// lob_order_id, mailing_date, per_piece_cost, pieces_mailed,
// estimated_response_rate, copy_text, qr_code_id, tracking_id, piece_type
// NOTE: piece_type (not mailing_type); no total_cost column

export interface DirectMailIntake {
  campaignName: string
  targetAudience: string
  pieceType?: "postcard_4x6" | "postcard_6x9" | "postcard_6x11" | "letter" | "handwritten" | "thank_you_note"
  budget?: number
  sendDate?: string
  copyText?: string
}

export async function stageDirectMailCampaign(
  ctx: AgentCtx,
  intake: DirectMailIntake,
): Promise<ContentStageResult> {
  if (!intake.campaignName?.trim()) return { success: false, error: "campaign_name required" }
  if (!intake.targetAudience?.trim()) return { success: false, error: "target_audience required" }

  const svc = createServiceClient()
  const agentId = await resolveAgentRowId(svc, ctx.userId)

  // Compute quantity from budget (mirrors createDirectMailCampaign defaults)
  const quantity =
    intake.budget && intake.budget > 0 ? Math.max(1, Math.floor(intake.budget / 0.79)) : 100
  const perPieceCost =
    intake.budget && quantity > 0
      ? Number((intake.budget / quantity).toFixed(2))
      : 0.79

  const { data, error } = await svc
    .from("direct_mail_campaigns")
    .insert({
      brokerage_id: ctx.brokerageId,
      agent_id: agentId,
      created_by: ctx.userId,
      campaign_name: intake.campaignName,
      target_audience: intake.targetAudience,
      piece_type: intake.pieceType ?? "postcard_4x6",
      quantity,
      per_piece_cost: perPieceCost,
      copy_text: intake.copyText ?? `${intake.campaignName} — ${intake.targetAudience}`,
      mailing_date: intake.sendDate ?? null,
      status: "draft",
    })
    .select("id, campaign_name")
    .maybeSingle()

  if (error || !data) return { success: false, error: error?.message ?? "Direct mail insert failed" }

  return {
    success: true,
    draftId: data.id,
    openUrl: `/dashboard/campaigns/mail?campaign=${data.id}`,
    summary: `Direct mail campaign "${data.campaign_name}" staged as draft. Agent opens campaigns to AI-generate copy + validate recipients + submit to print.`,
  }
}
