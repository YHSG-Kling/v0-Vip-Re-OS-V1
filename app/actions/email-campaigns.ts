"use server"

/**
 * app/actions/email-campaigns.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 9.7 — Email Campaign Engine Server Actions
 *
 * Full lifecycle: create → AI compose → preview → schedule/send → archive
 * Kernel gates: canAccessFeature('email_campaigns')
 * Kernel events: EMAIL_CAMPAIGN_CREATED, EMAIL_CAMPAIGN_SENT
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
  audience?: "buyers" | "sellers" | "investors" | "past_clients" | "all"
  tone?: "professional" | "friendly" | "urgent" | "informational"
  campaignId?: string
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

export async function createEmailCampaign(params: CreateEmailCampaignParams) {
  try {
    if (!isValidUUID(params.brokerageId)) {
      return { success: false, error: "Invalid brokerage ID" }
    }

    const access = await canAccessFeature(params.createdBy, "email_campaigns")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Email campaigns feature not available" }
    }

    const supabase = await createClient()

    const { data: campaign, error } = await supabase
      .from("newsletter_campaigns")
      .insert({
        brokerage_id: params.brokerageId,
        agent_id: params.agentId ?? null,
        campaign_name: params.campaignName,
        subject_line: params.subjectLine,
        content: params.content ?? "",
        status: "draft",
        approval_status: "pending",
        created_by: params.createdBy,
        send_date: params.sendDate ?? null,
        brand_compliance_passed: false,
      })
      .select()
      .maybeSingle()

    if (error || !campaign) throw error ?? new Error("Failed to create campaign")

    await incrementFeatureUsage(params.createdBy, "email_campaigns").catch(() => {})

    await processKernelEvent({
      event: KernelEvent.EMAIL_CAMPAIGN_CREATED,
      brokerageId: params.brokerageId,
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

export async function getEmailCampaigns(brokerageId: string, agentId?: string) {
  try {
    if (!isValidUUID(brokerageId)) {
      return { success: false, error: "Invalid brokerage ID" }
    }

    const supabase = await createClient()

    let query = supabase
      .from("newsletter_campaigns")
      .select("*")
      .eq("brokerage_id", brokerageId)
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

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("newsletter_campaigns")
      .select("*")
      .eq("id", campaignId)
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
  actorUserId: string,
  updates: UpdateEmailCampaignParams
) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    const { data: existing } = await supabase
      .from("newsletter_campaigns")
      .select("status, brokerage_id")
      .eq("id", campaignId)
      .maybeSingle()

    if (!existing) return { success: false, error: "Campaign not found" }
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
      .from("newsletter_campaigns")
      .update(payload)
      .eq("id", campaignId)
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

    const supabase = await createClient()

    const { data: existing } = await supabase
      .from("newsletter_campaigns")
      .select("status")
      .eq("id", campaignId)
      .maybeSingle()

    if (!existing) return { success: false, error: "Campaign not found" }
    if (existing.status === "sent") {
      return { success: false, error: "Cannot delete a sent campaign" }
    }

    const { error } = await supabase
      .from("newsletter_campaigns")
      .delete()
      .eq("id", campaignId)

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
    if (!isValidUUID(params.brokerageId)) {
      return { success: false, error: "Invalid brokerage ID" }
    }

    // Apply brand voice
    const brandVoice = await applyBrandVoice({
      brokerageId: params.brokerageId,
      actorUserId: params.agentId,
      actorRole: "agent",
      journeyType: "seller",
      persona: "seller",
      messageType: "email",
      content: "",
    })

    const tone = params.tone ?? brandVoice.notes[0] ?? "professional"
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
      brokerageId: params.brokerageId,
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

export async function sendEmailCampaign(campaignId: string, actorUserId: string, brokerageId: string) {
  try {
    if (!isValidUUID(campaignId) || !isValidUUID(brokerageId)) {
      return { success: false, error: "Invalid IDs" }
    }

    const access = await canAccessFeature(actorUserId, "email_campaigns")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Email campaigns feature not available" }
    }

    const supabase = await createClient()

    const { data: campaign } = await supabase
      .from("newsletter_campaigns")
      .select("*")
      .eq("id", campaignId)
      .maybeSingle()

    if (!campaign) return { success: false, error: "Campaign not found" }
    if (campaign.status === "sent") return { success: false, error: "Campaign already sent" }
    if (!campaign.content) return { success: false, error: "Campaign has no content to send" }

    // Count active subscribers
    const { count } = await supabase
      .from("newsletter_subscribers")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("status", "active")

    const recipientCount = count ?? 0

    // Mark as sent
    const { error: updateError } = await supabase
      .from("newsletter_campaigns")
      .update({
        status: "sent",
        send_date: new Date().toISOString(),
      })
      .eq("id", campaignId)

    if (updateError) throw updateError

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
    return { success: true, recipientCount }
  } catch (error) {
    return handleError(error, "sendEmailCampaign")
  }
}

// ─── SCHEDULE ─────────────────────────────────────────────────────────────────

export async function scheduleEmailCampaign(
  campaignId: string,
  actorUserId: string,
  scheduledDate: string
) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    const { data: existing } = await supabase
      .from("newsletter_campaigns")
      .select("status, content, subject_line")
      .eq("id", campaignId)
      .maybeSingle()

    if (!existing) return { success: false, error: "Campaign not found" }
    if (existing.status === "sent") return { success: false, error: "Cannot schedule a sent campaign" }
    if (!existing.content) return { success: false, error: "Add content before scheduling" }
    if (!existing.subject_line) return { success: false, error: "Add a subject line before scheduling" }

    const { data, error } = await supabase
      .from("newsletter_campaigns")
      .update({
        status: "scheduled",
        send_date: scheduledDate,
      })
      .eq("id", campaignId)
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

export async function getEmailCampaignStats(brokerageId: string) {
  try {
    if (!isValidUUID(brokerageId)) {
      return { success: false, error: "Invalid brokerage ID" }
    }

    const supabase = await createClient()

    const [campaignsResult, subscribersResult] = await Promise.all([
      supabase
        .from("newsletter_campaigns")
        .select("id, status, open_rate, click_rate")
        .eq("brokerage_id", brokerageId),
      supabase
        .from("newsletter_subscribers")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
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
