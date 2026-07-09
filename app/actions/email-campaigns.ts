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
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
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
}

export interface UpdateEmailCampaignParams {
  campaignName?: string
  subjectLine?: string
  content?: string
  sendDate?: string
  status?: "draft" | "scheduled" | "sent" | "cancelled"
  approvalStatus?: "pending" | "approved" | "rejected"
}

export interface AiComposeEmailParams {
  brokerageId: string
  agentId?: string
  topic: string
  audience?: "buyers" | "sellers" | "investors" | "lifetime_customers" | "all"
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

    const { data: campaign, error } = await supabase
      .from("email_campaigns")
      .insert({
        brokerage_id: auth.brokerageId,  // from session, not params
        agent_id: params.agentId ?? null,
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

    const { data: existing } = await supabase
      .from("email_campaigns")
      .select("status, brokerage_id")
      .eq("id", campaignId)
      .maybeSingle()

    if (!existing) return { success: false, error: "Campaign not found" }
    if (existing.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Forbidden" }
    }
    if (existing.status === "sent") {
      return { success: false, error: "Cannot update a sent campaign" }
    }

    const payload: Record<string, unknown> = {}
    if (updates.campaignName !== undefined) payload.campaign_name = updates.campaignName
    if (updates.subjectLine !== undefined) payload.subject_line = updates.subjectLine
    if (updates.content !== undefined) payload.content = updates.content
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

    const { data: existing } = await supabase
      .from("email_campaigns")
      .select("status, brokerage_id")
      .eq("id", campaignId)
      .maybeSingle()

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

    const { data: campaign } = await supabase
      .from("email_campaigns")
      .select("id, status, content, subject_line, agent_id, brokerage_id")
      .eq("id", campaignId)
      .maybeSingle()

    if (!campaign) return { success: false, error: "Campaign not found" }
    if (campaign.brokerage_id !== brokerageId) {
      return { success: false, error: "Forbidden" }
    }
    if (campaign.status === "sent" || campaign.status === "sending") {
      return { success: false, error: "Campaign already sent or currently sending" }
    }
    if (!campaign.content) return { success: false, error: "Campaign has no content to send" }

    // Use service client so we can read subscribers across all agents in the brokerage
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()

    // Resolve from_email from the campaign agent's profile (or actorUserId)
    const agentId = campaign.agent_id ?? actorUserId
    let fromEmail = "noreply@example.com"
    const { data: agentUser } = await svc
      .from("users")
      .select("email, first_name, last_name")
      .eq("id", agentId)
      .maybeSingle()
    if (agentUser?.email) {
      fromEmail = agentUser.email
    }

    // Fetch subscribed recipients — newsletter_subscribers.brokerage_id is NOT NULL
    // and exists on every row, so a single brokerage-scoped query covers both
    // the agent-specific and brokerage-wide cases. When campaign.agent_id is
    // set we additionally narrow to that agent's list. CANONICAL status is
    // 'subscribed' (the CHECK constraint forbids 'active' — it matched zero rows).
    let subscriberQuery = svc
      .from("newsletter_subscribers")
      .select("id, email, first_name, last_name, contact_id")
      .eq("brokerage_id", brokerageId)
      .eq("status", "subscribed")
    if (campaign.agent_id) {
      subscriberQuery = subscriberQuery.eq("agent_id", campaign.agent_id)
    }
    const { data: subscribersData } = await subscriberQuery
    const subscribers: Array<{ id: string; email: string; first_name: string | null; last_name: string | null; contact_id: string | null }> = subscribersData ?? []

    // Deduplicate by email so a contact subscribed to multiple agents only gets one copy
    const seen = new Set<string>()
    const uniqueSubs = subscribers.filter(s => {
      if (seen.has(s.email)) return false
      seen.add(s.email)
      return true
    })

    if (uniqueSubs.length === 0) {
      return { success: false, error: "No active subscribers found for this campaign" }
    }

    // Mark as sending before the loop so concurrent re-sends are blocked
    await svc
      .from("email_campaigns")
      .update({ status: "sending" })
      .eq("id", campaignId)
      .eq("brokerage_id", brokerageId)

    const { dispatchEmail } = await import("@/lib/providers/dispatch")
    let sent = 0
    let failed = 0

    for (const sub of uniqueSubs) {
      const result = await dispatchEmail({
        brokerageId,
        userId: agentId,
        from: fromEmail,
        to: sub.email,
        subject: campaign.subject_line,
        html: campaign.content,
        contactId: sub.contact_id ?? undefined,
        channelPurpose: "campaign",
        systemSource: "email_campaign",
        metadata: { campaign_id: campaignId, subscriber_id: sub.id },
      })

      // Per-recipient tracking goes through newsletter_sends when the subscriber
      // is linked to a contact. Subscribers without a contact_id are counted in
      // the campaign-level totals only.
      if (sub.contact_id) {
        await svc.from("newsletter_sends").insert({
          brokerage_id: brokerageId,
          contact_id:   sub.contact_id,
          campaign_id:  campaignId,
          subject:      campaign.subject_line,
          status:       result.success ? "sent" : "failed",
          sent_at:      result.success ? new Date().toISOString() : null,
        })
      }

      if (result.success) sent++; else failed++
    }

    // Mark final status with real counts
    await svc
      .from("email_campaigns")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        recipient_count: uniqueSubs.length,
        delivered_count: sent,
      })
      .eq("id", campaignId)
      .eq("brokerage_id", brokerageId)

    await processKernelEvent({
      event: KernelEvent.EMAIL_CAMPAIGN_SENT,
      brokerageId,
      entityType: "newsletter_campaign",
      entityId: campaignId,
    }).catch((err) => {
      console.error("[EmailCampaigns] Send event failed (non-blocking):", err)
    })

    revalidatePath("/dashboard/marketing/studio")
    revalidatePath("/newsletters")
    return { success: true, recipientCount: uniqueSubs.length, sent, failed }
  } catch (error) {
    return handleError(error, "sendEmailCampaign")
  }
}

// ─── SCHEDULE ─────────────────────────────────────────────────────────────────

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

    const { data: existing } = await supabase
      .from("email_campaigns")
      .select("status, content, subject_line, brokerage_id")
      .eq("id", campaignId)
      .maybeSingle()

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
        .eq("status", "active"),
    ])

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

    const { data: transaction } = await supabase
      .from("transactions")
      .select("*, listings(*), listing_photos(*)")
      .eq("id", params.transactionId)
      .single()

    if (!transaction || !transaction.listings) {
      return { success: false, error: "Transaction not found" }
    }

    const listing = transaction.listings

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
    const { data: template } = await supabase
      .from("email_templates")
      .insert({
        brokerage_id: brokerageId,
        name: `${params.campaignType} - ${listing.address}`,
        slug: `${params.campaignType}-${listing.id}-${Date.now()}`,
        template_type: TEMPLATE_TYPE_MAP[params.campaignType] ?? "followup",
        subject: emailSubject,
        body: emailContent.data.generated_content,
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

    if (template) {
      await supabase.from("email_campaigns").update({ template_id: template.id }).eq("id", campaign.id)
    }

    const uniqueRecipients = [...new Set(recipients.filter(Boolean))]
    for (const contactId of uniqueRecipients) {
      await supabase.from("email_sends").insert({
        campaign_id: campaign.id,
        contact_id: contactId,
        status: "queued",
      })
    }

    revalidatePath("/dashboard/listings")
    return {
      success: true,
      campaign_id: campaign.id,
      recipients: uniqueRecipients.length,
      subject: emailContent.data?.subject,
    }
  } catch (error) {
    console.error("Prepare listing email campaign error:", error)
    return { success: false, error: "Failed to prepare campaign" }
  }
}

async function getListingCampaignRecipients(
  transactionId: string,
  campaignType: string,
  listing: any,
): Promise<string[]> {
  const supabase = await createClient()

  if (campaignType === "coming_soon" || campaignType === "launch") {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id")
      .eq("brokerage_id", listing.brokerage_id)
      .eq("status", "active")
      .gte("budget_max", (listing.price || 0) * 0.9)
      .lte("budget_min", (listing.price || 0) * 1.1)
    return contacts?.map((c) => c.id) || []
  }

  if (campaignType === "open_house") {
    const { data: interested } = await supabase
      .from("property_interactions")
      .select("contact_id")
      .eq("listing_id", listing.id)
      .in("interaction_type", ["view", "save"])
    return interested?.map((i) => i.contact_id).filter((id) => id) || []
  }

  if (campaignType === "price_drop") {
    const { data: viewers } = await supabase
      .from("property_interactions")
      .select("contact_id")
      .eq("listing_id", listing.id)
      .eq("interaction_type", "view")
    return viewers?.map((v) => v.contact_id).filter((id) => id) || []
  }

  const { data: allContacts } = await supabase.from("contacts").select("id")
    .eq("brokerage_id", listing.brokerage_id).eq("status", "active").limit(100)
  return allContacts?.map((c) => c.id) || []
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
