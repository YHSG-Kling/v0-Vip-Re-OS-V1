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
import { assembleEmail } from "@/lib/kernel/communications/assemble-email"
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
  event_type:    KernelEvent.LEAD_IMPORT_COMPLETED,
  entity_type:   "campaign",
  entity_id:     data.id,
  brokerage_id:  params.brokerageId,
  actor_user_id: user.id,
  metadata: { campaignType: params.campaignType, channels: params.channels },
  created_at:    new Date().toISOString(),
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

// ─── TAB 2: ENGAGEMENT FEED ──────────────────────────────────────────────────

export interface EngagementFeedItem {
  id: string
  contact_id: string
  contact_first_name: string | null
  contact_last_name: string | null
  campaign_id: string | null
  campaign_name: string | null
  channel: string
  event_type: string
  heygen_video_id: string | null
  lob_letter_id: string | null
  created_at: string
}

export async function getEngagementFeed(params: {
  brokerageId: string
  campaignId?: string
  channel?: string
  eventType?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
}): Promise<{ success: boolean; items: EngagementFeedItem[]; error?: string }> {
  if (!isValidUUID(params.brokerageId)) return { success: false, items: [], error: "Invalid brokerage ID" }

  const service = createServiceClient()
  let query = service
    .from("ai_isa_engagement_tracking")
    .select(`
      id,
      contact_id,
      campaign_id,
      channel,
      event_type,
      heygen_video_id,
      lob_letter_id,
      created_at,
      contacts (first_name, last_name),
      ai_isa_campaigns (name)
    `)
    .eq("brokerage_id", params.brokerageId)
    .order("created_at", { ascending: false })
    .limit(params.limit ?? 100)

  if (params.campaignId) query = query.eq("campaign_id", params.campaignId)
  if (params.channel)    query = query.eq("channel", params.channel)
  if (params.eventType)  query = query.eq("event_type", params.eventType)
  if (params.dateFrom)   query = query.gte("created_at", params.dateFrom)
  if (params.dateTo)     query = query.lte("created_at", params.dateTo)

  const { data, error } = await query
  if (error) return { success: false, items: [], error: error.message }

  const items: EngagementFeedItem[] = (data ?? []).map((row: any) => ({
    id:                  row.id,
    contact_id:          row.contact_id,
    contact_first_name:  row.contacts?.first_name ?? null,
    contact_last_name:   row.contacts?.last_name ?? null,
    campaign_id:         row.campaign_id,
    campaign_name:       row.ai_isa_campaigns?.name ?? null,
    channel:             row.channel,
    event_type:          row.event_type,
    heygen_video_id:     row.heygen_video_id ?? null,
    lob_letter_id:       row.lob_letter_id ?? null,
    created_at:          row.created_at,
  }))

  return { success: true, items }
}

// ─── TAB 3: QUALIFICATION OUTCOMES ───────────────────────────────────────────

export interface QualificationOutcome {
  id: string
  contact_id: string
  contact_first_name: string | null
  contact_last_name: string | null
  score: number | null
  qualification_result: string
  qualification_signals: unknown[]
  assigned_agent_name: string | null
  assigned_at: string | null
  notes: string | null
  created_at: string
}

export interface QualificationStats {
  qualified: number
  not_qualified: number
  appointment_set: number
  no_response: number
  needs_follow_up: number
}

export async function getQualificationOutcomes(brokerageId: string): Promise<{
  success: boolean
  outcomes: QualificationOutcome[]
  stats: QualificationStats
  chartData: { result: string; count: number }[]
  error?: string
}> {
  const empty = { success: false, outcomes: [], stats: { qualified: 0, not_qualified: 0, appointment_set: 0, no_response: 0, needs_follow_up: 0 }, chartData: [], error: "" }
  if (!isValidUUID(brokerageId)) return { ...empty, error: "Invalid brokerage ID" }

  const service = createServiceClient()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await service
    .from("ai_isa_qualifications")
    .select(`
      id,
      contact_id,
      score,
      qualification_result,
      qualification_signals,
      assigned_to_agent_id,
      assigned_at,
      notes,
      created_at,
      contacts (first_name, last_name),
      assigned_agent:users!assigned_to_agent_id (first_name, last_name)
    `)
    .eq("brokerage_id", brokerageId)
    .gte("created_at", thirtyDaysAgo)
    .order("created_at", { ascending: false })

  if (error) return { ...empty, error: error.message }

  const rows = (data ?? []) as any[]
  const outcomes: QualificationOutcome[] = rows.map(r => ({
    id:                    r.id,
    contact_id:            r.contact_id,
    contact_first_name:    r.contacts?.first_name ?? null,
    contact_last_name:     r.contacts?.last_name ?? null,
    score:                 r.score ?? null,
    qualification_result:  r.qualification_result,
    qualification_signals: Array.isArray(r.qualification_signals) ? r.qualification_signals : [],
    assigned_agent_name:   r.assigned_agent
      ? `${r.assigned_agent.first_name ?? ""} ${r.assigned_agent.last_name ?? ""}`.trim() || null
      : null,
    assigned_at:           r.assigned_at ?? null,
    notes:                 r.notes ?? null,
    created_at:            r.created_at,
  }))

  const stats: QualificationStats = {
    qualified:      rows.filter(r => r.qualification_result === "qualified").length,
    not_qualified:  rows.filter(r => r.qualification_result === "not_qualified").length,
    appointment_set:rows.filter(r => r.qualification_result === "appointment_set").length,
    no_response:    rows.filter(r => r.qualification_result === "no_response").length,
    needs_follow_up:rows.filter(r => r.qualification_result === "needs_follow_up").length,
  }

  // Chart: count by result
  const resultCounts: Record<string, number> = {}
  for (const r of rows) {
    resultCounts[r.qualification_result] = (resultCounts[r.qualification_result] ?? 0) + 1
  }
  const chartData = Object.entries(resultCounts).map(([result, count]) => ({ result, count }))

  return { success: true, outcomes, stats, chartData }
}

// ─── TAB 4: GHOST RECOVERY ───────────────────────────────────────────────────

export interface GhostContact {
  contact_id: string
  contact_first_name: string | null
  contact_last_name: string | null
  campaign_id: string | null
  campaign_name: string | null
  last_channel: string | null
  attempt_count: number
  last_touched_at: string
  hours_since_last_touch: number
  stage: "24h" | "48h" | "72h"
}

export async function getGhostRecoveryQueue(brokerageId: string): Promise<{
  success: boolean
  ghosts: GhostContact[]
  error?: string
}> {
  if (!isValidUUID(brokerageId)) return { success: false, ghosts: [], error: "Invalid brokerage ID" }

  const service = createServiceClient()
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Get contacts with last engagement >= 24h ago and no "replied" event since
  const { data, error } = await service
    .from("ai_isa_engagement_tracking")
    .select(`
      contact_id,
      campaign_id,
      channel,
      event_type,
      created_at,
      contacts (first_name, last_name),
      ai_isa_campaigns (name)
    `)
    .eq("brokerage_id", brokerageId)
    .lte("created_at", cutoff24h)
    .order("created_at", { ascending: false })

  if (error) return { success: false, ghosts: [], error: error.message }

  // Group by contact_id — keep most recent row, exclude any that have "replied"
  const contactMap = new Map<string, any>()
  const repliedContacts = new Set<string>()

  for (const row of (data ?? []) as any[]) {
    if (row.event_type === "replied") {
      repliedContacts.add(row.contact_id)
    }
    if (!contactMap.has(row.contact_id)) {
      contactMap.set(row.contact_id, { ...row, attempt_count: 0 })
    }
    contactMap.get(row.contact_id).attempt_count++
  }

  const now = Date.now()
  const ghosts: GhostContact[] = []

  for (const [contactId, row] of contactMap.entries()) {
    if (repliedContacts.has(contactId)) continue

    const hoursAgo = Math.floor((now - new Date(row.created_at).getTime()) / (1000 * 60 * 60))
    const stage: GhostContact["stage"] = hoursAgo >= 72 ? "72h" : hoursAgo >= 48 ? "48h" : "24h"

    ghosts.push({
      contact_id:             contactId,
      contact_first_name:     row.contacts?.first_name ?? null,
      contact_last_name:      row.contacts?.last_name ?? null,
      campaign_id:            row.campaign_id,
      campaign_name:          row.ai_isa_campaigns?.name ?? null,
      last_channel:           row.channel ?? null,
      attempt_count:          row.attempt_count,
      last_touched_at:        row.created_at,
      hours_since_last_touch: hoursAgo,
      stage,
    })
  }

  // Sort by hours descending (most overdue first within each stage)
  ghosts.sort((a, b) => b.hours_since_last_touch - a.hours_since_last_touch)

  return { success: true, ghosts }
}

/** Manual ghost recovery trigger — evaluateOutbound first, then dispatchEmail */
export async function triggerGhostRecovery(params: {
  contactId: string
  campaignId: string
  brokerageId: string
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthenticated" }

  // Step 1: Compliance gate — hard stop
  const compliance = await evaluateOutbound({
    actorContext: { brokerageId: params.brokerageId, userId: user.id },
    messageType: "email",
    content: "Ghost recovery outreach",
  })
  if (!compliance.allowed) {
    return { success: false, error: `Compliance blocked: ${compliance.violations?.join(", ") ?? "unknown"}` }
  }

  // Step 2: Fetch contact for dispatch
  const service = createServiceClient()
  const { data: contact, error: contactErr } = await service
    .from("contacts")
    .select("email, first_name, lifecycle_state")
    .eq("id", params.contactId)
    .single()

  if (contactErr || !contact) return { success: false, error: "Contact not found" }

  // Hard stop: blocked lifecycle states
  if (["REPRESENTATION", "ACTIVE_TRANSACTION"].includes(contact.lifecycle_state ?? "")) {
    return { success: false, error: `Contact in blocked lifecycle state: ${contact.lifecycle_state}` }
  }

  // Step 3: Assemble then dispatch
  const ghostBodyHtml = `<p>Hi ${contact.first_name ?? "there"},</p><p>We wanted to check in and see if we can still help you on your real estate journey. No pressure — just here when you're ready.</p>`
  const ghostAssembled = await assembleEmail({
    bodyHtml:       ghostBodyHtml,
    userId:         user.id,
    brokerageId:    params.brokerageId,
    contactId:      params.contactId,
    channelPurpose: "campaign",
  })
  const dispatchResult = await dispatchEmail({
    brokerageId:  params.brokerageId,
    userId:       user.id,
    from:         "noreply@platform.com",
    to:           contact.email ?? "",
    subject:      "Following up — are you still interested?",
    html:         ghostAssembled.html,
    text:         ghostAssembled.text,
    systemSource: "ghost_recovery",
    leadId:       params.contactId,
  })

  if (!dispatchResult.success) return { success: false, error: dispatchResult.error }

  // Step 4: Insert engagement tracking row
  await service.from("ai_isa_engagement_tracking").insert({
    brokerage_id: params.brokerageId,
    contact_id:   params.contactId,
    campaign_id:  params.campaignId,
    channel:      "email",
    event_type:   "sent",
    created_at:   new Date().toISOString(),
  })

  return { success: true }
}

/** Skip a ghost contact — insert unsubscribed event to stop retries */
export async function skipGhostContact(params: {
  contactId: string
  campaignId: string
  brokerageId: string
}): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()
  const { error } = await service.from("ai_isa_engagement_tracking").insert({
    brokerage_id: params.brokerageId,
    contact_id:   params.contactId,
    campaign_id:  params.campaignId,
    channel:      "email",
    event_type:   "unsubscribed",
    created_at:   new Date().toISOString(),
  })
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/** Retry ghost contact via specified channel */
export async function retryGhostContact(params: {
  brokerageId: string
  contactId: string
  channel: "email" | "sms" | "phone"
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthenticated" }

  const service = createServiceClient()

  // Get contact info
  const { data: contact, error: contactErr } = await service
    .from("contacts")
    .select("email, phone, first_name, lifecycle_state")
    .eq("id", params.contactId)
    .single()

  if (contactErr || !contact) return { success: false, error: "Contact not found" }

  // Compliance gate
  const compliance = await evaluateOutbound({
    actorContext: { brokerageId: params.brokerageId, userId: user.id },
    messageType: params.channel === "email" ? "email" : "sms",
    content: "Ghost recovery re-engagement",
  })
  if (!compliance.allowed) {
    return { success: false, error: `Compliance blocked: ${compliance.violations?.join(", ") ?? "unknown"}` }
  }

  // Dispatch based on channel
  if (params.channel === "email" && contact.email) {
    const retryBodyHtml = `<p>Hi ${contact.first_name ?? "there"},</p><p>Just checking in to see if you're still looking for help with your real estate needs. Let me know!</p>`
    const retryAssembled = await assembleEmail({
      bodyHtml:       retryBodyHtml,
      userId:         user.id,
      brokerageId:    params.brokerageId,
      contactId:      params.contactId,
      channelPurpose: "campaign",
    })
    const result = await dispatchEmail({
      brokerageId: params.brokerageId,
      userId:      user.id,
      from:        "noreply@platform.com",
      to:          contact.email,
      subject:     "Quick follow-up",
      html:        retryAssembled.html,
      text:        retryAssembled.text,
      systemSource: "ghost_recovery",
      leadId:      params.contactId,
    })
    if (!result.success) return { success: false, error: result.error }
  }

  // Log engagement event
  await service.from("ai_isa_engagement_tracking").insert({
    brokerage_id: params.brokerageId,
    contact_id: params.contactId,
    channel: params.channel,
    event_type: "sent",
    created_at: new Date().toISOString(),
  })

  return { success: true }
}

/** Suppress ghost contact — mark as skipped to stop retries */
export async function suppressGhostContact(params: {
  brokerageId: string
  contactId: string
}): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()
  const { error } = await service.from("ai_isa_engagement_tracking").insert({
    brokerage_id: params.brokerageId,
    contact_id: params.contactId,
    channel: "system",
    event_type: "suppressed",
    created_at: new Date().toISOString(),
  })
  if (error) return { success: false, error: error.message }
  return { success: true }
}
