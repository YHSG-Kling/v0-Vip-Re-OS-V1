"use server"

/**
 * app/actions/email-campaigns.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 9.7 — Email Campaign Engine Server Actions
 *
 * Full lifecycle: create → AI compose → preview → schedule/send → archive
 * Kernel gates: canAccessFeature('email_campaigns')
 * Kernel events: EMAIL_CAMPAIGN_CREATED, EMAIL_CAMPAIGN_SENT
 *
 * STORAGE: writes to `email_campaigns` table — distinct from `newsletter_campaigns`.
 *   - email_campaigns = one-off blasts, drip emails, transactional, segmented sends
 *   - newsletter_campaigns = recurring publication with sections + subscribers
 *
 * For newsletter creation see app/actions/ai-newsletter.ts and the Newsletter
 * Wizard. Do NOT write to newsletter_campaigns from this file.
 */

import { createClient } from "@/lib/supabase/server"
import { LIFETIME_CUSTOMER_SEGMENT } from "@/lib/contact-types"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import {
  canAccessFeature,
  incrementFeatureUsage,
  processKernelEvent,
  KernelEvent,
} from "@/lib/kernel"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { generateEmail } from "@/app/actions/ai-content-generation"

// Previously most actions in this file trusted caller-supplied
// brokerageId / createdBy / actorUserId / agentId. canAccessFeature
// is a feature-gate check, not an identity check — it accepts whatever
// user_id you pass it. The fix: always resolve identity from the session.
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  // supabase-js RESOLVES a refused read — destructure `error` or a blocked
  // lookup is indistinguishable from "user has no brokerage".
  const { data: u, error: userError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (userError) return { ok: false, error: `Could not resolve your brokerage: ${userError.message}` }
  if (!u?.brokerage_id) return { ok: false, error: "No brokerage associated with your account." }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface CreateEmailCampaignParams {
  brokerageId: string
  agentId?: string
  campaignName: string
  subjectLine: string
  content?: string
  sendDate?: string
  createdBy: string
  /**
   * THE UMBRELLA THIS EMAIL BELONGS TO — marketing_campaigns.id.
   *
   * `email_campaigns.marketing_campaign_id` was read in two places and written
   * in none. lib/orchestrator/internal.ts:835 fans a finished video (and
   * :1060 a finished image) into every asset sharing the umbrella, so a
   * rendered video could never be embedded into the campaign email it was made
   * for; lib/marketing/campaign-measurer.ts rolls child-asset engagement up to
   * the parent campaign, so the ROI board scored every umbrella at zero email
   * engagement. Same defect and same fix as qr_codes.marketing_campaign_id
   * (lib/marketing/tracked-qr.ts:122) — an FK with no writer.
   *
   * Optional: an email campaign that belongs to no umbrella is normal, and NULL
   * says exactly that.
   */
  marketingCampaignId?: string
  /**
   * THE AUDIENCE — contact_segments.segment_id.
   *
   * `email_campaigns.audience_segment_id` is read by
   * lib/marketing/email-campaign-sender.ts:56 and drives PATH B of the sender:
   * recipients resolved from active segment memberships. Nothing ever wrote the
   * column, so Path B was unreachable — every campaign fell through to the
   * broadcast path and went to the whole subscriber list, no matter what
   * audience the agent had in mind. A segmented send was a feature the schema
   * described and the product could not perform.
   *
   * Optional: no segment means the broadcast path, which is what already
   * happened for every campaign ever created here.
   */
  audienceSegmentId?: string
}

/**
 * The segments this brokerage actually has, derived from the membership ledger.
 *
 * There is NO segment catalogue table in this schema — `contact_segments`
 * .segment_id carries no FK and nothing names a segment (the contact page's
 * badge list records the same finding and shows an id prefix for the same
 * reason). So the honest list of segments is the DISTINCT set of ids that have
 * live members in the caller's own tenant, with that member count beside them:
 * derived from real rows, inventing no catalogue and no label.
 *
 * ACTIVE MEMBERSHIPS ONLY — `removed_at IS NULL` — the same filter the sender
 * applies, so a segment whose members have all been removed does not appear as
 * a choice that would send to nobody.
 */
export async function listAudienceSegments() {
  try {
    const auth = await requireCaller()
    if (!auth.ok) return { success: false as const, error: auth.error, segments: [] }

    const supabase = await createClient()
    const { data, error } = await supabase
      .from("contact_segments")
      .select("segment_id")
      .eq("brokerage_id", auth.brokerageId)
      .is("removed_at", null)
      .limit(10_000)
    // A refused read must not render as "this brokerage has no segments" — that
    // reads as a clean empty picker and the agent silently broadcasts instead.
    if (error) return { success: false as const, error: error.message, segments: [] }

    const counts = new Map<string, number>()
    for (const row of (data ?? []) as Array<{ segment_id: string | null }>) {
      if (!row.segment_id) continue
      counts.set(row.segment_id, (counts.get(row.segment_id) ?? 0) + 1)
    }
    const segments = [...counts.entries()]
      .map(([segmentId, memberCount]) => ({ segmentId, memberCount }))
      .sort((a, b) => b.memberCount - a.memberCount)
    return { success: true as const, segments }
  } catch (error) {
    return handleError(error, "listAudienceSegments")
  }
}

export interface UpdateEmailCampaignParams {
  campaignName?: string
  subjectLine?: string
  content?: string
  /** email_campaigns.preview_text — the inbox preheader. */
  previewText?: string
  sendDate?: string
  /** Subset of the live email_campaigns_status_check vocabulary
   *  (draft|scheduled|sending|sent|paused|cancelled|failed). The send-state
   *  literals are owned by lib/marketing/email-campaign-sender and are
   *  deliberately NOT settable here. */
  status?: "draft" | "scheduled" | "sent" | "cancelled"
  approvalStatus?: "pending" | "approved" | "rejected"
}

export interface AiComposeEmailParams {
  brokerageId: string
  agentId?: string
  topic: string
  audience?: "buyers" | "sellers" | "investors" | typeof LIFETIME_CUSTOMER_SEGMENT | "all"
  tone?: "professional" | "friendly" | "urgent" | "informational"
  campaignId?: string
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

export async function createEmailCampaign(params: CreateEmailCampaignParams) {
  try {
    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const access = await canAccessFeature(auth.userId, "email_campaigns")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Email campaigns feature not available" }
    }

    const supabase = await createClient()

    // THE UMBRELLA MUST BE ONE OF OURS. An FK proves a marketing_campaigns row
    // exists; it never proves the row belongs to the caller's brokerage, and
    // attaching this tenant's email to another tenant's campaign would feed
    // their ROI rollup and their video fan-out. Same gate, same wording as
    // app/actions/marketing-studio.ts:1098 where this pattern already stands.
    let marketingCampaignId: string | null = null
    if (params.marketingCampaignId) {
      if (!isValidUUID(params.marketingCampaignId)) {
        return { success: false, error: "Invalid campaign ID" }
      }
      const { data: umbrella, error: umbrellaError } = await supabase
        .from("marketing_campaigns")
        .select("id")
        .eq("id", params.marketingCampaignId)
        .eq("brokerage_id", auth.brokerageId)
        .maybeSingle()
      if (umbrellaError) {
        return { success: false, error: `Could not verify that campaign: ${umbrellaError.message}` }
      }
      if (!umbrella) return { success: false, error: "That campaign is not on your brokerage." }
      marketingCampaignId = umbrella.id as string
    }

    // THE SEGMENT MUST HAVE MEMBERS IN THIS TENANT. contact_segments.segment_id
    // has no FK and no catalogue, so "does this segment exist" can only be
    // answered by "does anyone in MY brokerage belong to it" — which is also
    // exactly the question the sender will ask when it resolves recipients. A
    // campaign pointed at a segment with no local members would claim an
    // audience and send to nobody.
    let audienceSegmentId: string | null = null
    if (params.audienceSegmentId) {
      if (!isValidUUID(params.audienceSegmentId)) {
        return { success: false, error: "Invalid segment ID" }
      }
      const { data: member, error: segmentError } = await supabase
        .from("contact_segments")
        .select("id")
        .eq("segment_id", params.audienceSegmentId)
        .eq("brokerage_id", auth.brokerageId)
        .is("removed_at", null)
        .limit(1)
        .maybeSingle()
      if (segmentError) {
        return { success: false, error: `Could not verify that segment: ${segmentError.message}` }
      }
      if (!member) return { success: false, error: "That segment has no active members on your brokerage." }
      audienceSegmentId = params.audienceSegmentId
    }

    const { data: campaign, error } = await supabase
      .from("email_campaigns")
      .insert({
        brokerage_id: auth.brokerageId,  // from session, not params
        agent_id: params.agentId ?? null,
        marketing_campaign_id: marketingCampaignId,
        audience_segment_id: audienceSegmentId,
        campaign_name: params.campaignName,
        subject_line: params.subjectLine,
        content: params.content ?? "",
        status: "draft",
        approval_status: "pending",
        created_by: auth.userId,  // from session
        send_date: params.sendDate ?? null,
        brand_compliance_passed: false,
      })
      .select()
      .maybeSingle()

    if (error || !campaign) throw error ?? new Error("Failed to create campaign")

    await incrementFeatureUsage(auth.userId, "email_campaigns").catch(() => {})

    await processKernelEvent({
      event: KernelEvent.EMAIL_CAMPAIGN_CREATED,
      brokerageId: auth.brokerageId,
      entityType: "newsletter_campaign",
      entityId: campaign.id,
    }).catch((err) => {
      console.error("[EmailCampaigns] Event processing failed (non-blocking):", err)
    })

    revalidatePath("/dashboard/marketing/studio")
    revalidatePath("/newsletters")
    return { success: true, campaign }
  } catch (error) {
    return handleError(error, "createEmailCampaign")
  }
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

export async function getEmailCampaigns(_brokerageId?: string, agentId?: string) {
  try {
    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = await createClient()

    let query = supabase
      .from("email_campaigns")
      .select("*")
      .eq("brokerage_id", auth.brokerageId)
      .order("created_at", { ascending: false })

    if (agentId) {
      query = query.eq("agent_id", agentId)
    }

    const { data, error } = await query

    if (error) throw error

    return { success: true, campaigns: data || [] }
  } catch (error) {
    return handleError(error, "getEmailCampaigns")
  }
}

// ─── GET ONE ──────────────────────────────────────────────────────────────────

export async function getEmailCampaign(campaignId: string) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("email_campaigns")
      .select("*")
      .eq("id", campaignId)
      .eq("brokerage_id", auth.brokerageId)
      .maybeSingle()

    if (error) throw error
    if (!data) return { success: false, error: "Campaign not found" }

    return { success: true, campaign: data }
  } catch (error) {
    return handleError(error, "getEmailCampaign")
  }
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

export async function updateEmailCampaign(
  campaignId: string,
  _actorUserId: string,  // ignored — derived from session
  updates: UpdateEmailCampaignParams
) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = await createClient()

    const { data: existing, error: existingError } = await supabase
      .from("email_campaigns")
      .select("status, brokerage_id")
      .eq("id", campaignId)
      .maybeSingle()

    if (existingError) throw existingError
    if (!existing) return { success: false, error: "Campaign not found" }
    if (existing.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Forbidden" }
    }
    if (existing.status === "sent") {
      return { success: false, error: "Cannot update a sent campaign" }
    }
    // The sender owns the row once it is in flight — don't race it.
    if (existing.status === "sending") {
      return { success: false, error: "Campaign is currently sending" }
    }

    const payload: Record<string, unknown> = {}
    if (updates.campaignName !== undefined) payload.campaign_name = updates.campaignName
    if (updates.subjectLine !== undefined) payload.subject_line = updates.subjectLine
    if (updates.content !== undefined) payload.content = updates.content
    if (updates.previewText !== undefined) payload.preview_text = updates.previewText
    if (updates.sendDate !== undefined) payload.send_date = updates.sendDate
    if (updates.status !== undefined) payload.status = updates.status
    if (updates.approvalStatus !== undefined) payload.approval_status = updates.approvalStatus

    const { data, error } = await supabase
      .from("email_campaigns")
      .update(payload)
      .eq("id", campaignId)
      .eq("brokerage_id", auth.brokerageId)
      .select()
      .maybeSingle()

    if (error) throw error
    if (!data) return { success: false, error: "Update was refused — campaign not found in your brokerage" }

    revalidatePath("/dashboard/marketing/studio")
    revalidatePath("/newsletters")
    return { success: true, campaign: data }
  } catch (error) {
    return handleError(error, "updateEmailCampaign")
  }
}

// ─── DELETE / ARCHIVE ─────────────────────────────────────────────────────────

export async function deleteEmailCampaign(campaignId: string) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = await createClient()

    const { data: existing, error: existingError } = await supabase
      .from("email_campaigns")
      .select("status, brokerage_id")
      .eq("id", campaignId)
      .maybeSingle()

    if (existingError) throw existingError
    if (!existing) return { success: false, error: "Campaign not found" }
    if (existing.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Forbidden" }
    }
    if (existing.status === "sent") {
      return { success: false, error: "Cannot delete a sent campaign" }
    }

    const { error } = await supabase
      .from("email_campaigns")
      .delete()
      .eq("id", campaignId)
      .eq("brokerage_id", auth.brokerageId)

    if (error) throw error

    revalidatePath("/dashboard/marketing/studio")
    revalidatePath("/newsletters")
    return { success: true }
  } catch (error) {
    return handleError(error, "deleteEmailCampaign")
  }
}

// ─── AI COMPOSE ───────────────────────────────────────────────────────────────

export async function aiComposeEmail(params: AiComposeEmailParams) {
  try {
    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    // Apply brand voice — uses session brokerage, not params
    const brandVoice = await applyBrandVoice({
      brokerageId: auth.brokerageId,
      actorUserId: auth.userId,
      actorRole: "agent",
      journeyType: "seller",
      persona: "seller",
      messageType: "email",
      content: "",
    })

    const toneFromBrandVoice = brandVoice.notes?.find(n => n.toLowerCase().startsWith("target tone:"))?.replace(/^target tone:\s*/i, "").trim()
    const tone = params.tone ?? toneFromBrandVoice ?? "professional"
    const audience = params.audience ?? "all"

    const systemPrompt = `You are a real estate email marketing expert. Write in a ${tone} tone.
Target audience: ${audience}.`

    const userPrompt = `Write a professional real estate email campaign about: "${params.topic}".
Return ONLY valid JSON with NO markdown:
{
  "subject": "Compelling subject line (under 60 chars)",
  "preheader": "Preview text (under 90 chars)",
  "body": "Full email body in HTML with proper headings, paragraphs, and a clear CTA"
}`

    const { text } = await generateText({
      feature: "email_generation",
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.7,
      brokerageId: auth.brokerageId,
    })

    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim()
    const result = JSON.parse(cleaned) as {
      subject: string
      preheader: string
      body: string
    }

    return { success: true, subject: result.subject, preheader: result.preheader, body: result.body }
  } catch (error) {
    console.error("[aiComposeEmail] failed:", error)
    return { success: false, error: "Failed to compose email" }
  }
}

// ─── SEND ─────────────────────────────────────────────────────────────────────

export async function sendEmailCampaign(campaignId: string, _actorUserId?: string, _brokerageId?: string) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const access = await canAccessFeature(auth.userId, "email_campaigns")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Email campaigns feature not available" }
    }

    const actorUserId = auth.userId
    const brokerageId = auth.brokerageId

    const supabase = await createClient()

    const { data: campaign, error: campaignError } = await supabase
      .from("email_campaigns")
      .select("id, status, brokerage_id")
      .eq("id", campaignId)
      .maybeSingle()

    if (campaignError) throw campaignError
    if (!campaign) return { success: false, error: "Campaign not found" }
    if (campaign.brokerage_id !== brokerageId) {
      return { success: false, error: "Forbidden" }
    }

    // ONE sender (lib/marketing/email-campaign-sender) serves this manual
    // action AND the send-email-campaigns cron — auth here, egress there
    // (every message rides the consent-gated dispatchEmail). It resolves
    // content from the campaign body OR the linked template (listing
    // campaigns keep their content in email_templates) and drains queued
    // email_sends rows when they exist.
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { sendCampaignNow } = await import("@/lib/marketing/email-campaign-sender")
    const result = await sendCampaignNow(createServiceClient(), campaignId)
    if (!result.ok) return { success: false, error: result.error ?? "Send failed" }

    void actorUserId // auth-derived; the sender attributes from the campaign's agent

    revalidatePath("/dashboard/marketing/studio")
    revalidatePath("/newsletters")
    return { success: true, recipientCount: result.recipients, sent: result.sent, failed: result.failed }
  } catch (error) {
    return handleError(error, "sendEmailCampaign")
  }
}

// ─── SCHEDULE ─────────────────────────────────────────────────────────────────
//
// WHY scheduleEmailCampaign AND deleteEmailCampaign HAVE NO CALLERS (read this
// before "cleaning them up", and before wiring them to anything).
//
// Their only caller used to be app/newsletters/newsletters-client.tsx, which
// passed a `newsletter_campaigns` id into actions that query `email_campaigns`.
// Different table, different id space — so the list's Schedule and Delete
// buttons answered "Campaign not found" on every click, exactly as its Send
// button did before it was repointed. All three now call the newsletter lane
// (scheduleExistingNewsletter / deleteNewsletterCampaign / sendNewsletter).
//
// That leaves these two correct but unwired, and they must NOT be deleted:
//   · They are not duplicates of the newsletter actions. `email_campaigns` is a
//     separate, live table with its own drain — the send-email-campaigns cron
//     every 15 min — which consumes exactly the status='scheduled' + send_date
//     that scheduleEmailCampaign writes.
//   · They are the same shape of orphan as sendEmailCampaign: the manual
//     counterpart to a live autonomous lane, waiting on an email-campaign
//     management surface that has not been built yet.
//
// The work to finish is that surface. Do not satisfy the orphan count by
// pointing these at newsletters again — that is the defect this comment exists
// to stop from coming back.

export async function scheduleEmailCampaign(
  campaignId: string,
  _actorUserId?: string,  // ignored — derived from session
  scheduledDate?: string
) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }
    if (!scheduledDate) {
      return { success: false, error: "scheduledDate is required" }
    }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = await createClient()

    const { data: existing, error: existingError } = await supabase
      .from("email_campaigns")
      .select("status, content, subject_line, brokerage_id")
      .eq("id", campaignId)
      .maybeSingle()

    if (existingError) throw existingError
    if (!existing) return { success: false, error: "Campaign not found" }
    if (existing.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Forbidden" }
    }
    if (existing.status === "sent") return { success: false, error: "Cannot schedule a sent campaign" }
    if (!existing.content) return { success: false, error: "Add content before scheduling" }
    if (!existing.subject_line) return { success: false, error: "Add a subject line before scheduling" }

    const { data, error } = await supabase
      .from("email_campaigns")
      .update({
        status: "scheduled",
        send_date: scheduledDate,
      })
      .eq("id", campaignId)
      .eq("brokerage_id", auth.brokerageId)
      .select()
      .maybeSingle()

    if (error) throw error

    revalidatePath("/dashboard/marketing/studio")
    revalidatePath("/newsletters")
    return { success: true, campaign: data }
  } catch (error) {
    return handleError(error, "scheduleEmailCampaign")
  }
}

// ─── STATS ────────────────────────────────────────────────────────────────────

export async function getEmailCampaignStats(_brokerageId?: string) {
  try {
    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = await createClient()

    const [campaignsResult, subscribersResult] = await Promise.all([
      supabase
        .from("email_campaigns")
        .select("id, status, open_rate, click_rate")
        .eq("brokerage_id", auth.brokerageId),
      supabase
        .from("newsletter_subscribers")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", auth.brokerageId)
        .eq("status", "subscribed"),
    ])

    // Both legs are reads that can be REFUSED; `|| []` on data alone reports a
    // blocked query as "you have zero campaigns / zero subscribers".
    if (campaignsResult.error) throw campaignsResult.error
    if (subscribersResult.error) throw subscribersResult.error

    const campaigns = campaignsResult.data || []
    const activeCampaigns = campaigns.filter((c) => c.status === "scheduled").length
    const sentCampaigns = campaigns.filter((c) => c.status === "sent")
    const avgOpenRate =
      sentCampaigns.length > 0
        ? sentCampaigns.reduce((sum, c) => sum + (c.open_rate ?? 0), 0) / sentCampaigns.length
        : null

    return {
      success: true,
      stats: {
        totalCampaigns: campaigns.length,
        activeCampaigns,
        totalSubscribers: subscribersResult.count ?? 0,
        avgOpenRate,
      },
    }
  } catch (error) {
    return handleError(error, "getEmailCampaignStats")
  }
}

// ─── LISTING-SPECIFIC EMAIL CAMPAIGNS (migrated from email-campaign-automation.ts) ───

export async function prepareListingEmailCampaign(params: {
  transactionId: string
  campaignType: "coming_soon" | "launch" | "open_house" | "price_drop" | "sold"
}) {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }

  const supabase = await createClient()

  try {
    // Auth + feature gate — must match the pattern used by createEmailCampaign / sendEmailCampaign
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return { success: false, error: "Unauthorized" }
    }
    const access = await canAccessFeature(user.id, "email_campaigns")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Email campaigns feature not available" }
    }

    // NOTE: this used to embed `listing_photos(*)` off `transactions`. There is
    // no FK from transactions to that table, so PostgREST rejected the whole
    // select and this action threw before it ever sent. Photos are read
    // separately below, from the listing they actually hang off.
    const { data: transaction, error: transactionError } = await supabase
      .from("transactions")
      .select("*, listings(*)")
      .eq("id", params.transactionId)
      .maybeSingle()

    if (transactionError) throw transactionError
    if (!transaction || !transaction.listings) {
      return { success: false, error: "Transaction not found" }
    }

    const listing = transaction.listings

    // MEDIA PAIRING (owner rule: nothing ships bare) — a listing email
    // without the listing's photo is a text blast. Hero (is_primary first,
    // else primary_photo_url, else the first photo by MLS order) rides at the
    // top of the template body.
    //
    // media_type is pinned to 'photo': listing_media also holds video,
    // floorplan, virtual_tour and document rows, and emailing a PDF's URL as an
    // <img src> ships a broken image to every recipient.
    const { data: photoRowsRaw, error: photoError } = await supabase
      .from("listing_media")
      .select("file_url, is_primary")
      .eq("listing_id", listing.id)
      .eq("media_type", "photo")
      .order("sort_order", { ascending: true })
    if (photoError) {
      console.error("[email-campaigns] listing photo read failed:", photoError.message)
    }
    const photoRows = (photoRowsRaw ?? []) as Array<{ file_url: string | null; is_primary: boolean | null }>
    const heroUrl =
      photoRows.find((p) => p.is_primary && p.file_url)?.file_url ??
      (listing as any).primary_photo_url ??
      photoRows.find((p) => p.file_url)?.file_url ?? null
    const heroHtml = heroUrl
      ? `<img src="${heroUrl}" alt="${String(listing.address ?? "Listing").replace(/"/g, "&quot;")}" style="width:100%;max-width:640px;border-radius:8px;display:block;margin:0 auto 16px;" />`
      : ""

    const emailContent = await generateEmail({
      agentId: transaction.agent_id,
      emailType: params.campaignType as any,
      propertyIds: [listing.id],
    })

    if (!emailContent.success) {
      return { success: false, error: "Failed to generate email content" }
    }

    const recipients = await getListingCampaignRecipients(params.transactionId, params.campaignType, listing)

    const brokerageId = (listing as any).brokerage_id ?? transaction.brokerage_id ?? null
    if (!brokerageId) {
      return { success: false, error: "Could not resolve brokerage for campaign" }
    }
    const emailSubject = emailContent.data?.subject || `New Listing: ${listing.address}`

    // email_campaigns: subject_line NOT NULL; campaign_format (CHECK one_off|drip|...) replaces
    // phantom campaign_type; audience_filter jsonb replaces phantom target_segment.
    const { data: campaign, error } = await supabase
      .from("email_campaigns")
      .insert({
        brokerage_id: brokerageId,
        agent_id: transaction.agent_id,
        campaign_name: `${params.campaignType} - ${listing.address}`,
        subject_line: emailSubject,
        campaign_format: "one_off",
        audience_filter: { segment: determineListingSegment(params.campaignType) },
        status: "draft",
      })
      .select()
      .single()

    if (error) throw error

    if (!emailContent.data?.generated_content) {
      return { success: false, error: "AI failed to generate email content" }
    }

    // email_templates canonical columns: name/slug(NOT NULL)/subject/body/template_type(CHECK).
    const TEMPLATE_TYPE_MAP: Record<string, string> = {
      coming_soon: "offer",
      launch: "offer",
      open_house: "reminder",
      price_drop: "offer",
      sold: "closing",
    }
    const { data: template, error: templateError } = await supabase
      .from("email_templates")
      .insert({
        brokerage_id: brokerageId,
        name: `${params.campaignType} - ${listing.address}`,
        slug: `${params.campaignType}-${listing.id}-${Date.now()}`,
        template_type: TEMPLATE_TYPE_MAP[params.campaignType] ?? "followup",
        subject: emailSubject,
        body: `${heroHtml}${emailContent.data.generated_content}`,
        variables: {
          property_address: listing.address,
          property_city: listing.city,
          property_price: listing.price,
          property_bedrooms: listing.bedrooms,
          property_bathrooms: listing.bathrooms,
        },
      })
      .select()
      .single()

    if (templateError) throw templateError
    if (template) {
      const { error: linkError } = await supabase
        .from("email_campaigns")
        .update({ template_id: template.id })
        .eq("id", campaign.id)
      if (linkError) throw linkError
    }

    // A refused email_sends insert used to vanish: the campaign reported N
    // recipients while the queue the sender drains stayed empty.
    //
    // brokerage_id is stamped explicitly from `brokerageId` above — resolved
    // from the listing/transaction this session was allowed to READ (both
    // tables' SELECT policies are strictly tenant-scoped with no NULL escape),
    // so it is session-authorized, not inherited from params.transactionId.
    // Migration 052 installs a BEFORE INSERT trigger that would denormalize it
    // off email_campaigns, but it only fires when the column is NULL and runs
    // with the caller's rights; an email_sends row names a real contact and the
    // campaign that targeted them — recipient-targeting data — and the SELECT
    // policy's `brokerage_id IS NULL` branch publishes an unstamped row to every
    // signed-in user of every other brokerage. That guarantee should not rest on
    // a trigger.
    const uniqueRecipients = [...new Set(recipients.filter(Boolean))]
    let queued = 0
    for (const contactId of uniqueRecipients) {
      const { error: queueError } = await supabase.from("email_sends").insert({
        brokerage_id: brokerageId,
        campaign_id: campaign.id,
        contact_id: contactId,
        status: "queued",
      })
      if (queueError) {
        console.error("[prepareListingEmailCampaign] could not queue recipient:", queueError.message)
        continue
      }
      queued++
    }

    revalidatePath("/dashboard/listings")
    return {
      success: true,
      campaign_id: campaign.id,
      recipients: queued,
      recipientsRequested: uniqueRecipients.length,
      subject: emailContent.data?.subject,
    }
  } catch (error) {
    console.error("Prepare listing email campaign error:", error)
    return { success: false, error: "Failed to prepare campaign" }
  }
}

/**
 * `transactionId` WAS ACCEPTED HERE AND READ BY NOTHING until 2026-08-24 — and it is
 * the only thing that knows WHO IS ALREADY ON THIS DEAL.
 *
 * Every branch below builds a marketing blast about one listing, and none of them
 * excluded that listing's own parties. So the seller of the home received the
 * "coming soon" and "price drop" campaigns about their own house, and the buyer under
 * contract received the launch blast for the property they are in escrow on. Those
 * are not cold prospects; they are clients mid-transaction, and a price-drop email is
 * the worst possible way for either of them to hear it.
 *
 * The deal's parties are resolved once and removed from whatever each branch returns.
 * The transaction read is TENANT-SCOPED on the listing's own brokerage (§4) — the
 * caller hands in a transaction id, and an id from another brokerage must resolve to
 * nothing rather than to that brokerage's contacts.
 *
 * `property_interactions` picked up the same tenant predicate while we were here: it
 * carries `brokerage_id` (scripts/schema-snapshot.ts) and both reads keyed on
 * `listing_id` alone.
 */
async function getListingCampaignRecipients(
  transactionId: string,
  campaignType: string,
  listing: any,
): Promise<string[]> {
  const supabase = await createClient()

  const excluded = new Set<string>()
  if (transactionId) {
    const { data: deal, error: dealError } = await supabase
      .from("transactions")
      .select("contact_id, buyer_contact_id, seller_contact_id")
      .eq("id", transactionId)
      .eq("brokerage_id", listing.brokerage_id)
      .maybeSingle()
    // supabase-js RESOLVES refusals (§3): a swallowed error here would silently put
    // the deal's own parties back on the blast list.
    if (dealError) throw dealError
    for (const id of [deal?.contact_id, deal?.buyer_contact_id, deal?.seller_contact_id]) {
      if (id) excluded.add(id as string)
    }
  }
  const withoutDealParties = (ids: (string | null | undefined)[]) =>
    ids.filter((id): id is string => !!id && !excluded.has(id))

  if (campaignType === "coming_soon" || campaignType === "launch") {
    const { data: contacts, error: contactsError } = await supabase
      .from("contacts")
      .select("id")
      .eq("brokerage_id", listing.brokerage_id)
      .eq("status", "active")
      .gte("budget_max", (listing.price || 0) * 0.9)
      .lte("budget_min", (listing.price || 0) * 1.1)
    if (contactsError) throw contactsError
    return withoutDealParties((contacts ?? []).map((c) => c.id))
  }

  if (campaignType === "open_house") {
    const { data: interested, error: interestedError } = await supabase
      .from("property_interactions")
      .select("contact_id")
      .eq("listing_id", listing.id)
      .eq("brokerage_id", listing.brokerage_id)
      .in("interaction_type", ["view", "save"])
    if (interestedError) throw interestedError
    return withoutDealParties((interested ?? []).map((i) => i.contact_id))
  }

  if (campaignType === "price_drop") {
    const { data: viewers, error: viewersError } = await supabase
      .from("property_interactions")
      .select("contact_id")
      .eq("listing_id", listing.id)
      .eq("brokerage_id", listing.brokerage_id)
      .eq("interaction_type", "view")
    if (viewersError) throw viewersError
    return withoutDealParties((viewers ?? []).map((v) => v.contact_id))
  }

  const { data: allContacts, error: allContactsError } = await supabase.from("contacts").select("id")
    .eq("brokerage_id", listing.brokerage_id).eq("status", "active").limit(100)
  if (allContactsError) throw allContactsError
  return withoutDealParties((allContacts ?? []).map((c) => c.id))
}

function determineListingSegment(campaignType: string): string {
  const segments: Record<string, string> = {
    coming_soon: "matching_buyers",
    launch: "all_database",
    open_house: "interested_buyers",
    price_drop: "previous_viewers",
    sold: "sphere",
  }
  return segments[campaignType] || "all_database"
}
