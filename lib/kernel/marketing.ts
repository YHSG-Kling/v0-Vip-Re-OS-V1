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
 *   newsletter_scheduled_sends: newsletter_id, brokerage_id, scheduled_time, sent_time, recipient_count
 *     (scheduled_time is the surviving schedule column — scheduled_send_time is
 *      a writer-less orphan awaiting the integrator's DROP, see §6 note at the
 *      insert site below)
 *   blog_posts:              title, slug, excerpt, content, publish_status (NOT status), brokerage_id, agent_user_id, created_by, seo_score, featured_image_url, wordpress_post_id
 *   ai_video_projects:       title, status, script_content, video_type, agent_id, listing_id, brokerage_id, provider_status, video_url
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
// Client-agnostic identity resolver, NOT agent-identity-resolver: this module
// carries no "server-only" marker and is imported from the marketing surfaces,
// so it must never pull the service-role resolver into a page bundle.
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"
import { applyKernelBrandVoice, isBrandVoiceBlocked } from "@/lib/kernel/adapters/brand-voice"
import { evaluateKernelOutbound, isComplianceBlocked, getComplianceReason } from "@/lib/kernel/adapters/compliance"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { generateTextRouted } from "@/lib/ai/models"
import { VIDEO_FINISHED_STATUSES, VIDEO_IN_PROGRESS_STATUSES } from "@/lib/video/video-status"

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
// Input:  ctx.brokerageId. NOTE: ctx.agentId is NOT applied as a filter — this
//         summary is brokerage-wide. The per-agent cut is not implemented
//         because the seven source tables split across two id classes
//         (marketing_campaigns/blog_posts key on agent_user_id, a USERS id;
//         the rest key on agent_id, an AGENTS id) and narrowing them needs a
//         resolve, not a substitution. The header used to claim the filter
//         existed; it never did.
// Output: counts, recent campaigns, upcoming sends, recent blog posts, recent episodes
// Tables: marketing_campaigns, newsletter_campaigns, blog_posts, podcast_episodes,
//         direct_mail_campaigns, qr_codes, marketing_assets, campaign_calendar
// ─────────────────────────────────────────────────────────────────────────────

export interface MarketingWorkspaceData {
  campaignCounts: { draft: number; live: number; ended: number }
  newsletterCounts: { draft: number; scheduled: number; sent: number; totalSubscribers: number }
  blogCounts: { draft: number; published: number }
  /** ai_video_projects carries NINE statuses (lib/video/video-status.ts), so a
   *  two-bucket tally has to be keyed on the canonical SETS, not on two hand-
   *  picked tokens. Named inProgress/finished rather than generating/completed
   *  precisely so a future reader does not assume `finished` means
   *  status === 'completed' — a published video is finished too. */
  videoCounts: { inProgress: number; finished: number }
  podcastCounts: { draft: number; completed: number }
  directMailCounts: { planning: number; mailed: number }
  qrCount: number
  upcomingEvents: Array<{ id: string; title: string; scheduled_at: string; event_type: string }>
}

export async function loadMarketingWorkspace(
  ctx: MarketingActorContext
): Promise<KernelMarketingResult<MarketingWorkspaceData>> {
  const supabase = await createServiceClient()
  const { brokerageId } = ctx

  try {
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
        .eq("status", "subscribed"),
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

    // supabase-js RESOLVES a refused read: `.data` comes back null and `.error`
    // carries the reason. Every count below is derived from `.data`, so without
    // this check an RLS refusal or a dropped column renders as a workspace of
    // honest-looking ZEROS — indistinguishable from a brokerage that has not
    // created anything yet, and impossible for the operator to notice.
    const reads: Array<[string, { error: { message: string } | null }]> = [
      ["marketing_campaigns", campaignRows],
      ["newsletter_campaigns", newsletterRows],
      ["newsletter_subscribers", subscriberCount],
      ["blog_posts", blogRows],
      ["ai_video_projects", videoRows],
      ["podcast_episodes", podcastRows],
      ["direct_mail_campaigns", mailRows],
      ["qr_codes", qrResult],
      ["campaign_calendar", eventRows],
    ]
    const failed = reads.filter(([, r]) => r.error)
    if (failed.length > 0) {
      return {
        success: false,
        error: `loadMarketingWorkspace could not read ${failed
          .map(([t, r]) => `${t} (${r.error!.message})`)
          .join("; ")}`,
      }
    }

    const tally = (rows: any[], key: string, val: string) =>
      (rows || []).filter((r) => r[key] === val).length

    /** Count rows whose status falls in one of the canonical video sets. */
    const tallyIn = (rows: any[], key: string, vals: readonly string[]) =>
      (rows || []).filter((r) => vals.includes(r[key])).length

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
          // `generating` alone hid queued and scripting work; `completed` alone
          // dropped every PUBLISHED video out of both buckets, so a brokerage
          // that had shipped its whole library read as having produced nothing.
          inProgress: tallyIn(videoRows.data || [], "status", VIDEO_IN_PROGRESS_STATUSES),
          finished:   tallyIn(videoRows.data || [], "status", VIDEO_FINISHED_STATUSES),
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
// Input:  brokerageId, agentId, campaignName, subjectLine, content?, marketingCampaignId?
// Output: { campaignId }
// Tables write: newsletter_campaigns
// Rules:  canAccessFeature('email_campaigns'); content passes applyBrandVoice
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateNewsletterCampaignInput {
  ctx: MarketingActorContext
  campaignName: string
  subjectLine: string
  content?: string
  /** Optional umbrella marketing_campaigns id — same linkage createBlogDraft
   *  below already writes onto blog_posts.marketing_campaign_id. Verified
   *  against ctx.brokerageId before writing: the id is caller data even when
   *  the ctx is session-derived, and an unverified id would file this tenant's
   *  issue under another tenant's ROI rollup. */
  marketingCampaignId?: string
}

export async function createNewsletterCampaign(
  input: CreateNewsletterCampaignInput
): Promise<KernelMarketingResult<{ campaignId: string }>> {
  const { ctx, campaignName, subjectLine, content } = input
  if (!campaignName?.trim()) return { success: false, error: "Campaign name is required." }
  if (!subjectLine?.trim())  return { success: false, error: "Subject line is required." }

  const access = await canAccessFeature(ctx.userId, "email_campaigns")
  if (!access.allowed) return { success: false, error: access.reason ?? "Feature access denied" }

    const brandVoice = await applyKernelBrandVoice({
    brokerageId: ctx.brokerageId,
    actorUserId: ctx.userId,
    actorRole: "agent",
    journeyType: "seller",
    persona: "seller",
    messageType: "email",
    content: content ?? subjectLine,
  })

  const supabase = await createServiceClient()

  // Gate first, then use the service client (§4): this runs on the service
  // role, so the brokerage predicate below is the ONLY thing standing between
  // this insert and a cross-tenant campaign link.
  let marketingCampaignId: string | null = null
  if (input.marketingCampaignId) {
    const { data: umbrella, error: umbrellaError } = await supabase
      .from("marketing_campaigns")
      .select("id")
      .eq("id", input.marketingCampaignId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()
    if (umbrellaError) return { success: false, error: `Could not verify that campaign: ${umbrellaError.message}` }
    if (!umbrella) return { success: false, error: "That campaign is not on your brokerage." }
    marketingCampaignId = umbrella.id as string
  }

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
      approval_status: "pending_review",
      brand_compliance_passed: false,
      // The umbrella link the ROI measurer reads — verified above, never the
      // raw input id. Same shape as createBlogDraft's
      // blog_posts.marketing_campaign_id write later in this file.
      marketing_campaign_id: marketingCampaignId,
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
  // FAIL CLOSED ON A MISSING TENANT (§4). An empty brokerageId used to slide
  // through here: the campaign read below matched nothing (so the caller got
  // "Campaign not found" — closed by accident), but the real defect was the
  // INSERT further down, which wrote the ledger row with NO brokerage_id at
  // all — an untenanted row on a tenanted table, invisible to every
  // brokerage-scoped read of the ledger. The row now carries the same tenant
  // the campaign was verified against, and a caller with no tenant is refused
  // outright instead of by coincidence.
  if (!params.brokerageId) {
    return { success: false, error: "No brokerage in the caller's context — refusing to schedule an untenanted send." }
  }

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
    const compliance = await evaluateKernelOutbound({
    actorContext: {
      userId: params.userId,
      role: "agent",
      brokerageId: params.brokerageId,
    },
    journeyType: "seller",
    persona: "seller",
    messageType: "email",
    content: campaign.content,
    contact: {
      id: params.userId,
      status: "active",
    },
  })

  if (isComplianceBlocked(compliance)) {
    return { success: false, blockedReason: getComplianceReason(compliance) ?? "Compliance check failed", error: "Outbound compliance failed." }
  }

  // Count subscribers for estimated delivery
  const { count: recipientCount } = await supabase
    .from("newsletter_subscribers")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", params.brokerageId)
    .eq("status", "subscribed")

  const [updateResult, insertResult] = await Promise.all([
    supabase
      .from("newsletter_campaigns")
      .update({ status: "scheduled", send_date: params.scheduledTime })
      .eq("id", params.campaignId),
    supabase
      .from("newsletter_scheduled_sends")
      .insert({
        newsletter_id:   params.campaignId,
        // The tenant the campaign read above was verified against — this insert
        // used to carry NO brokerage_id, which is why the publish-newsletters
        // cron's ledger-close deliberately matches on newsletter_id alone
        // (app/api/cron/publish-newsletters/route.ts:588). New rows are
        // tenanted; the cron's match stays id-anchored so the old untenanted
        // rows still close.
        brokerage_id:    params.brokerageId,
        // `scheduled_time` is the SURVIVING spelling (§6). The table carries
        // both scheduled_time and scheduled_send_time; every reader —
        // lib/campaigns/roi-calculator.ts:365's window filter and the studio's
        // send list fallback (marketing-studio-client.tsx:2525) — reads
        // scheduled_time, and nothing reads scheduled_send_time. The sibling
        // writer (app/actions/newsletter/schedule-newsletter.ts) converged
        // onto this column in the same change.
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
    brokerageId: params.brokerageId,
    entityId:    params.campaignId,
    entityType:  "newsletter_campaign",
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

  const compliance = await evaluateKernelOutbound({
    actorContext: {
      userId: params.userId,
      brokerageId: params.brokerageId,
      role: "agent",
    },
    journeyType: "seller",
    persona: "other",
    messageType: "email",
    content: [campaign.subject_line, campaign.content].filter(Boolean).join("\n\n"),
    contact: {
      id: "",
      first_name: "",
      last_name: "",
      contact_type: "seller",
      tcpa_consent: true,
      isa_reengage_allowed: false,
      dnc_status: false,
    },
  })

if (!compliance.allowed) {
  return {
    success: false,
    blockedReason: compliance.blockedReason ?? compliance.violations[0],
    error: "Compliance check failed.",
  }
}
  if (!compliance.allowed) {
    return { success: false, blockedReason: compliance.blockedReason ?? compliance.violations[0], error: "Compliance check failed." }
  }

  const { error } = await supabase
    .from("newsletter_campaigns")
    .update({ status: "sent", send_date: new Date().toISOString() })
    .eq("id", params.campaignId)
    .eq("brokerage_id", params.brokerageId)

  if (error) return { success: false, error: error.message }

  await processKernelEvent({
    event:      KernelEvent.EMAIL_CAMPAIGN_SENT,
    brokerageId: params.brokerageId,
    entityId:   params.campaignId,
    entityType: "newsletter_campaign",
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
    brokerageId: params.brokerageId,
    entityId:   params.campaignId,
    entityType: "direct_mail_campaign",
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

    const brandVoice = await applyKernelBrandVoice({
    brokerageId: ctx.brokerageId,
    actorUserId: ctx.userId,
    actorRole: "agent",
    journeyType: "seller",
    persona: "seller",
    messageType: "email",
    content: input.content || input.title || input.keywords.join(", "),
  })

  let generatedTitle = input.title || ""
  let content        = input.content || ""
  let excerpt        = ""
  let slug           = ""

  if (!content && input.keywords.length > 0) {
        const systemPrompt = `You are a real estate content writer. Write in a professional style.
${brandVoice.notes.length ? `Brand guidance: ${brandVoice.notes.join(" | ")}` : ""}
${brandVoice.violations.length ? `Avoid: ${brandVoice.violations.join(", ")}` : ""}`

    const userPrompt = `Write a 600-800 word SEO blog post about: ${input.keywords.join(", ")}.
${input.title ? `Title: ${input.title}` : "Create an engaging title."}
Return valid JSON: {"title":"...","slug":"...","excerpt":"...","content":"..."}`

    try {
      const rawResult = await generateTextRouted({
        system:      systemPrompt,
        prompt:      userPrompt,
        brokerageId: ctx.brokerageId,
        feature:     "seo_blog_engine",
        userId:      ctx.userId,
      })
      const parsed = JSON.parse(rawResult.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim())
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
  const compliance = await evaluateKernelOutbound({
    actorContext: {
      userId: ctx.userId,
      role: "agent",
      brokerageId: ctx.brokerageId,
    },
    journeyType: "seller",
    persona: "seller",
    messageType: "email",
    content,
    contact: {
      id: ctx.userId,
      status: "active",
    },
  })
  if (isComplianceBlocked(compliance)) {
    return { success: false, blockedReason: getComplianceReason(compliance), error: "Blog content failed compliance check." }
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
  /**
   * 'in_house' (default for internal training; brand voice only) vs
   * 'customer_facing' (DNC/TCPA/fair-housing compliance gate applies on
   * distribute). The publisher infers this from the campaign's audience
   * but the kernel command lets the caller override.
   */
  audienceType?: "in_house" | "customer_facing"
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

  // Migration 1051: fold brokerage about_text + bio_text + brand voice into
  // brand_voice_context jsonb so HeyGen prompts (and the admin reviewer)
  // see what voice flavor the AI generation should carry.
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("name, about_text, bio_text")
    .eq("id", ctx.brokerageId)
    .maybeSingle()
  let brandVoiceTone: string | null = null
  try {
    const { data: bv } = await supabase
      .from("brand_voice_profile")
      .select("tone")
      .eq("brokerage_id", ctx.brokerageId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    brandVoiceTone = (bv?.tone as string | null) ?? null
  } catch {
    // brand_voice_profile lookup is best-effort
  }
  const brandVoiceContext = {
    brokerage_name:  (brokerage?.name       as string | null) ?? null,
    brokerage_about: (brokerage?.about_text as string | null) ?? null,
    brokerage_bio:   (brokerage?.bio_text   as string | null) ?? null,
    brand_voice_tone: brandVoiceTone,
    applied_at:      new Date().toISOString(),
  }

  // Migration 1052: resolve the actual provider (D-ID default, agent
  // voice profile override, brokerage global setting override). Was
  // hardcoded 'heygen' which was wrong — D-ID is the platform primary.
  const { resolveVideoProvider, initialProviderColumns } = await import("@/lib/marketing/video-provider-resolver")
  const provider     = await resolveVideoProvider(supabase, {
    brokerageId: ctx.brokerageId,
    agentUserId: ctx.userId ?? null,
  })
  const providerCols = initialProviderColumns(provider)

  // audience_type: caller passes explicitly when known; otherwise default
  // to 'customer_facing' (safer — over-restrict by default).
  const audienceType = input.audienceType ?? "customer_facing"

  // ai_video_projects.agent_id is a NOT NULL FK to agents(id). ctx.agentId is
  // caller-supplied and optional, so resolve from the authenticated users.id
  // instead of trusting it — and refuse rather than stage a project nobody owns.
  const videoAgentId = await resolveAgentIdInBrokerage(supabase, ctx.userId, ctx.brokerageId)
  if (!videoAgentId) {
    return { success: false, error: "No agent profile for this user in this brokerage — complete onboarding before generating video." }
  }

  const { data, error } = await supabase
    .from("ai_video_projects")
    .insert({
      brokerage_id:        ctx.brokerageId,
      agent_id:            videoAgentId,
      title:               input.title.trim(),
      script_content:      input.scriptContent.trim(),
      video_type:          input.videoType,
      listing_id:          input.listingId    ?? null,
      provider_template_id: input.templateId ?? null,
      status:              "draft",
      video_provider:      provider,
      ...providerCols,
      // Migration 1051: AI videos await admin approval before publish
      approval_status:     "pending_review",
      is_ai_generated:     true,
      audience_type:       audienceType,
      brand_voice_context: brandVoiceContext,
      created_at:          new Date().toISOString(),
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
    .select("status, video_url, title, approval_status, marketing_campaign_id, listing_id, audience_type, script_content, video_provider")
    .eq("id", params.projectId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!project) return { success: false, error: "Video project not found." }
  if (!project.video_url) {
    return { success: false, error: "Video is not yet generated. Preview the project first to confirm it is ready." }
  }
  // Any FINISHED asset may be distributed. Requiring exactly "completed" refused
  // an agent's own manual upload (`uploaded`, with a real video_url) and refused
  // a re-distribution, because a successful distribute rewrites the status to
  // "distributed" — success locked the video out of its own feature.
  if (!(VIDEO_FINISHED_STATUSES as readonly string[]).includes(project.status)) {
    return { success: false, error: `Video is not yet completed (current: ${project.status}).` }
  }
  // Migration 1051: AI-generated videos can't distribute until admin
  // approves. Reject pending_review / rejected.
  if (project.approval_status && project.approval_status !== "approved" && project.approval_status !== "published") {
    return { success: false, error: `Video is not yet approved (current: ${project.approval_status}).` }
  }

  // Migration 1052: customer-facing videos must pass the kernel's
  // outbound-communication compliance gate (DNC/TCPA/fair-housing). In-
  // house training videos (audience_type='in_house') skip this — they're
  // agent/staff/team education and don't go to external contacts.
  if (project.audience_type === "customer_facing") {
    try {
      const { evaluateKernelOutbound, isComplianceBlocked } = await import("@/lib/kernel/adapters/compliance")
      const compliance = await evaluateKernelOutbound({
        actorContext: {
          userId: params.userId,
          role: "agent",
          brokerageId: params.brokerageId,
        },
        journeyType: "buyer",         // resolver normalizes
        persona: "other",
        messageType: "social",         // closest video-channel kind in the kernel enum
        content: (project.script_content as string | null) ?? "",
        contact: undefined,
      })
      if (isComplianceBlocked(compliance)) {
        await supabase.from("ai_video_projects").update({
          compliance_status:     "failed",
          compliance_violations: compliance.violations ?? [],
          compliance_evaluated_at: new Date().toISOString(),
        }).eq("id", params.projectId)
        return { success: false, error: `Compliance blocked distribution: ${compliance.blockedReason ?? "review required"}` }
      }
      await supabase.from("ai_video_projects").update({
        compliance_status:     "passed",
        compliance_violations: [],
        compliance_evaluated_at: new Date().toISOString(),
      }).eq("id", params.projectId)
    } catch (err) {
      // Compliance adapter failure → mark needs_review, refuse to distribute
      await supabase.from("ai_video_projects").update({
        compliance_status:     "needs_review",
        compliance_violations: [{ error: err instanceof Error ? err.message : String(err) }],
        compliance_evaluated_at: new Date().toISOString(),
      }).eq("id", params.projectId)
      return { success: false, error: "Compliance evaluator unavailable; refusing to distribute customer-facing video." }
    }
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

  // Migration 1051: when this video is tied to a marketing_campaigns row,
  // distributing it counts as touchpoints for every audience contact.
  // Fire-and-forget; failures isolated. Skip when no campaign linkage.
  if (project.marketing_campaign_id) {
    try {
      const { recordCampaignTouchpointsBulkSafe } = await import("@/lib/marketing/touchpoint-recorder")
      const { resolveCampaignAudience } = await import("@/lib/marketing/audience-resolver")
      const { data: campaign } = await supabase
        .from("marketing_campaigns")
        .select("brokerage_id, audience_personas, audience_generations, audience_age_segs, audience_lead_source_tags, audience_buyer_stages, audience_contact_ids")
        .eq("id", project.marketing_campaign_id)
        .maybeSingle()
      if (campaign) {
        const audience = await resolveCampaignAudience(supabase, campaign.brokerage_id as string, {
          personas:       (campaign.audience_personas       as string[] | null) ?? [],
          generations:    (campaign.audience_generations    as string[] | null) ?? [],
          ageSegs:        (campaign.audience_age_segs       as string[] | null) ?? [],
          leadSourceTags: (campaign.audience_lead_source_tags as string[] | null) ?? [],
          buyerStages:    (campaign.audience_buyer_stages   as string[] | null) ?? [],
          contactIds:     (campaign.audience_contact_ids    as string[] | null) ?? undefined,
        })
        if (audience.contactIds.length > 0) {
          void recordCampaignTouchpointsBulkSafe(
            campaign.brokerage_id as string,
            project.marketing_campaign_id as string,
            audience.contactIds,
            "video",
            "manual",
          )
        }
      }
    } catch (err) {
      console.error("[distributeVideoAsset] touchpoint record failed:", err)
    }
  }

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

  if (!input.title?.trim()) {
    return { success: false, error: "Episode title is required." }
  }

  const access = await canAccessFeature(ctx.userId, "podcast_generation")
  if (!access.allowed) {
    return { success: false, error: access.reason ?? "Podcast generation access denied" }
  }

  if (input.script) {
    const compliance = await evaluateKernelOutbound({
      actorContext: {
        userId: ctx.userId,
        role: "agent",
        brokerageId: ctx.brokerageId,
      },
      journeyType: "seller",
      persona: "seller",
      messageType: "ai",
      content: input.script,
      contact: {
        id: ctx.userId,
        status: "active",
      },
    })

    if (isComplianceBlocked(compliance)) {
      return {
        success: false,
        blockedReason: getComplianceReason(compliance) ?? "Compliance failed",
        error: "Podcast script failed compliance check.",
      }
    }

    const brandVoice = await applyKernelBrandVoice({
      brokerageId: ctx.brokerageId,
      actorUserId: ctx.userId,
      actorRole: "agent",
      journeyType: "seller",
      persona: "seller",
      messageType: "email",
      content: input.script ?? input.description ?? input.title,
    })

    if (isBrandVoiceBlocked(brandVoice)) {
      return {
        success: false,
        blockedReason: brandVoice.violations[0] ?? "Brand voice compliance failed",
        error: "Podcast script failed brand voice check.",
      }
    }
  }

  const supabase = await createServiceClient()
  // podcast_episodes.agent_id is a NOT NULL FK to agents(id) — same resolve as
  // the video path, same refusal when the user has no agent profile.
  const episodeAgentId = await resolveAgentIdInBrokerage(supabase, ctx.userId, ctx.brokerageId)
  if (!episodeAgentId) {
    return { success: false, error: "No agent profile for this user in this brokerage — complete onboarding before creating a podcast episode." }
  }

  const { data, error } = await supabase
    .from("podcast_episodes")
    .insert({
      brokerage_id: ctx.brokerageId,
      agent_id: episodeAgentId,
      title: input.title.trim(),
      description: input.description ?? null,
      script: input.script ?? null,
      keywords: input.keywords ?? [],
      publish_channels: input.publishChannels ?? [],
      template_id: input.templateId ?? null,
      primary_voice_id: input.voiceId ?? null,
      category: input.category ?? null,
      status: "draft",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !data) {
    return { success: false, error: error?.message ?? "Insert failed" }
  }

  await incrementFeatureUsage(ctx.userId, "podcast_generation")

  return {
    success: true,
    data: { episodeId: data.id },
  }
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
    brokerageId: params.brokerageId,
    entityId:   params.episodeId,
    entityType: "podcast_episode",
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
  // ── AUDIENCE CRITERIA — the columns the launch gate reads ─────────────────
  // These six were read by publishMarketingCampaignSafe
  // (lib/marketing/campaign-publisher.ts:47-67) and by distributeVideoAsset's
  // touchpoint recorder (this file, line ~1141) and written by NOTHING, in
  // either creation path. resolveCampaignAudience reads an empty criteria array
  // as "no filter" (lib/marketing/audience-resolver.ts:64), so a campaign
  // created here resolved to EVERY contact in the brokerage up to its 5000-row
  // cap — and then launched against that. Accepting them here is the writer
  // half; the reader half was already built.
  audiencePersonas?:       string[]
  audienceGenerations?:    string[]
  audienceAgeSegs?:        string[]
  audienceLeadSourceTags?: string[]
  audienceBuyerStages?:    string[]
  /** Explicit pinned list — overrides every criterion above in the resolver. */
  audienceContactIds?:     string[]
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
      // The five text[] criteria are NOT NULL DEFAULT '{}' — an explicit empty
      // array says "no criterion" in the same words the resolver reads.
      // audience_contact_ids is nullable and the resolver reads `?? undefined`,
      // so its floor is NULL: an empty array there would mean "pinned to nobody".
      audience_personas:         input.audiencePersonas       ?? [],
      audience_generations:      input.audienceGenerations    ?? [],
      audience_age_segs:         input.audienceAgeSegs        ?? [],
      audience_lead_source_tags: input.audienceLeadSourceTags ?? [],
      audience_buyer_stages:     input.audienceBuyerStages    ?? [],
      audience_contact_ids:      input.audienceContactIds     ?? null,
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
    brokerageId: ctx.brokerageId,
    entityId:   data.id,
    entityType: "marketing_campaign",
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
      status:           "generated",
      approval_status:  "pending_review",
      notes:            params.notes ?? null,
      created_by:       ctx.userId,
      created_at:       new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }
  return { success: true, data: { logId: data.id } }
}

// ─── REMOVED in the QR merge (wave Q) ────────────────────────────────────────
//
// `createQrAsset(input)` + `CreateQrAssetInput` — MERGED-THEN-DELETED.
// SURVIVOR: lib/marketing/tracked-qr.ts:mintTrackedQr — the one QR minter, now the single
// writer of `qr_codes` for the whole tree.
//
// WHAT WAS MERGED ONTO THE SURVIVOR FIRST: `expires_at`. This function was the ONLY writer of
// that column anywhere in the tree, so deleting it without moving the capability would have made
// a live column dead schema — and app/api/qr/scan reads expires_at to refuse an expired code, so
// nothing would ever have expired. mintTrackedQr now takes `expiresAt`, and it is reachable from
// createQrCodeAction (app/actions/marketing-studio.ts) and the admin POST route — more callers
// than this function ever had.
//
// It was deleted rather than kept because it was BOTH a duplicate AND an orphan export: zero
// callers in the tree, its own fourth slug recipe (`qr-<epoch>-<rand>`), no idempotency (a retry
// minted a second code for the same thing), and it never set destination_type — so its codes were
// invisible to every destination-bucketed analytic and to the m148 scan-event metadata.
//
// `previewQrAsset` below is NOT a duplicate and stays: it is the only reader that surfaces
// expires_at alongside the scan/lead counters.

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
