"use server"

/**
 * app/actions/direct-mail.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 9.9 — Direct Mail Engine Server Actions
 *
 * Provides direct mail campaign creation, recipient management, delivery
 * tracking, and response logging with full kernel wiring:
 *   - canAccessFeature('direct_mail') gate on all writes
 *   - resolveProvider(providerType='direct_mail') → 'lob' system default
 *   - processKernelEvent() for DIRECT_MAIL_CAMPAIGN_CREATED and DIRECT_MAIL_SENT
 *
 * Provider configuration (Lob API keys) is superadmin-owned — no provider UI here.
 */

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import {
  canAccessFeature,
  incrementFeatureUsage,
  resolveProvider,
  processKernelEvent,
  KernelEvent,
} from "@/lib/kernel"
import { dispatchDirectMail } from "@/lib/providers/dispatch"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface CreateMailCampaignParams {
  brokerageId: string
  agentId?: string
  campaignName: string
  targetAudience: string
  designUrl?: string
  copyText?: string
  quantity: number
  mailingDate?: string
  perPieceCost?: number
  createdBy: string
}

export interface AddRecipientsParams {
  campaignId: string
  recipients: Array<{
    contactId?: string
    firstName: string
    lastName: string
    addressLine1: string
    addressLine2?: string
    city: string
    state: string
    zip: string
  }>
}

export interface TrackDeliveryParams {
  campaignId: string
  batchId: string
  deliveryPayload: Record<string, unknown>
  brokerageId: string
}

export interface LogResponseParams {
  brokerageId: string
  campaignId: string
  recipientId?: string
  contactId?: string
  responseType: "qr_scan" | "landing_visit" | "call" | "form_submit" | "reply" | "appointment"
  responseMetadata?: Record<string, unknown>
}

export interface SendCampaignParams {
  campaignId: string
  actorUserId: string
  brokerageId: string
  teamId?: string
}

// ─── CAMPAIGN CRUD ────────────────────────────────────────────────────────────

/**
 * Creates a new direct mail campaign with kernel gating.
 * Fires DIRECT_MAIL_CAMPAIGN_CREATED event.
 */
export async function createMailCampaign(params: CreateMailCampaignParams) {
  try {
    if (!isValidUUID(params.brokerageId)) {
      return { success: false, error: "Invalid brokerage ID" }
    }

    // ── Kernel Gate: canAccessFeature ──
    const access = await canAccessFeature(params.createdBy, "direct_mail")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Direct mail feature not available" }
    }

    const supabase = await createClient()

    const { data: campaign, error } = await supabase
      .from("direct_mail_campaigns")
      .insert({
        brokerage_id: params.brokerageId,
        agent_id: params.agentId ?? null,
        campaign_name: params.campaignName,
        target_audience: params.targetAudience,
        design_url: params.designUrl ?? null,
        copy_text: params.copyText ?? null,
        quantity: params.quantity,
        mailing_date: params.mailingDate ?? null,
        per_piece_cost: params.perPieceCost ?? null,
        status: "planning",
        created_by: params.createdBy,
      })
      .select()
      .maybeSingle()

    if (error || !campaign) throw error ?? new Error("Failed to create campaign")

    // ── Increment usage counter ──
    await incrementFeatureUsage(params.createdBy, "direct_mail")

    // ── Fire kernel event ──
    await processKernelEvent({
      event: KernelEvent.DIRECT_MAIL_CAMPAIGN_CREATED,
      brokerageId: params.brokerageId,
      entityType: "direct_mail_campaign",
      entityId: campaign.id,
    }).catch((err) => {
      console.error("[DirectMail] Event processing failed (non-blocking):", err)
    })

    revalidatePath("/dashboard/campaigns/mail")
    return { success: true, campaign }
  } catch (error) {
    console.error("[DirectMail] Create campaign error:", error)
    return handleError(error, "createMailCampaign")
  }
}

/**
 * Retrieves all direct mail campaigns for a brokerage.
 */
export async function getMailCampaigns(brokerageId: string) {
  try {
    if (!isValidUUID(brokerageId)) {
      return { success: false, error: "Invalid brokerage ID" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("direct_mail_campaigns")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })

    if (error) throw error

    return { success: true, campaigns: data || [] }
  } catch (error) {
    return handleError(error, "getMailCampaigns")
  }
}

/**
 * Retrieves a single campaign by ID.
 */
export async function getMailCampaign(campaignId: string) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("direct_mail_campaigns")
      .select("*")
      .eq("id", campaignId)
      .maybeSingle()

    if (error) throw error
    if (!data) return { success: false, error: "Campaign not found" }

    return { success: true, campaign: data }
  } catch (error) {
    return handleError(error, "getMailCampaign")
  }
}

/**
 * Updates a campaign. Only allowed when status is 'planning'.
 */
export async function updateMailCampaign(
  campaignId: string,
  updates: Partial<{
    campaignName: string
    targetAudience: string
    designUrl: string
    quantity: number
    mailingDate: string
    perPieceCost: number
    status: "planning" | "approved" | "printed" | "mailed"
  }>
) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    // Check current status
    const { data: existing } = await supabase
      .from("direct_mail_campaigns")
      .select("status")
      .eq("id", campaignId)
      .maybeSingle()

    if (existing?.status === "mailed") {
      return { success: false, error: "Cannot update a mailed campaign" }
    }

    const updatePayload: Record<string, unknown> = {}
    if (updates.campaignName !== undefined) updatePayload.campaign_name = updates.campaignName
    if (updates.targetAudience !== undefined) updatePayload.target_audience = updates.targetAudience
    if (updates.designUrl !== undefined) updatePayload.design_url = updates.designUrl
    if (updates.quantity !== undefined) updatePayload.quantity = updates.quantity
    if (updates.mailingDate !== undefined) updatePayload.mailing_date = updates.mailingDate
    if (updates.perPieceCost !== undefined) updatePayload.per_piece_cost = updates.perPieceCost
    if (updates.status !== undefined) updatePayload.status = updates.status

    const { data, error } = await supabase
      .from("direct_mail_campaigns")
      .update(updatePayload)
      .eq("id", campaignId)
      .select()
      .maybeSingle()

    if (error) throw error

    revalidatePath("/dashboard/campaigns/mail")
    return { success: true, campaign: data }
  } catch (error) {
    return handleError(error, "updateMailCampaign")
  }
}

/**
 * Deletes a campaign. Only allowed when status is 'planning'.
 */
export async function deleteMailCampaign(campaignId: string) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    // Check current status
    const { data: existing } = await supabase
      .from("direct_mail_campaigns")
      .select("status")
      .eq("id", campaignId)
      .maybeSingle()

    if (existing?.status && existing.status !== "planning") {
      return { success: false, error: "Cannot delete a campaign that is not in planning status" }
    }

    // Delete recipients first
    await supabase
      .from("direct_mail_recipients")
      .delete()
      .eq("campaign_id", campaignId)

    // Delete the campaign
    const { error } = await supabase
      .from("direct_mail_campaigns")
      .delete()
      .eq("id", campaignId)

    if (error) throw error

    revalidatePath("/dashboard/campaigns/mail")
    return { success: true }
  } catch (error) {
    return handleError(error, "deleteMailCampaign")
  }
}

// ─── RECIPIENTS ───────────────────────────────────────────────────────────────

/**
 * Bulk inserts recipients for a campaign.
 */
export async function addRecipients(params: AddRecipientsParams) {
  try {
    if (!isValidUUID(params.campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    // Get brokerage_id from campaign
    const { data: campaign } = await supabase
      .from("direct_mail_campaigns")
      .select("brokerage_id")
      .eq("id", params.campaignId)
      .maybeSingle()

    if (!campaign) {
      return { success: false, error: "Campaign not found" }
    }

    const recipientRows = params.recipients.map((r) => ({
      brokerage_id: campaign.brokerage_id,
      campaign_id: params.campaignId,
      contact_id: r.contactId ?? null,
      first_name: r.firstName,
      last_name: r.lastName,
      address_line1: r.addressLine1,
      address_line2: r.addressLine2 ?? null,
      city: r.city,
      state: r.state,
      zip: r.zip,
      delivery_status: "pending",
    }))

    const { data, error } = await supabase
      .from("direct_mail_recipients")
      .insert(recipientRows)
      .select()

    if (error) throw error

    revalidatePath("/dashboard/campaigns/mail")
    return { success: true, recipients: data }
  } catch (error) {
    return handleError(error, "addRecipients")
  }
}

/**
 * Retrieves recipients for a campaign.
 */
export async function getRecipients(campaignId: string) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("direct_mail_recipients")
      .select("*")
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: false })

    if (error) throw error

    return { success: true, recipients: data || [] }
  } catch (error) {
    return handleError(error, "getRecipients")
  }
}

/**
 * Removes a recipient from a campaign.
 */
export async function removeRecipient(recipientId: string) {
  try {
    if (!isValidUUID(recipientId)) {
      return { success: false, error: "Invalid recipient ID" }
    }

    const supabase = await createClient()

    const { error } = await supabase
      .from("direct_mail_recipients")
      .delete()
      .eq("id", recipientId)

    if (error) throw error

    revalidatePath("/dashboard/campaigns/mail")
    return { success: true }
  } catch (error) {
    return handleError(error, "removeRecipient")
  }
}

// ─── TRACKING ─────────────────────────────────────────────────────────────────

/**
 * Tracks delivery status from Lob webhook or batch update.
 */
export async function trackDelivery(params: TrackDeliveryParams) {
  try {
    if (!isValidUUID(params.campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("mail_tracking")
      .insert({
        brokerage_id: params.brokerageId,
        campaign_id: params.campaignId,
        batch_id: params.batchId,
        tracking_payload: params.deliveryPayload,
        provider_delivery_status: (params.deliveryPayload as Record<string, string>)?.status ?? "unknown",
        mailed_at: (params.deliveryPayload as Record<string, string>)?.mailed_at ?? null,
        delivered_at: (params.deliveryPayload as Record<string, string>)?.delivered_at ?? null,
        returned_at: (params.deliveryPayload as Record<string, string>)?.returned_at ?? null,
      })
      .select()
      .maybeSingle()

    if (error) throw error

    return { success: true, tracking: data }
  } catch (error) {
    return handleError(error, "trackDelivery")
  }
}

/**
 * Retrieves tracking records for a campaign.
 */
export async function getTrackingRecords(campaignId: string) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("mail_tracking")
      .select("*")
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: false })

    if (error) throw error

    return { success: true, tracking: data || [] }
  } catch (error) {
    return handleError(error, "getTrackingRecords")
  }
}

// ─── RESPONSES ────────────────────────────────────────────────────────────────

/**
 * Logs a response to a direct mail piece.
 * Also inserts into mail_response_tracking for L9-S12 ROI aggregation.
 */
export async function logResponse(params: LogResponseParams) {
  try {
    if (!isValidUUID(params.campaignId) || !isValidUUID(params.brokerageId)) {
      return { success: false, error: "Invalid IDs" }
    }

    const supabase = await createClient()

    // Insert into direct_mail_responses
    const { data: response, error: responseError } = await supabase
      .from("direct_mail_responses")
      .insert({
        brokerage_id: params.brokerageId,
        campaign_id: params.campaignId,
        recipient_id: params.recipientId ?? null,
        contact_id: params.contactId ?? null,
        response_type: params.responseType,
        response_metadata: params.responseMetadata ?? null,
      })
      .select()
      .maybeSingle()

    if (responseError) throw responseError

    // Also insert into mail_response_tracking for ROI aggregation
    await supabase.from("mail_response_tracking").insert({
      brokerage_id: params.brokerageId,
      campaign_id: params.campaignId,
      contact_id: params.contactId ?? null,
      response_type: params.responseType,
      response_metadata: params.responseMetadata ?? null,
    })

    return { success: true, response }
  } catch (error) {
    return handleError(error, "logResponse")
  }
}

/**
 * Retrieves responses for a campaign.
 */
export async function getResponses(campaignId: string) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("direct_mail_responses")
      .select("*, contacts(first_name, last_name, email, phone)")
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: false })

    if (error) throw error

    return { success: true, responses: data || [] }
  } catch (error) {
    return handleError(error, "getResponses")
  }
}

/**
 * Retrieves response summary counts by type for a campaign.
 */
export async function getResponseSummary(campaignId: string) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("direct_mail_responses")
      .select("response_type")
      .eq("campaign_id", campaignId)

    if (error) throw error

    // Count by type
    const summary: Record<string, number> = {}
    for (const row of data || []) {
      const type = row.response_type ?? "unknown"
      summary[type] = (summary[type] || 0) + 1
    }

    return { success: true, summary }
  } catch (error) {
    return handleError(error, "getResponseSummary")
  }
}

// ─── SEND CAMPAIGN ────────────────────────────────────────────────────────────

/**
 * Sends a campaign via the resolved direct mail provider (Lob).
 * - canAccessFeature('direct_mail') gate
 * - resolveProvider(providerType='direct_mail') → 'lob'
 * - Updates campaign status to 'mailed'
 * - Fires DIRECT_MAIL_SENT event
 */
export async function sendCampaign(params: SendCampaignParams) {
  try {
    if (!isValidUUID(params.campaignId) || !isValidUUID(params.actorUserId)) {
      return { success: false, error: "Invalid IDs" }
    }

    // ── Kernel Gate: canAccessFeature ──
    const access = await canAccessFeature(params.actorUserId, "direct_mail")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Direct mail feature not available" }
    }

    const supabase = await createClient()

    // ── Resolve provider ──
    const provider = await resolveProvider({
      providerType: "direct_mail",
      actorContext: {
        userId: params.actorUserId,
        brokerageId: params.brokerageId,
        teamId: params.teamId,
      },
    })
    // provider.providerKey should be 'lob' (system default)

    // Get campaign and recipients
    const { data: campaign, error: campaignError } = await supabase
      .from("direct_mail_campaigns")
      .select("*")
      .eq("id", params.campaignId)
      .maybeSingle()

    if (campaignError || !campaign) {
      return { success: false, error: "Campaign not found" }
    }

    if (campaign.status === "mailed") {
      return { success: false, error: "Campaign already mailed" }
    }

    const { data: recipients } = await supabase
      .from("direct_mail_recipients")
      .select("*")
      .eq("campaign_id", params.campaignId)
      .eq("delivery_status", "pending")

    if (!recipients?.length) {
      return { success: false, error: "No pending recipients to mail" }
    }

    // ── Call Lob API via dispatchDirectMail() for each recipient ──
    let firstSuccessfulMessageId: string | undefined
    let successCount = 0
    const failedRecipientIds: string[] = []
    for (const recipient of recipients) {
      const lobResult = await dispatchDirectMail({
        brokerageId: params.brokerageId,
        userId: params.actorUserId,
        teamId: params.teamId,
        contactId: recipient.contact_id ?? undefined,
        systemSource: "direct_mail_campaign",
        recipientName: `${recipient.first_name} ${recipient.last_name}`.trim(),
        mailingAddress: recipient.address_line1,
        mailingAddress2: recipient.address_line2 ?? undefined,
        city: recipient.city,
        state: recipient.state,
        zip: recipient.zip,
        templateId: campaign.design_url ?? campaign.id,
        mergeVars: campaign.copy_text ? { copy_text: campaign.copy_text } : undefined,
        metadata: { campaign_id: params.campaignId },
      })
      if (lobResult.success && lobResult.messageId) {
        if (!firstSuccessfulMessageId) firstSuccessfulMessageId = lobResult.messageId
        successCount++
      } else {
        failedRecipientIds.push(recipient.id)
      }
    }

    if (successCount === 0) {
      return { success: false, error: "Direct mail failed: no pieces dispatched via Lob" }
    }

    // Mark failed recipients so they aren't silently treated as mailed
    if (failedRecipientIds.length > 0) {
      console.warn(`[DirectMail] Partial success: ${successCount}/${recipients.length} dispatched for campaign ${params.campaignId}`)
      await supabase
        .from("direct_mail_recipients")
        .update({ delivery_status: "failed" })
        .in("id", failedRecipientIds)
    }

    const lobOrderId = firstSuccessfulMessageId ?? `lob_${Date.now()}`

    // Update campaign
    const { error: updateError } = await supabase
      .from("direct_mail_campaigns")
      .update({
        status: "mailed",
        mailing_date: new Date().toISOString().slice(0, 10),
        lob_order_id: lobOrderId,
        pieces_mailed: recipients.length,
      })
      .eq("id", params.campaignId)

    if (updateError) throw updateError

    // Update recipients status
    await supabase
      .from("direct_mail_recipients")
      .update({
        delivery_status: "mailed",
        mailed_at: new Date().toISOString(),
      })
      .eq("campaign_id", params.campaignId)
      .eq("delivery_status", "pending")

    // ── Fire kernel event ──
    await processKernelEvent({
      event: KernelEvent.DIRECT_MAIL_SENT,
      brokerageId: params.brokerageId,
      entityType: "direct_mail_campaign",
      entityId: params.campaignId,
    }).catch((err) => {
      console.error("[DirectMail] Event processing failed (non-blocking):", err)
    })

    revalidatePath("/dashboard/campaigns/mail")

    return {
      success: true,
      lobOrderId,
      piecesMailed: recipients.length,
      provider: provider.providerKey,
    }
  } catch (error) {
    console.error("[DirectMail] Send campaign error:", error)
    return handleError(error, "sendCampaign")
  }
}
