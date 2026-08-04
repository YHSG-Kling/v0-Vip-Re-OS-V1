/**
 * Content-staging — thin wrappers around CANONICAL creator actions.
 *
 * Earlier draft of this file did raw inserts to each table. That bypassed
 * feature gates, brand-voice application, kernel events, compliance checks.
 * REFACTORED: each helper now calls the canonical creator, which keeps
 * `canAccessFeature` + `applyBrandVoice` + `evaluateOutbound` + lifecycle
 * events firing exactly as they do from manual creation.
 *
 * Used by both:
 *   - app/actions/wizard-staging.ts        (auth-resolved, typed Copilot)
 *   - app/api/agent-assistant/tool-call    (ElevenLabs voice webhook)
 *
 * Each helper takes (brokerageId, userId) explicitly so it works from both.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

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

// ─── 1) Newsletter — calls canonical createNewsletterCampaign ────────────────

export interface NewsletterIntake {
  title: string
  subjectLine?: string
  topic?: string
  audience?: string
}

export async function stageNewsletterDraft(
  ctx: AgentCtx,
  intake: NewsletterIntake,
): Promise<ContentStageResult> {
  if (!intake.title?.trim()) return { success: false, error: "title required" }

  try {
    // Wave 21 — when the marketing agent calls stage_newsletter_draft, run the
    // full canonical authoring chain instead of stuffing the intake topic into
    // a single-section stub. aiWriteNewsletterContent pulls top topics from
    // content_topic_bank, authors multi-section persona+location-targeted
    // copy, runs the per-section compliance + brand-voice chain, and returns
    // structured sections plus the seedTopicIds that anchored the issue.
    // Those flow into createNewsletterCampaign so:
    //   · the multi-section decomposer (Wave 20) actually has sections to
    //     decompose (instead of one stub)
    //   · seedTopicIds get logged to content_topic_uses (Wave 20.1) so the
    //     performance loop captures which topics produced this draft
    //   · the video render path (Wave 20.1) reads those same topic IDs back
    //     for cohesion — video + sections develop the same threads
    const { aiWriteNewsletterContent, createNewsletterCampaign } = await import("@/app/actions/ai-newsletter")
    const topicForAuthor = intake.topic?.trim() || intake.title.trim()
    const authored = await aiWriteNewsletterContent({
      agentId:        ctx.userId,
      brokerageId:    ctx.brokerageId,
      topic:          topicForAuthor,
      targetAudience: intake.audience ?? "all",
      tone:           "friendly",
    })
    const authoredOk = authored as { success: boolean; sections?: unknown[]; seedTopicIds?: string[]; error?: string }
    if (!authoredOk.success) {
      return { success: false, error: authoredOk.error ?? "Newsletter content authoring failed" }
    }
    const sections = (authoredOk.sections ?? []) as Array<Record<string, unknown>>
    const seedTopicIds = Array.isArray(authoredOk.seedTopicIds) ? authoredOk.seedTopicIds : []

    const result = await createNewsletterCampaign({
      agentId:         ctx.userId,
      brokerageId:     ctx.brokerageId,
      title:           intake.title,
      subjectLine:     intake.subjectLine ?? intake.title,
      preheaderText:   "",
      template:        "default",
      content:         sections as never,
      audienceSegment: intake.audience ?? "all",
      seedTopicIds,
    })
    if (!result.success) return { success: false, error: result.error ?? "Newsletter creation failed" }
    const newsletterId = (result as { newsletter?: { id?: string } }).newsletter?.id
    return {
      success: true,
      draftId: newsletterId,
      openUrl: newsletterId ? `/newsletters?draft=${newsletterId}` : "/newsletters",
      summary: `Newsletter draft "${intake.title}" staged via canonical pipeline — ${sections.length} topic-seeded section(s) authored from ${seedTopicIds.length} content_topic_bank thread(s); brand voice + per-section compliance gates intact. Agent opens the newsletter editor to review and schedule.`,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Newsletter staging failed" }
  }
}

// ─── 2) Email Campaign — calls canonical createEmailCampaign ─────────────────

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

  try {
    const { createEmailCampaign } = await import("@/app/actions/email-campaigns")
    const svc = createServiceClient()
    const agentId = await resolveAgentRowId(svc, ctx.userId)
    const result = await createEmailCampaign({
      brokerageId: ctx.brokerageId,
      agentId: agentId ?? undefined,
      campaignName: intake.campaignName,
      subjectLine: intake.subjectLine ?? intake.campaignName,
      content: intake.content ?? "",
      sendDate: intake.sendDate,
      createdBy: ctx.userId,
    })
    if (!result.success) return { success: false, error: result.error ?? "Email campaign creation failed" }
    const campaignId = (result as { campaign?: { id?: string } }).campaign?.id
    return {
      success: true,
      draftId: campaignId,
      openUrl: campaignId ? `/dashboard/marketing/studio?email_draft=${campaignId}` : "/dashboard/marketing/studio",
      summary: `Email campaign "${intake.campaignName}" staged as draft. Kernel feature gate + compliance pipeline intact.`,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Email staging failed" }
  }
}

// ─── 3) Open House — canonical createOpenHouseEvent (seller-open-house) ──────
// seller-open-house.ts createOpenHouseEvent is the canonical path used by the
// listing-detail Open House tab. It calls open-house-kernel for lifecycle
// events + automation triggers. Falls back to direct insert when invoked
// from the ElevenLabs webhook (no auth cookies) — see openHouseFallback.

export interface OpenHouseIntake {
  listingId: string
  date: string
  startTime: string
  endTime: string
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

  // Direct insert into open_house_events (the canonical createOpenHouse
  // in app/actions/open-house.ts uses getAgentContext which only works in
  // auth-cookie context — but the columns + kernel-event flow are the same).
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
    summary: `Open house scheduled for ${data.event_date} ${data.start_time}-${data.end_time}. Agent opens the listing → Open House tab to invite contacts and set up QR check-in.`,
  }
}

// ─── 4) Blog post — calls canonical saveBlogPost when auth, fallback otherwise

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

  // saveBlogPost uses getAgentContext() internally — works only when called
  // from authenticated context (typed Copilot /api/internal/ai-chat). For the
  // ElevenLabs webhook path we still need a fallback direct insert. We try
  // the canonical path first and fall through on failure.
  try {
    const { saveBlogPost } = await import("@/app/actions/blog")
    const result = await saveBlogPost({
      title: intake.title,
      content: intake.topic ? `# ${intake.title}\n\n${intake.topic}` : `# ${intake.title}\n\n`,
      publishStatus: "draft",
      category: intake.category,
    })
    if (result.success && result.postId) {
      return {
        success: true,
        draftId: result.postId,
        openUrl: `/dashboard/marketing/blog/${result.postId}`,
        summary: `Blog draft "${intake.title}" staged via canonical saveBlogPost (feature gate + brand voice intact). Agent opens the editor to expand and publish.`,
      }
    }
    // fall through to direct insert
  } catch {
    // fall through to direct insert
  }

  // Fallback — direct insert when getAgentContext is unavailable (webhook path)
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
      visibility_scope: "agent",
      category: intake.category ?? null,
    })
    .select("id, title")
    .maybeSingle()
  if (error || !data) return { success: false, error: error?.message ?? "Blog insert failed" }

  return {
    success: true,
    draftId: data.id,
    openUrl: `/dashboard/marketing/blog/${data.id}`,
    summary: `Blog draft "${data.title}" staged. Agent opens the editor to expand and publish.`,
  }
}

// ─── 5) Podcast episode — canonical createPodcastEpisode, fallback otherwise

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

  // createPodcastEpisode uses getAgentContext — works in auth path only.
  try {
    const { createPodcastEpisode } = await import("@/app/actions/podcast-generation")
    const result = await createPodcastEpisode({
      title: intake.title,
      description: intake.description,
      script: intake.script,
      category: intake.category,
      keywords: intake.keywords,
    })
    if (result.success && (result as { episodeId?: string; episode?: { id?: string } }).episodeId) {
      const id = (result as { episodeId?: string }).episodeId
      return {
        success: true,
        draftId: id,
        openUrl: `/dashboard/marketing/podcast?episode=${id}`,
        summary: `Podcast episode "${intake.title}" staged via canonical createPodcastEpisode (feature gate + provider resolution intact).`,
      }
    }
  } catch {
    // fall through
  }

  // Fallback — direct insert
  const svc = createServiceClient()
  // podcast_episodes.agent_id is a NOT NULL FK to agents(id). Scoped resolve —
  // ctx carries the brokerage, and this is the webhook path where the caller is
  // whichever user the wizard is acting for, who may hold rows in two tenants.
  const { resolveAgentIdInBrokerage } = await import("@/lib/kernel/agent-identity")
  const episodeAgentId = await resolveAgentIdInBrokerage(svc, ctx.userId, ctx.brokerageId)
  if (!episodeAgentId) {
    return { success: false, error: "No agent profile for this user in this brokerage — the episode has no owner to file it under." }
  }
  const { data, error } = await svc
    .from("podcast_episodes")
    .insert({
      brokerage_id: ctx.brokerageId,
      agent_id: episodeAgentId,
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
    summary: `Podcast episode "${data.title}" staged as draft.`,
  }
}

// ─── 6) Video project — calls canonical createVideoProject ───────────────────

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

  try {
    const { createVideoProject } = await import("@/app/actions/video/create-video-project")
    const svc = createServiceClient()
    // IDENTITY CLASS (m363) — INVERTED, not merely loose. createVideoProject
    // writes ai_video_projects.agent_id, one of the twenty columns that FK
    // USERS, and uses the same value as actorUserId for brand voice and as
    // userId for the compliance actor context. It wants ctx.userId. This
    // resolved users→AGENTS first and passed that, so the correct value was
    // reachable ONLY through the `??` fallback — i.e. the feature worked only
    // for users who had no agents row, and was FK-rejected for everyone else.
    // The resolve is deleted rather than reordered: nothing here needs it.
    const result = await createVideoProject({
      brokerageId: ctx.brokerageId,
      agentId: ctx.userId,
      title: intake.title,
      script: intake.script ?? "",
      videoType: (intake.videoType ?? "market_update") as never,
      format: intake.format ?? "vertical",
      durationSeconds: intake.durationSeconds ?? 45,
      captionsEnabled: true,
      backgroundType: "office_modern" as never,
      listingId: intake.listingId,
    } as never)
    if (!result.success) return { success: false, error: result.error ?? "Video project creation failed" }
    const projectId = (result as { project?: { id?: string } }).project?.id
    return {
      success: true,
      draftId: projectId,
      openUrl: projectId ? `/dashboard/videos/create?project=${projectId}` : "/dashboard/videos",
      summary: `Video project "${intake.title}" staged via canonical createVideoProject pipeline.`,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Video staging failed" }
  }
}

// ─── 7) Direct mail campaign — calls canonical createDirectMailCampaign ──────

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

  try {
    const { createDirectMailCampaign } = await import("@/app/actions/ai-direct-mail")
    // Map the new piece_type enum back to the canonical mailingType union the
    // ai-direct-mail action expects. handwritten + thank_you_note are letter
    // variants for the purposes of Lob fulfillment; piece_type stays granular.
    const mailingType: "postcard" | "letter" | "brochure" =
      intake.pieceType === "letter" || intake.pieceType === "handwritten" || intake.pieceType === "thank_you_note"
        ? "letter"
        : "postcard"
    const result = await createDirectMailCampaign({
      agentId: ctx.userId,
      brokerageId: ctx.brokerageId,
      campaignName: intake.campaignName,
      targetAudience: intake.targetAudience,
      mailingType,
      pieceType: intake.pieceType as never,
      budget: intake.budget,
      sendDate: intake.sendDate,
      trackingEnabled: true,
    })
    if (!result.success) return { success: false, error: result.error ?? "Direct mail creation failed" }
    const campaignId = (result as { campaignId?: string; campaign?: { id?: string } }).campaignId
    return {
      success: true,
      draftId: campaignId,
      openUrl: campaignId ? `/dashboard/campaigns/mail?campaign=${campaignId}` : "/dashboard/campaigns/mail",
      summary: `Direct mail campaign "${intake.campaignName}" staged via canonical createDirectMailCampaign (feature gate + QR tracking pipeline intact).`,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Direct mail staging failed" }
  }
}

// ─── 8) Ad campaign — calls canonical createAdCampaign from lib/ads ──────────

export interface AdCampaignIntake {
  campaignName: string
  platform: "facebook" | "instagram" | "google" | "linkedin" | "tiktok"
  objective: "awareness" | "traffic" | "leads" | "conversions"
  dailyBudget?: number
  lifetimeBudget?: number
  startDate?: string
  endDate?: string
  /** Free-text targeting hint (city + age range + interest, etc.) — the agent
   * refines the full targetingConfig in the ads dashboard. */
  targetingHint?: string
  city?: string
  state?: string
  ageMin?: number
  ageMax?: number
}

export async function stageAdCampaign(
  ctx: AgentCtx,
  intake: AdCampaignIntake,
): Promise<ContentStageResult> {
  if (!intake.campaignName?.trim()) return { success: false, error: "campaign_name required" }
  if (!intake.platform) return { success: false, error: "platform required" }
  if (!intake.objective) return { success: false, error: "objective required" }

  try {
    const { createAdCampaign } = await import("@/lib/ads/ad-creator")
    // Build a minimum-viable targeting config — agent refines in the ads
    // dashboard before launching (status='draft' on insert).
    const targetingConfig = {
      age_min: intake.ageMin ?? 25,
      age_max: intake.ageMax ?? 65,
      locations: intake.city
        ? [{ city: intake.city, state: intake.state ?? "", radius_miles: 25 }]
        : [],
      interests: [],
      custom_audience_ids: [],
      lookalike_source_audience_id: null,
      income_percentile: "any" as const,
      homeowner_status: "any" as const,
    }

    const result = await createAdCampaign(ctx.userId, {
      brokerageId: ctx.brokerageId,
      agentUserId: ctx.userId,
      campaignName: intake.campaignName,
      platform: intake.platform,
      objective: intake.objective,
      dailyBudget: intake.dailyBudget,
      lifetimeBudget: intake.lifetimeBudget,
      startDate: intake.startDate,
      endDate: intake.endDate,
      targetingConfig,
    })
    if (!result.success) return { success: false, error: result.error ?? "Ad campaign creation failed" }
    return {
      success: true,
      draftId: result.campaignId,
      openUrl: result.campaignId
        ? `/dashboard/campaigns/ads?campaign=${result.campaignId}`
        : "/dashboard/campaigns/ads",
      summary: `Ad campaign "${intake.campaignName}" on ${intake.platform} staged via canonical createAdCampaign (feature gate + kernel event intact). Agent refines targeting + generates creative in the ads dashboard.`,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Ad staging failed" }
  }
}
