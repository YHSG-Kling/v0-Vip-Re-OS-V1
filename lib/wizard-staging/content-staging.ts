/**
 * Content-staging — thin wrappers around the ONE creator per content type.
 *
 * Used by both:
 *   - app/api/internal/ai-chat, lib/agents/marketing-agent-actions (typed Copilot / the
 *     marketing agent — ctx from the cookie session or the agent's verified run)
 *   - app/api/agent-assistant/tool-call (ElevenLabs voice webhook — ctx from the
 *     agent_assistant_sessions row the secret-verified conversation id maps to)
 *
 * Each helper takes (brokerageId, userId) explicitly so it works from both, and HANDS THEM TO
 * A SERVER-ONLY KERNEL CREATOR. None of them may import a "use server" action: those read the
 * COOKIE session, which the webhook does not have, so every spoken request came back
 * "Unauthorized" / "Not authenticated" / "Missing agent context" (wave 85D fixed direct mail,
 * wave 85F the other five). Tool parameters supply content only, never an id: the kernel
 * resolves agents.id itself, pinned to ctx.brokerageId (never ctx.userId, §3).
 *
 * TOMBSTONE (wave 85F): resolveAgentRowId, a users→agents read with NO tenant predicate on the
 * service client, is deleted. Survivor: lib/kernel/content-creators.ts resolveActorAgentId
 * (verified-or-crossed through lib/kernel/agent-identity.ts resolveAgentIdInBrokerage).
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface ContentStageResult {
  success: boolean
  draftId?: string
  openUrl?: string
  summary?: string
  error?: string
  /** Advisory compliance findings (warnings pass through, §5). */
  complianceWarnings?: string[]
}

interface AgentCtx {
  brokerageId: string
  userId: string
}

// ─── 1) Newsletter — kernel authorNewsletterContent + createNewsletterCampaign ─

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
    // Wave 21 — the full canonical authoring chain, not a one-section stub: topic-seeded,
    // persona/location-targeted sections from the compliance-first writer, then the creator
    // decomposes them and logs the seed topics (the performance loop + the video cohesion).
    // Wave 85F — both halves are the server-only kernel (lib/kernel/content-creators.ts), fed
    // the verified ctx; the "use server" pair in app/actions/ai-newsletter.ts refused the
    // webhook "Unauthorized".
    const { authorNewsletterContent, createNewsletterCampaign } = await import("@/lib/kernel/content-creators")
    const actor = { userId: ctx.userId, brokerageId: ctx.brokerageId }
    const authored = await authorNewsletterContent({
      ctx: actor,
      topic: intake.topic?.trim() || intake.title.trim(),
      targetAudience: intake.audience ?? "all",
      tone: "friendly",
    })
    if (!authored.success) return { success: false, error: authored.error ?? "Newsletter content authoring failed" }
    const sections = authored.sections
    const seedTopicIds = authored.seedTopicIds

    const result = await createNewsletterCampaign({
      ctx: actor,
      title: intake.title,
      subjectLine: intake.subjectLine ?? intake.title,
      preheaderText: "",
      template: "default",
      content: sections,
      audienceSegment: intake.audience ?? "all",
      seedTopicIds,
      // Model-written: stamped for the marketing-ai-approvals queue (pending_review).
      aiAuthored: true,
    })
    if (!result.success) return { success: false, error: result.error ?? "Newsletter creation failed" }
    const newsletterId = String(result.newsletter.id)
    return {
      success: true,
      draftId: newsletterId,
      openUrl: `/newsletters?draft=${newsletterId}`,
      summary: `Newsletter draft "${intake.title}" staged for review — ${sections.length} topic-seeded section(s) from ${seedTopicIds.length} content_topic_bank thread(s), written compliance-first with brand voice and a per-section compliance gate. Agent opens the newsletter editor to review and schedule.`,
      ...(authored.complianceWarnings?.length ? { complianceWarnings: authored.complianceWarnings } : {}),
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Newsletter staging failed" }
  }
}

// ─── 2) Email Campaign — kernel createEmailCampaign ──────────────────────────

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
    // Wave 85F: the kernel creator, fed the verified ctx. It crosses users→agents itself,
    // pinned to ctx.brokerageId (the old unpinned resolveAgentRowId is gone).
    const { createEmailCampaign } = await import("@/lib/kernel/content-creators")
    const result = await createEmailCampaign({
      ctx: { userId: ctx.userId, brokerageId: ctx.brokerageId },
      campaignName: intake.campaignName,
      subjectLine: intake.subjectLine ?? intake.campaignName,
      content: intake.content ?? "",
      sendDate: intake.sendDate,
    })
    if (!result.success) return { success: false, error: result.error ?? "Email campaign creation failed" }
    const campaignId = String(result.campaign.id)
    return {
      success: true,
      draftId: campaignId,
      openUrl: `/dashboard/marketing/studio?email_draft=${campaignId}`,
      summary: `Email campaign "${intake.campaignName}" staged as a draft pending approval (feature gate intact). Nothing sends until the agent schedules it.`,
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

// ─── 4) Blog post — kernel createBlogPostDraft ───────────────────────────────

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

  // TOMBSTONE (wave 85F, §1.1): this used to try the "use server" saveBlogPost (refused on the
  // webhook: no cookie session) and FALL THROUGH to a raw service-role blog_posts insert that
  // skipped the feature gate and the usage counter. Both merged onto the one creator.
  try {
    const { createBlogPostDraft } = await import("@/lib/kernel/content-creators")
    const result = await createBlogPostDraft({
      ctx: { userId: ctx.userId, brokerageId: ctx.brokerageId },
      title: intake.title,
      content: intake.topic ? `# ${intake.title}\n\n${intake.topic}` : `# ${intake.title}\n\n`,
      publishStatus: "draft",
      category: intake.category,
    })
    if (!result.success) return { success: false, error: result.error ?? "Blog draft creation failed" }
    return {
      success: true,
      draftId: result.postId,
      openUrl: `/dashboard/marketing/blog/${result.postId}`,
      summary: `Blog draft "${intake.title}" staged (feature gate intact). Agent opens the editor to expand and publish.`,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Blog staging failed" }
  }
}

// ─── 5) Podcast episode — kernel createPodcastEpisode ────────────────────────

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

  // TOMBSTONE (wave 85F, §1.1): the "use server" createPodcastEpisode was refused on the webhook
  // ("Missing agent context"), and the raw podcast_episodes fallback insert that followed
  // skipped the gate, brand voice, the compliance gate and the counter. Both merged onto the
  // one creator. A spoken "start a podcast on X" with no script is written by the kernel's
  // compliance-first writer, from the title/description as its topic.
  try {
    const { createPodcastEpisode } = await import("@/lib/kernel/content-creators")
    const keywords = intake.keywords?.length
      ? intake.keywords
      : intake.script?.trim() ? undefined : [intake.title, intake.description ?? ""].filter((k) => k.trim().length > 0)
    const result = await createPodcastEpisode({
      ctx: { userId: ctx.userId, brokerageId: ctx.brokerageId },
      title: intake.title,
      description: intake.description,
      script: intake.script,
      category: intake.category,
      keywords,
    })
    if (!result.success) return { success: false, error: result.error ?? "Podcast episode creation failed" }
    const id = String(result.episode.id)
    return {
      success: true,
      draftId: id,
      openUrl: `/dashboard/marketing/podcast?episode=${id}`,
      summary: `Podcast episode "${intake.title}" staged as a draft (feature gate, brand voice and compliance gate intact).`,
      ...(result.complianceWarnings?.length ? { complianceWarnings: result.complianceWarnings } : {}),
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Podcast staging failed" }
  }
}

// ─── 6) Video project — kernel createVideoProject ────────────────────────────

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
    // Wave 85F: the kernel creator, fed the verified ctx. The "use server" createVideoProject
    // wrote through the cookie client, which is anon on the webhook (RLS refused it). The
    // creator crosses ctx.userId (users-class, IDENTITY CLASS m363) to the agents row itself,
    // holds a red-flag or unevaluated script for a human, validates the spoken video type
    // against the CHECK, and verifies the listing is this tenant's.
    const { createVideoProject } = await import("@/lib/kernel/content-creators")
    const result = await createVideoProject({
      ctx: { userId: ctx.userId, brokerageId: ctx.brokerageId },
      title: intake.title,
      script: intake.script ?? "",
      // No dictated script → the shell lane (it used to be refused "Script is required"); the
      // studio writes the script compliance-first later.
      scriptPending: !intake.script?.trim(),
      videoType: intake.videoType ?? "market_update",
      format: intake.format ?? "vertical",
      durationSeconds: intake.durationSeconds ?? 45,
      captionsEnabled: true,
      backgroundType: "branded",
      listingId: intake.listingId,
    })
    if (!result.success) return { success: false, error: result.error ?? "Video project creation failed" }
    const projectId = String(result.project?.id ?? "")
    return {
      success: true,
      draftId: projectId || undefined,
      openUrl: projectId ? `/dashboard/videos/create?project=${projectId}` : "/dashboard/videos",
      summary: `Video project "${intake.title}" staged (fair-housing hold checked${intake.script?.trim() ? "" : "; no script yet — the studio writes it"}).`,
      ...(result.realismWarnings?.length ? { complianceWarnings: result.realismWarnings } : {}),
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Video staging failed" }
  }
}

// ─── 7) Direct mail campaign — calls canonical createDirectMailCampaign ──────

export interface DirectMailIntake {
  campaignName: string
  targetAudience: string
  /** Spoken or typed spelling (postcard_4x6 … handwritten, or the column's own). Folded
   *  onto the one vocabulary in lib/direct-mail/piece-type.ts. */
  pieceType?: string
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
    // THE VOICE DOOR (wave 85D, lane84E's unresolved door). This used to call the "use
    // server" action app/actions/ai-direct-mail.ts createDirectMailCampaign, which reads
    // the COOKIE session. The ElevenLabs webhook has none, so every spoken "send postcards
    // to my past clients" came back "Not signed in". It now files through the one creator,
    // lib/kernel/marketing.ts createDirectMailCampaign, with the actor THIS function's
    // callers already verified:
    //   · app/api/agent-assistant/tool-call: ctx = { session.brokerage_id, session.user_id }
    //     off the agent_assistant_sessions row. The secret header is checked before any
    //     read, and the conversation id is what maps to that row. Tool parameters (the body)
    //     supply only the campaign's content, never an id.
    //   · app/api/internal/ai-chat: ctx = the cookie session's user and tenant.
    // The kernel resolves agents.id itself (resolveAgentIdInBrokerage, pinned to
    // ctx.brokerageId). It is never ctx.userId: the 84E identity-class rule, now held in
    // one place.
    const { createDirectMailCampaign } = await import("@/lib/kernel/marketing")
    const { canonicalCampaignPieceType } = await import("@/lib/direct-mail/piece-type")
    // The spoken vocabulary (postcard_4x6 | … | handwritten) folds onto the column's
    // (lib/direct-mail/piece-type.ts). An unrecognised spoken piece is a postcard, the
    // default the session door has always used.
    const pieceType = canonicalCampaignPieceType(intake.pieceType) ?? "postcard"
    const result = await createDirectMailCampaign({
      ctx: { userId: ctx.userId, brokerageId: ctx.brokerageId },
      campaignName: intake.campaignName,
      targetAudience: intake.targetAudience,
      pieceType,
      budget: intake.budget,
      mailingDate: intake.sendDate,
      // Dictated copy is the agent's own words. It used to be dropped on the floor here.
      copyText: intake.copyText?.trim() || [intake.campaignName, intake.targetAudience].join(" "),
      tracking: {},
    })
    if (!result.success || !result.data) return { success: false, error: result.error ?? "Direct mail creation failed" }
    const campaignId = result.data.campaignId
    return {
      success: true,
      draftId: campaignId,
      openUrl: `/dashboard/campaigns/mail?campaign=${campaignId}`,
      summary: `Direct mail campaign "${intake.campaignName}" staged at planning (feature gate + tracked QR${result.data.qr ? "" : " — the QR could not be minted, add one from the campaign"}). Nothing prints or mails until it is approved.`,
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
      // NO SUPPRESSION LIST, said explicitly rather than omitted. A staged draft
      // suppresses nobody; the agent adds exclusions in the ads dashboard, where
      // every one of them is gated (lib/ads/audience-exclusion.ts).
      excluded_audience_ids: [],
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
