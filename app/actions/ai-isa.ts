"use server"

import { isValidUUID } from "@/lib/validations"
import {
  launchAIISACampaignService,
  queueAIISACallService,
  handleVapiCallCompleteService,
  getAIISACampaignsService,
  getAIISACallsService,
  retryFailedCallsService,
  updateCampaignStatusService,
} from "@/lib/application"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchEmail, dispatchVideo, dispatchDirectMail } from "@/lib/providers/dispatch"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { KernelEvent } from "@/lib/kernel/events"

/**
 * AI Inside Sales Agent (ISA) System
 * Autonomous outbound calling with Vapi.ai for lead qualification and appointment booking
 */

// Launch AI ISA campaign
export async function launchAIISACampaign(params: {
  campaignType: string
  campaignName?: string
  contactSegment: any
  loginId: string
}) {
  const { loginId } = params

  if (!isValidUUID(loginId)) {
    return { success: false, error: "Invalid login ID" }
  }

  try {
    return await launchAIISACampaignService(params)
  } catch (error: any) {
    console.error("[AI ISA] Campaign launch failed:", error)
    return { success: false, error: error.message }
  }
}

// Queue individual AI ISA call
export async function queueAIISACall(campaignId: string, contactId: string, loginId: string) {
  try {
    return await queueAIISACallService(campaignId, contactId, loginId)
  } catch (error: any) {
    console.error("[AI ISA] Call queueing failed:", error)
    return { success: false, error: error.message }
  }
}

// Handle Vapi call completion webhook
export async function handleVapiCallComplete(payload: any) {
  try {
    return await handleVapiCallCompleteService(payload)
  } catch (error: any) {
    console.error("[AI ISA] Webhook handling failed:", error)
    return { success: false, error: error.message }
  }
}

// Get AI ISA campaign stats
export async function getAIISACampaigns(loginId: string) {
  if (!isValidUUID(loginId)) {
    return []
  }

  return await getAIISACampaignsService(loginId)
}

// Get AI ISA call history
export async function getAIISACalls(campaignId?: string, loginId?: string) {
  if (loginId && !isValidUUID(loginId)) {
    return []
  }

  return await getAIISACallsService(campaignId, loginId)
}

// Retry failed calls
export async function retryFailedCalls(loginId: string) {
  if (!isValidUUID(loginId)) {
    return { success: false, error: "Invalid login ID" }
  }

  try {
    return await retryFailedCallsService(loginId)
  } catch (error: any) {
    console.error("[AI ISA] Retry failed calls error:", error)
    return { success: false, error: error.message }
  }
}

// Pause/resume campaign
export async function updateCampaignStatus(campaignId: string, status: "active" | "paused" | "completed") {
  if (!isValidUUID(campaignId)) {
    return { success: false, error: "Invalid campaign ID" }
  }

  return await updateCampaignStatusService(campaignId, status)
}

// ─── NEW: ISA Campaigns page actions ─────────────────────────────────────────

export type CampaignType = "FSBO" | "BUYER_MATCH" | "DIVORCE" | "FORECLOSURE" | "GHOST_RECOVERY"

export interface ISACampaignRow {
  id: string
  brokerage_id: string
  name: string
  campaign_type: CampaignType
  status: "active" | "paused" | "draft" | "completed"
  channels: string[]
  leads_targeted: number
  touches_sent: number
  conversions: number
  created_at: string
  updated_at: string
}

export interface ISACampaignStats {
  activeCampaigns: number
  leadsTargeted: number
  touchesSent: number
  conversionRate: number
}

/** Fetch all campaigns for a brokerage */
export async function listISACampaigns(brokerageId: string): Promise<{
  success: boolean
  campaigns: ISACampaignRow[]
  stats: ISACampaignStats
  error?: string
}> {
  if (!isValidUUID(brokerageId)) {
    return { success: false, campaigns: [], stats: { activeCampaigns: 0, leadsTargeted: 0, touchesSent: 0, conversionRate: 0 }, error: "Invalid brokerage ID" }
  }
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("ai_isa_campaigns")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  if (error) return { success: false, campaigns: [], stats: { activeCampaigns: 0, leadsTargeted: 0, touchesSent: 0, conversionRate: 0 }, error: error.message }

  const rows = (data ?? []) as ISACampaignRow[]
  const active = rows.filter(r => r.status === "active").length
  const leadsTargeted = rows.reduce((s, r) => s + (r.leads_targeted ?? 0), 0)
  const touchesSent = rows.reduce((s, r) => s + (r.touches_sent ?? 0), 0)
  const conversions = rows.reduce((s, r) => s + (r.conversions ?? 0), 0)
  const conversionRate = leadsTargeted > 0 ? Math.round((conversions / leadsTargeted) * 1000) / 10 : 0

  return {
    success: true,
    campaigns: rows,
    stats: { activeCampaigns: active, leadsTargeted, touchesSent, conversionRate },
  }
}

/** Create a new ISA campaign */
export async function createISACampaign(params: {
  brokerageId: string
  name: string
  campaignType: CampaignType
  channels: string[]
  targetSegment?: Record<string, unknown>
}): Promise<{ success: boolean; campaignId?: string; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthenticated" }

  const service = createServiceClient()
  const { data, error } = await service
    .from("ai_isa_campaigns")
    .insert({
      brokerage_id:   params.brokerageId,
      name:           params.name,
      campaign_type:  params.campaignType,
      channels:       params.channels,
      target_segment: params.targetSegment ?? {},
      status:         "draft",
      leads_targeted: 0,
      touches_sent:   0,
      conversions:    0,
      created_at:     new Date().toISOString(),
      updated_at:     new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error) return { success: false, error: error.message }

  await service.from("lifecycle_events").insert({
    event_type:   KernelEvent.LEAD_IMPORT_COMPLETED,
    entity_type:  "campaign",
    entity_id:    data.id,
    brokerage_id: params.brokerageId,
    actor_id:     user.id,
    context_json: JSON.stringify({ campaignType: params.campaignType, channels: params.channels }),
    created_at:   new Date().toISOString(),
  })

  return { success: true, campaignId: data.id }
}

/** Pause or resume a campaign */
export async function toggleCampaignStatus(
  campaignId: string,
  currentStatus: "active" | "paused" | "draft" | "completed"
): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(campaignId)) return { success: false, error: "Invalid campaign ID" }
  const newStatus = currentStatus === "active" ? "paused" : "active"
  const service = createServiceClient()
  const { error } = await service
    .from("ai_isa_campaigns")
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq("id", campaignId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/** Send a single test touch for a campaign */
export async function sendCampaignTestTouch(params: {
  campaignId: string
  brokerageId: string
  channel: "email" | "video" | "direct_mail" | "sms"
  testRecipientEmail: string
  testRecipientName: string
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthenticated" }

  // Compliance gate
  const compliance = await evaluateOutbound({
    actorContext: { brokerageId: params.brokerageId, userId: user.id },
    messageType:  "email",
    content:      `Test touch for campaign ${params.campaignId}`,
  })
  if (!compliance.allowed) {
    return { success: false, error: `Compliance blocked: ${compliance.violations?.join(", ") ?? "unknown"}` }
  }

  if (params.channel === "email") {
    const result = await dispatchEmail({
      brokerageId: params.brokerageId,
      userId:      user.id,
      from:        "noreply@platform.com",
      to:          params.testRecipientEmail,
      subject:     "[TEST] ISA Campaign Touch",
      html:        `<p>This is a test touch from campaign <strong>${params.campaignId}</strong>.</p>`,
      systemSource: "ai_isa",
      leadId:      params.campaignId,
    })
    return { success: result.success, error: result.error }
  }

  if (params.channel === "video") {
    const result = await dispatchVideo({
      brokerageId:    params.brokerageId,
      userId:         user.id,
      templateId:     process.env.HEYGEN_DEFAULT_TEMPLATE_ID ?? "",
      recipientEmail: params.testRecipientEmail,
      recipientName:  params.testRecipientName,
      systemSource:   "ai_isa",
      leadId:         params.campaignId,
    })
    return { success: result.success, error: result.error }
  }

  if (params.channel === "direct_mail") {
    const result = await dispatchDirectMail({
      brokerageId:    params.brokerageId,
      userId:         user.id,
      recipientName:  params.testRecipientName,
      mailingAddress: "123 Test St",
      city:           "San Francisco",
      state:          "CA",
      zip:            "94105",
      templateId:     process.env.LOB_DEFAULT_TEMPLATE_ID ?? "",
      systemSource:   "ai_isa",
      leadId:         params.campaignId,
    })
    return { success: result.success, error: result.error }
  }

  return { success: false, error: "Unsupported channel for test touch" }
}

/** Get feature flags for channel availability */
export async function getChannelFeatureFlags(): Promise<{
  video_campaigns: boolean
  direct_mail_campaigns: boolean
}> {
  const service = createServiceClient()
  const { data } = await service
    .from("feature_flags")
    .select("feature_key, enabled, superadmin_only")
    .in("feature_key", ["video_campaigns", "direct_mail_campaigns"])

  const flags: Record<string, boolean> = {}
  for (const row of data ?? []) {
    flags[row.feature_key] = !row.superadmin_only && row.enabled === true
  }
  return {
    video_campaigns:       flags["video_campaigns"] ?? false,
    direct_mail_campaigns: flags["direct_mail_campaigns"] ?? false,
  }
}
