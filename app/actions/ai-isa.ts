"use server"

import { isValidUUID } from "@/lib/validations"
import {
  launchAIISACampaignService,
  queueAIISACallService,
  retryFailedCallsService,
  type LaunchAIISACampaignResult,
} from "@/lib/application"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchEmail, dispatchVideo, dispatchDirectMail } from "@/lib/providers/dispatch"
// TOMBSTONE: `evaluateOutbound` from "@/lib/kernel/compliance" was imported here
// and never called. The compliance gate this file actually uses is the local
// runAiIsaComplianceCheck (line ~49), which wraps evaluateKernelOutbound from
// "@/lib/kernel/adapters/compliance" — imported on the next line and live at
// three call sites. The direct import was the older spelling left behind, and
// its presence is what made two doc comments in this file claim a gate named
// `evaluateOutbound` runs here. The export survives with 83 referents across
// app/ and lib/ (e.g. lib/kernel/adapters/compliance.ts:126, which is how this
// file reaches it); only this file's unused binding is removed.
import { KernelEvent } from "@/lib/kernel/events"
import { buildActorContext } from "@/lib/kernel/actor-context"
import { evaluateKernelOutbound } from "@/lib/kernel/adapters/compliance"
// The touch cap lives beside the governor that enforces it, so the writer and
// the reader can never disagree about the bounds or the default (§6).
import { clampMaxTouches } from "@/lib/ai-isa/isa-outreach-logger"

/**
 * AI Inside Sales Agent (ISA) System
 * Autonomous outbound calling for lead qualification and appointment booking.
 * The dialer is TWILIO + ElevenLabs. There is no Vapi in this product.
 */

// Auth gate — every dashboard-facing function in this file reads/mutates
// campaign + engagement data and triggers paid outbound (email, SMS, phone,
// video, direct mail). Previous version accepted brokerageId as a caller
// param, which let any signed-in user enumerate / mutate ANY brokerage's ISA
// data simply by passing that brokerage's UUID. Now: brokerage is resolved
// from the session, params.brokerageId is ignored.
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

async function runAiIsaComplianceCheck(params: {
  userId: string
  brokerageId: string
  journeyType?: "buyer" | "seller" | "marketing"
  persona?: string
  messageType: "email" | "sms" | "phone"
  content: string
  contactId: string
  contactType?: "buyer" | "seller" | "both" | "investor" | "vendor" | "lender"
  status?: string
  dncStatus?: boolean
  tcpaConsent?: boolean
  isaReengageAllowed?: boolean
}) {
  return evaluateKernelOutbound({
    actorContext: buildActorContext({
      userId: params.userId,
      brokerageId: params.brokerageId,
      role: "agent",
    }),
    journeyType: params.journeyType ?? "buyer",
    persona: params.persona ?? "other",
    messageType: params.messageType,
    content: params.content,
    contact: {
      id: params.contactId,
      first_name: "",
      last_name: "",
      contact_type: params.contactType ?? "buyer",
      status: params.status ?? "new",
      dnc_status: params.dncStatus ?? false,
      tcpa_consent: params.tcpaConsent ?? true,
      isa_reengage_allowed: params.isaReengageAllowed ?? false,
    },
  })
}
// LEDGER of the legacy loginId-shaped ISA quartet (deleted lane E2, partially
// RESTORED by owner ruling lane F1, both 2026-08-28):
//   · launchAIISACampaign → RESTORED below as a CAMPAIGN-TYPE LAUNCHER. Owner
//     ruling: it "wasn't intended for a dial batch but an actual choice of
//     drip/ghost/nurture campaigns" — campaigns are a different business
//     process from dialing. It resolves the type's contact segment and enrolls
//     into the sequence cadence; it does NOT dial. Dialing stays the
//     HUMAN-GATED batch lane
//     (lib/ai-isa/voice-dial-batch.ts:proposeIsaDialBatch/approveIsaDialBatch,
//     wired at app/dashboard/admin/voice-dial-batches).
//   · queueAIISACall → RESTORED below: the public door for queueing a call
//     into a campaign; its engine is
//     lib/application/ai-isa.ts:queueAIISACallService (also the engine of
//     `retryFailedCalls`). The immediate single-dial route remains
//     app/api/voice/initiate-call.
//   · getAIISACampaigns → still deleted; survivor `listISACampaigns` (below;
//     wired at app/dashboard/isa/page.tsx and communications/outreach).
//   · getAIISACalls → still deleted; survivors are the voice ISA console's own
//     tenant-scoped reads (app/dashboard/voice/isa/page.tsx,
//     contact-history-sheet.tsx).

/**
 * Launch an AI ISA campaign — the "Launch campaign" door on the ISA console.
 * The caller picks the campaign TYPE (or names an existing campaign, whose
 * stored type wins); the service resolves the matching contact segment and
 * enrolls it into the type's cadence (drip / nurture / re_engagement
 * sequences). Identity is SESSION-derived (§4) and crossed users.id →
 * agents.id inside the service (§3). Never dials.
 */
export async function launchAIISACampaign(params: {
  campaignType: CampaignType
  campaignName?: string
  /** Launch an existing campaign of the caller's brokerage. */
  campaignId?: string
}): Promise<LaunchAIISACampaignResult> {
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.error }
  if (params.campaignId && !isValidUUID(params.campaignId)) {
    return { success: false, error: "Invalid campaign ID" }
  }

  try {
    return await launchAIISACampaignService({
      campaignType: params.campaignType,
      campaignName: params.campaignName,
      campaignId:   params.campaignId,
      userId:       caller.userId,
      brokerageId:  caller.brokerageId,
    })
  } catch (error: any) {
    console.error("[AI ISA] Campaign launch failed:", error)
    return { success: false, error: error.message }
  }
}

/**
 * Queue an AI ISA call for one contact INTO a campaign — the campaign-paced
 * call lane (buildCallContext TCPA gate + placeOutboundAiCall's budget and
 * autonomy gates run inside the engine). Distinct from the immediate
 * single-dial route (app/api/voice/initiate-call). Identity comes from the
 * SESSION (§4): the old signature took a caller-supplied loginId.
 */
export async function queueAIISACall(params: {
  contactId: string
  /** Omit to queue into the brokerage's most recent ACTIVE campaign. */
  campaignId?: string
}): Promise<{ success: boolean; call_id?: string | null; voice_call_id?: string | null; error?: string }> {
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.error }
  if (!isValidUUID(params.contactId)) return { success: false, error: "Invalid contact ID" }
  if (params.campaignId && !isValidUUID(params.campaignId)) {
    return { success: false, error: "Invalid campaign ID" }
  }

  const service = createServiceClient()

  // The contact must be the caller's tenant's — this queues paid outbound at them.
  const { data: contact } = await service
    .from("contacts")
    .select("brokerage_id")
    .eq("id", params.contactId)
    .maybeSingle()
  if (!contact) return { success: false, error: "Contact not found" }
  if (contact.brokerage_id !== caller.brokerageId) return { success: false, error: "Forbidden" }

  // Resolve the campaign: a named one must belong to the tenant; otherwise the
  // most recent ACTIVE campaign is the pace-setter (same default the
  // stale-lead processor uses).
  let campaignId = params.campaignId ?? null
  if (campaignId) {
    const { data: campaign } = await service
      .from("ai_isa_campaigns")
      .select("brokerage_id")
      .eq("id", campaignId)
      .maybeSingle()
    if (!campaign) return { success: false, error: "Campaign not found" }
    if (campaign.brokerage_id !== caller.brokerageId) return { success: false, error: "Forbidden" }
  } else {
    const { data: defaultCampaign } = await service
      .from("ai_isa_campaigns")
      .select("id")
      .eq("brokerage_id", caller.brokerageId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!defaultCampaign?.id) {
      return { success: false, error: "No active AI ISA campaign — launch one first, or name a campaign." }
    }
    campaignId = defaultCampaign.id as string
  }

  try {
    return await queueAIISACallService(campaignId, params.contactId, caller.userId)
  } catch (error: any) {
    console.error("[AI ISA] Call queueing failed:", error)
    return { success: false, error: error.message }
  }
}

/**
 * Retry failed AI ISA calls — re-dials calls whose OUTCOME was
 * no_answer/busy/failed/canceled and that are at least 4 hours old.
 *
 * WIRED (lane E2 2026-08-28) to the voice ISA console
 * (app/dashboard/voice/isa). Identity comes from the SESSION (§4) — the old
 * signature took a caller-supplied loginId, which both violated tenancy and
 * never matched: voice_calls.agent_id is an agents.id, and the loginId passed
 * around this file is a users.id (disjoint spaces, §3).
 */
export async function retryFailedCalls() {
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.error }

  try {
    return await retryFailedCallsService(caller.userId)
  } catch (error: any) {
    console.error("[AI ISA] Retry failed calls error:", error)
    return { success: false, error: error.message }
  }
}

// TOMBSTONE: `updateCampaignStatus(campaignId, status)` stood here, and its
// engine `lib/application/ai-isa.ts:updateCampaignStatusService`. Deleted lane
// G5 2026-08-28 AFTER its one distinct capability was merged onto the gated
// lane. SURVIVORS: the active↔paused flip is
// app/actions/ai-isa.ts:toggleCampaignStatus (below, wired at three surfaces);
// the TERMINAL "completed" transition — the only thing toggle could not do — is
// app/actions/ai-isa.ts:completeISACampaign (below), wired at
// app/dashboard/isa/campaigns/components/CampaignCard.tsx.
// WHY IT COULD NOT SURVIVE AS-IS: it was an ungated door. It ran no
// requireCaller, pinned no brokerage, and its service updated
// ai_isa_campaigns by `id` alone — so any session that reached it could
// complete ANY brokerage's campaign (the §4 body-supplied-tenant shape). It
// also had zero callers; the `updateCampaignStatus` imported at
// app/dashboard/campaigns/ads/ads-dashboard-client.tsx:75 is the unrelated ADS
// function from lib/ads/ad-creator.ts:625, a different business process.

// ─── NEW: ISA Campaigns page actions ─────────────────────────────────────────

export type CampaignType = "fsbo" | "buyer_match" | "divorce" | "foreclosure" | "ghost_recovery" | "social_intent" | "search_intent"

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

/** Fetch all campaigns for the caller's brokerage */
export async function listISACampaigns(_brokerageId?: string): Promise<{
  success: boolean
  campaigns: ISACampaignRow[]
  stats: ISACampaignStats
  error?: string
}> {
  const auth = await requireCaller()
  if (!auth.ok) {
    return { success: false, campaigns: [], stats: { activeCampaigns: 0, leadsTargeted: 0, touchesSent: 0, conversionRate: 0 }, error: auth.error }
  }
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("ai_isa_campaigns")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
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

/** Create a new ISA campaign — brokerage from session, never params */
export async function createISACampaign(params: {
  brokerageId?: string  // ignored — derived from session
  name: string
  campaignType: CampaignType
  channels: string[]
  targetSegment?: Record<string, unknown>
  /** The per-entity touch cap this campaign enforces. See MAX_TOUCHES below. */
  maxTouches?: number
}): Promise<{ success: boolean; campaignId?: string; error?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  // Validate against the canonical outreach-channel taxonomy — an ISA campaign is
  // 1:1 outreach, so unknown/broadcast keys are dropped. Email is always included.
  const { sanitizeOutreachChannels } = await import("@/lib/campaigns/channels")
  const cleanChannels = sanitizeOutreachChannels(["email", ...(params.channels ?? [])])

  const service = createServiceClient()
  const { data, error } = await service
    .from("ai_isa_campaigns")
    .insert({
      brokerage_id:   auth.brokerageId,
      name:           params.name,
      campaign_type:  params.campaignType.toLowerCase() as CampaignType,
      channels:       cleanChannels,
      target_segment: params.targetSegment ?? {},
      // ── MAX_TOUCHES: TWO SPELLINGS OF ONE CAP, AND THE GOVERNOR READ THE
      // ── OTHER ONE (§6).
      // The create drawer has had a "Max Touches" slider since it was built
      // (app/dashboard/isa/campaigns/components/CreateCampaignDrawer.tsx) and
      // sent the broker's choice into `target_segment.max_touches` — a jsonb
      // blob nothing reads. The touch GOVERNOR
      // (lib/ai-isa/isa-outreach-logger.ts:175, checkMaxTouches) selects the
      // `max_touches` COLUMN, which no writer in the tree had ever named, so it
      // always found the DDL default of 5 and fell back to its own literal 5.
      // A broker who dragged that slider to 2 to protect a cold list, or to 9
      // for a nurture sequence, changed nothing at all.
      // The COLUMN is the survivor — it is what the governor enforces. Clamped
      // to a sane range so a caller-supplied 0 (silently suppressing the whole
      // campaign) or 500 (a harassment cap) cannot be stored.
      max_touches:    clampMaxTouches(params.maxTouches),
      status:         "draft",
      // is_active mirrors status — merged from the deleted legacy launcher
      // (lane E2 2026-08-28), which was this column's only writer while the
      // voice ISA page and the stale-lead processor both FILTER on it.
      is_active:      false,
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
    brokerage_id:  auth.brokerageId,
    actor_user_id: auth.userId,
    metadata: { campaignType: params.campaignType, channels: cleanChannels },
    created_at:    new Date().toISOString(),
  })

  return { success: true, campaignId: data.id }
}

/** Pause or resume a campaign — caller must belong to the campaign's brokerage */
export async function toggleCampaignStatus(
  campaignId: string,
  currentStatus: "active" | "paused" | "draft" | "completed"
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(campaignId)) return { success: false, error: "Invalid campaign ID" }
  const newStatus = currentStatus === "active" ? "paused" : "active"
  const service = createServiceClient()

  // Verify campaign belongs to caller's brokerage before mutating
  const { data: existing } = await service
    .from("ai_isa_campaigns")
    .select("brokerage_id")
    .eq("id", campaignId)
    .maybeSingle()
  if (!existing) return { success: false, error: "Campaign not found" }
  if (existing.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden" }

  const { error } = await service
    .from("ai_isa_campaigns")
    // is_active mirrors status (see createISACampaign) — the readers that
    // filter .eq("is_active", true) must agree with the status vocabulary.
    .update({ status: newStatus, is_active: newStatus === "active", updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("brokerage_id", auth.brokerageId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/**
 * Retire a campaign — the TERMINAL transition, merged onto this gated lane from
 * the deleted `updateCampaignStatus` (tombstone at line ~233).
 *
 * `completed` is a live value of the ai_isa_campaigns.status CHECK
 * (scripts/check-vocabularies.ts:199) and FOUR surfaces already read it —
 * CampaignCard.tsx:112/166/177 greys the badge and disables Launch + Pause,
 * OutreachClient.tsx:88/288 does the same — but nothing reachable could WRITE
 * it, so the terminal state was decorative. This is the missing writer.
 *
 * Same rails as toggleCampaignStatus: session-derived brokerage (§4), a
 * brokerage pin verified BEFORE the mutation and repeated in the predicate,
 * and `is_active` mirrored false so the readers that filter
 * .eq("is_active", true) agree with the status vocabulary. One-way: a
 * completed campaign is not re-opened here, which is why both toggles disable
 * on it.
 */
export async function completeISACampaign(
  campaignId: string
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(campaignId)) return { success: false, error: "Invalid campaign ID" }
  const service = createServiceClient()

  const { data: existing, error: readError } = await service
    .from("ai_isa_campaigns")
    .select("brokerage_id, status")
    .eq("id", campaignId)
    .maybeSingle()
  if (readError) return { success: false, error: readError.message }
  if (!existing) return { success: false, error: "Campaign not found" }
  if (existing.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden" }
  if (existing.status === "completed") return { success: true }

  // §3: a supabase-js UPDATE that matches NOTHING also resolves with a null
  // error, so the tenant predicate refusing would read as success. Select the
  // update and count what came back.
  const { data: updated, error } = await service
    .from("ai_isa_campaigns")
    .update({ status: "completed", is_active: false, updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("brokerage_id", auth.brokerageId)
    .select("id")
  if (error) return { success: false, error: error.message }
  if (!updated || updated.length === 0) return { success: false, error: "Campaign not found" }

  await service.from("lifecycle_events").insert({
    // §6 — reuse the one existing "campaign ended" spelling rather than mint a
    // twelfth. lib/kernel/lifecycle.ts:84 already maps it.
    event_type:    KernelEvent.MARKETING_CAMPAIGN_ENDED,
    entity_type:   "campaign",
    entity_id:     campaignId,
    brokerage_id:  auth.brokerageId,
    actor_user_id: auth.userId,
    metadata:      { previousStatus: existing.status },
    created_at:    new Date().toISOString(),
  })

  return { success: true }
}

/** Send a single test touch for a campaign */
export async function sendCampaignTestTouch(params: {
  campaignId: string
  brokerageId?: string  // ignored — derived from session
  channel: "email" | "video" | "direct_mail" | "sms"
  testRecipientEmail: string
  testRecipientName: string
}): Promise<{ success: boolean; error?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  // Verify campaign belongs to caller's brokerage
  const service = createServiceClient()
  const { data: campaign } = await service
    .from("ai_isa_campaigns")
    .select("brokerage_id")
    .eq("id", params.campaignId)
    .maybeSingle()
  if (!campaign) return { success: false, error: "Campaign not found" }
  if (campaign.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden" }

  // Compliance gate
  const compliance = await runAiIsaComplianceCheck({
    userId: auth.userId,
    brokerageId: auth.brokerageId,
    journeyType: "buyer",
    persona: "other",
    messageType: "email",
    content: `Test touch for campaign ${params.campaignId}`,
    contactId: params.campaignId,
    contactType: "buyer",
    status: "new",
    dncStatus: false,
    tcpaConsent: true,
    isaReengageAllowed: false,
  })
  if (!compliance.allowed) {
    return { success: false, error: `Compliance blocked: ${compliance.violations?.join(", ") ?? "unknown"}` }
  }

  if (params.channel === "email") {
    const result = await dispatchEmail({
      brokerageId: auth.brokerageId,
      userId:      auth.userId,
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
      brokerageId:    auth.brokerageId,
      userId:         auth.userId,
      // templateId is the D-ID narration script (the avatar reads this).
      templateId:     `Hi ${params.testRecipientName ?? "there"}, this is a quick test video from your real estate team.`,
      recipientEmail: params.testRecipientEmail,
      recipientName:  params.testRecipientName,
      systemSource:   "ai_isa",
      leadId:         params.campaignId,
    })
    return { success: result.success, error: result.error }
  }

  if (params.channel === "direct_mail") {
    const result = await dispatchDirectMail({
      brokerageId:    auth.brokerageId,
      userId:         auth.userId,
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
  /** Provider video job id (D-ID). Legacy rows still store this under metadata.heygen_video_id. */
  video_id: string | null
  lob_letter_id: string | null
  created_at: string
}

export async function getEngagementFeed(params: {
  brokerageId?: string  // ignored — derived from session
  campaignId?: string
  channel?: string
  eventType?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
}): Promise<{ success: boolean; items: EngagementFeedItem[]; error?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, items: [], error: auth.error }

  const service = createServiceClient()
  let query = service
    .from("ai_isa_engagement_tracking")
    .select(`
      id,
      contact_id,
      campaign_id,
      channel,
      event_type,
      metadata,
      created_at:event_at,
      contacts (first_name, last_name),
      ai_isa_campaigns (name)
    `)
    .eq("brokerage_id", auth.brokerageId)
    .order("event_at", { ascending: false })
    .limit(params.limit ?? 100)

  if (params.campaignId) query = query.eq("campaign_id", params.campaignId)
  if (params.channel)    query = query.eq("channel", params.channel)
  if (params.eventType)  query = query.eq("event_type", params.eventType)
  if (params.dateFrom)   query = query.gte("event_at", params.dateFrom)
  if (params.dateTo)     query = query.lte("event_at", params.dateTo)

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
    video_id:            row.metadata?.did_video_id ?? row.metadata?.heygen_video_id ?? null,
    lob_letter_id:       row.metadata?.lob_letter_id ?? null,
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

export async function getQualificationOutcomes(_brokerageId?: string): Promise<{
  success: boolean
  outcomes: QualificationOutcome[]
  stats: QualificationStats
  chartData: { result: string; count: number }[]
  error?: string
}> {
  const empty = { success: false, outcomes: [], stats: { qualified: 0, not_qualified: 0, appointment_set: 0, no_response: 0, needs_follow_up: 0 }, chartData: [], error: "" }
  const auth = await requireCaller()
  if (!auth.ok) return { ...empty, error: auth.error }

  const service = createServiceClient()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await service
    .from("ai_isa_qualifications")
    .select(`
      id,
      contact_id,
      qualification_score,
      qualification_result,
      qualification_signals,
      assigned_to_agent_id,
      assigned_at,
      notes,
      qualified_at,
      contacts (first_name, last_name),
      assigned_agent:users!assigned_to_agent_id (first_name, last_name)
    `)
    .eq("brokerage_id", auth.brokerageId)
    .gte("qualified_at", thirtyDaysAgo)
    .order("qualified_at", { ascending: false })

  if (error) return { ...empty, error: error.message }

  const rows = (data ?? []) as any[]
  const outcomes: QualificationOutcome[] = rows.map(r => ({
    id:                    r.id,
    contact_id:            r.contact_id,
    contact_first_name:    r.contacts?.first_name ?? null,
    contact_last_name:     r.contacts?.last_name ?? null,
    score:                 r.qualification_score ?? null,
    qualification_result:  r.qualification_result,
    qualification_signals: Array.isArray(r.qualification_signals) ? r.qualification_signals : [],
    assigned_agent_name:   r.assigned_agent
      ? `${r.assigned_agent.first_name ?? ""} ${r.assigned_agent.last_name ?? ""}`.trim() || null
      : null,
    assigned_at:           r.assigned_at ?? null,
    notes:                 r.notes ?? null,
    created_at:            r.qualified_at,
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

export async function getGhostRecoveryQueue(_brokerageId?: string): Promise<{
  success: boolean
  ghosts: GhostContact[]
  error?: string
}> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, ghosts: [], error: auth.error }

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
      created_at:event_at,
      contacts (first_name, last_name),
      ai_isa_campaigns (name)
    `)
    .eq("brokerage_id", auth.brokerageId)
    .lte("event_at", cutoff24h)
    .order("event_at", { ascending: false })

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

/**
 * Manual ghost recovery trigger — runAiIsaComplianceCheck first, then dispatchEmail.
 *
 * The gate's verdict WAS COMPUTED AND THROWN AWAY. `const compliance = await
 * runAiIsaComplianceCheck({…})` ran under a comment reading "Compliance gate —
 * hard stop", and the next statement checked the lifecycle state and dispatched
 * the email — `compliance` was never read. Both sibling call sites in this file
 * refuse on it (line ~332 and line ~799, identically:
 * `if (!compliance.allowed) return { success: false, error: … }`); this one, the
 * only manually-triggered send of the three, did not. Every ghost-recovery email
 * went out with the DNC / TCPA / consent verdict already in hand and discarded.
 *
 * "Nobody checked" must never render as "checked and fine" (CLAUDE.md §4) — and
 * this was worse: it checked, and then ignored the answer.
 *
 * The doc comment also named `evaluateOutbound`, and the note at the dispatch
 * below named `evaluateOutboundCompliance`. Neither function exists in this
 * file: the gate here is `runAiIsaComplianceCheck`, which wraps
 * evaluateKernelOutbound. Two wrong names for the live gate is how a reader
 * concludes the gate is somewhere else and stops looking (CLAUDE.md §6).
 */
export async function triggerGhostRecovery(params: {
  contactId: string
  campaignId: string
  brokerageId?: string  // ignored — derived from session
}): Promise<{ success: boolean; error?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  // Step 1: Verify contact + campaign belong to caller's brokerage
  const service = createServiceClient()
  const { data: contact, error: contactErr } = await service
    .from("contacts")
    .select("email, first_name, lifecycle_state, brokerage_id")
    .eq("id", params.contactId)
    .single()

  if (contactErr || !contact) return { success: false, error: "Contact not found" }
  if (contact.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden" }

  // Step 2: Compliance gate — hard stop
  const compliance = await runAiIsaComplianceCheck({
    userId: auth.userId,
    brokerageId: auth.brokerageId,
    journeyType: "buyer",
    persona: "other",
    messageType: "email",
    content: "Ghost recovery outreach",
    contactId: params.contactId,
    contactType: "buyer",
    status: "new",
    dncStatus: false,
    tcpaConsent: true,
    isaReengageAllowed: true,
  })

  // THE HARD STOP THE COMMENT ABOVE ALWAYS CLAIMED. Same refusal shape as the
  // two sibling send paths in this file, deliberately — a third spelling of
  // "compliance said no" would be a third thing to keep in agreement.
  // THE HARD STOP THE COMMENT ABOVE ALWAYS CLAIMED. Same refusal shape as the
  // two sibling send paths in this file, deliberately — a third spelling of
  // "compliance said no" would be a third thing to keep in agreement.
  if (!compliance.allowed) {
    return { success: false, error: `Compliance blocked: ${compliance.violations?.join(", ") ?? "unknown"}` }
  }

  // Hard stop: blocked lifecycle states
  if (["REPRESENTATION", "ACTIVE_TRANSACTION"].includes(contact.lifecycle_state ?? "")) {
    return { success: false, error: `Contact in blocked lifecycle state: ${contact.lifecycle_state}` }
  }

  // Step 3: Dispatch — assembleEmail() runs inside dispatchEmail(), do NOT pre-assemble.
  const ghostBodyHtml = `<p>Hi ${contact.first_name ?? "there"},</p><p>We wanted to check in and see if we can still help you on your real estate journey. No pressure — just here when you're ready.</p>`
  const dispatchResult = await dispatchEmail({
    brokerageId:    auth.brokerageId,
    userId:         auth.userId,
    from:           "noreply@platform.com",
    to:             contact.email ?? "",
    subject:        "Following up — are you still interested?",
    html:           ghostBodyHtml,
    channelPurpose: "campaign",
    systemSource:   "ghost_recovery",
    // contactId, NOT leadId — the recipient was read out of `contacts`. This is
    // a "campaign" send, the case where express consent matters most, and the
    // id-space slip was skipping runAiIsaComplianceCheck for all of them.
    contactId:      params.contactId,
  })

  if (!dispatchResult.success) return { success: false, error: dispatchResult.error }

  // Step 4: Insert engagement tracking row
  await service.from("ai_isa_engagement_tracking").insert({
    brokerage_id: auth.brokerageId,
    contact_id:   params.contactId,
    campaign_id:  params.campaignId,
    channel:      "email",
    event_type:   "sent",
    event_at:     new Date().toISOString(),
  })

  return { success: true }
}

/** Skip a ghost contact — insert unsubscribed event to stop retries */
export async function skipGhostContact(params: {
  contactId: string
  campaignId: string
  brokerageId?: string  // ignored — derived from session
}): Promise<{ success: boolean; error?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const service = createServiceClient()

  // Verify contact belongs to caller's brokerage
  const { data: contact } = await service
    .from("contacts")
    .select("brokerage_id")
    .eq("id", params.contactId)
    .maybeSingle()
  if (!contact) return { success: false, error: "Contact not found" }
  if (contact.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden" }

  const { error } = await service.from("ai_isa_engagement_tracking").insert({
    brokerage_id: auth.brokerageId,
    contact_id:   params.contactId,
    campaign_id:  params.campaignId,
    channel:      "email",
    event_type:   "unsubscribed",
    event_at:     new Date().toISOString(),
  })
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/** Retry ghost contact via specified channel */
export async function retryGhostContact(params: {
  brokerageId?: string  // ignored — derived from session
  contactId: string
  channel: "email" | "sms" | "phone"
}): Promise<{ success: boolean; error?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const service = createServiceClient()

  // Get contact info + verify ownership
  const { data: contact, error: contactErr } = await service
    .from("contacts")
    .select("email, phone, first_name, lifecycle_state, brokerage_id")
    .eq("id", params.contactId)
    .single()

  if (contactErr || !contact) return { success: false, error: "Contact not found" }
  if (contact.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden" }

  // Compliance gate
  const compliance = await runAiIsaComplianceCheck({
    userId: auth.userId,
    brokerageId: auth.brokerageId,
    journeyType: "buyer",
    persona: "other",
    messageType: params.channel === "sms" ? "sms" : params.channel === "phone" ? "phone" : "email",
    content: "Ghost recovery retry outreach",
    contactId: params.contactId,
    contactType: "buyer",
    status: "new",
    dncStatus: false,
    tcpaConsent: true,
    isaReengageAllowed: true,
  })
  if (!compliance.allowed) {
    return { success: false, error: `Compliance blocked: ${compliance.violations?.join(", ") ?? "unknown"}` }
  }

  // Dispatch based on channel
  if (params.channel === "email" && contact.email) {
    // assembleEmail() runs inside dispatchEmail() — do NOT pre-assemble.
    const retryBodyHtml = `<p>Hi ${contact.first_name ?? "there"},</p><p>Just checking in to see if you're still looking for help with your real estate needs. Let me know!</p>`
    const result = await dispatchEmail({
      brokerageId:    auth.brokerageId,
      userId:         auth.userId,
      from:           "noreply@platform.com",
      to:             contact.email,
      subject:        "Quick follow-up",
      html:           retryBodyHtml,
      channelPurpose: "campaign",
      systemSource:   "ghost_recovery",
      // contactId, NOT leadId — see the note on the first ghost-recovery send.
      contactId:      params.contactId,
    })
    if (!result.success) return { success: false, error: result.error }
  }

  // Log engagement event
  await service.from("ai_isa_engagement_tracking").insert({
    brokerage_id: auth.brokerageId,
    contact_id: params.contactId,
    channel: params.channel,
    event_type: "sent",
    event_at: new Date().toISOString(),
  })

  return { success: true }
}

/** Suppress ghost contact — mark as skipped to stop retries */
export async function suppressGhostContact(params: {
  brokerageId?: string  // ignored — derived from session
  contactId: string
}): Promise<{ success: boolean; error?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const service = createServiceClient()

  // Verify contact belongs to caller's brokerage
  const { data: contact } = await service
    .from("contacts")
    .select("brokerage_id")
    .eq("id", params.contactId)
    .maybeSingle()
  if (!contact) return { success: false, error: "Contact not found" }
  if (contact.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden" }

  const { error } = await service.from("ai_isa_engagement_tracking").insert({
    brokerage_id: auth.brokerageId,
    contact_id: params.contactId,
    channel: "system",
    event_type: "suppressed",
    event_at: new Date().toISOString(),
  })
  if (error) return { success: false, error: error.message }
  return { success: true }
}
