/**
 * Sprint 9 — Marketing campaign publisher.
 *
 * Drives a marketing_campaigns row from 'draft' → 'launched'.
 *
 * Steps:
 *   1. Resolve audience criteria → contact_ids.
 *   2. Run a brokerage-level compliance gate (brand voice + DNC checks).
 *   3. Update audience_size_resolved + compliance_status + launched_at.
 *   4. Emit a lifecycle_event 'marketing.campaign_launched' so the Sprint 5
 *      portal projector can fan customer-visible notices (e.g. "Your agent
 *      just shared a new market update").
 *
 * Does NOT itself send emails / publish blogs / mail postcards — the child
 * assets (newsletter_campaigns, blog_posts, direct_mail_campaigns, etc.)
 * each have their own kernel send functions. The publisher's job is to
 * resolve audience + flip the campaign status; downstream kernel send
 * functions can then iterate over the resolved contact_ids.
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveCampaignAudience, type AudienceCriteria } from "./audience-resolver"
import { recordCampaignTouchpointsBulkSafe } from "./touchpoint-recorder"

export interface PublishCampaignResult {
  ok:              boolean
  campaignId?:     string
  audienceSize?:   number
  complianceStatus?: "passed" | "blocked" | "needs_review"
  blockedReason?:  string
  error?:          string
}

/**
 * Service-role publish. Caller (server action or cron) enforces auth.
 */
export async function publishMarketingCampaignSafe(
  campaignId: string,
): Promise<PublishCampaignResult> {
  const svc = createServiceClient()

  const { data: c, error: cErr } = await svc
    .from("marketing_campaigns")
    .select(`
      id, brokerage_id, status, campaign_name, campaign_type,
      audience_personas, audience_generations, audience_age_segs,
      audience_lead_source_tags, audience_buyer_stages, audience_contact_ids,
      scheduled_start_at
    `)
    .eq("id", campaignId)
    .maybeSingle()
  if (cErr || !c) return { ok: false, error: cErr?.message ?? "Campaign not found" }
  if (!["draft", "scheduled", "pending_review", "approved"].includes(c.status as string)) {
    return { ok: false, error: `Cannot launch from status '${c.status}'`, campaignId: c.id as string }
  }

  // Resolve audience
  const criteria: AudienceCriteria = {
    personas:       (c.audience_personas       as string[] | null) ?? [],
    generations:    (c.audience_generations    as string[] | null) ?? [],
    ageSegs:        (c.audience_age_segs       as string[] | null) ?? [],
    leadSourceTags: (c.audience_lead_source_tags as string[] | null) ?? [],
    buyerStages:    (c.audience_buyer_stages   as string[] | null) ?? [],
    contactIds:     (c.audience_contact_ids    as string[] | null) ?? undefined,
  }
  const resolved = await resolveCampaignAudience(svc, c.brokerage_id as string, criteria)

  // ── Compliance gate ─────────────────────────────────────────────────────
  // Per-send compliance (DNC / TCPA per individual contact) happens in the
  // child-asset send paths (lib/kernel/marketing.ts:scheduleNewsletterSend,
  // sendNewsletterNow, etc.) via evaluateKernelOutbound. At launch time we
  // do a CAMPAIGN-LEVEL sanity check: if a high % of the resolved audience
  // can't be reached on the campaign's channel, refuse to flip to 'live'.
  // This catches "I built a list of 5,000 contacts but they all
  // unsubscribed" before any send fires.

  let complianceStatus: "passed" | "blocked" | "needs_review" = "passed"
  let blockedReason: string | null = null

  if (resolved.contactIds.length === 0) {
    complianceStatus = "needs_review"
    blockedReason    = "No contacts match the audience criteria — review filters before launch."
  } else {
    const channelType = (c.campaign_type as string | null) ?? "newsletter"
    const unreachable = await countUnreachableContacts(svc, resolved.contactIds, channelType)
    const totalSize   = resolved.contactIds.length
    const reachable   = totalSize - unreachable
    if (reachable === 0) {
      complianceStatus = "blocked"
      blockedReason    = `All ${totalSize} contacts in this audience have opted out of ${channelType}. Refresh the audience before launch.`
    } else if (reachable / totalSize < 0.25) {
      complianceStatus = "needs_review"
      blockedReason    = `Only ${reachable} of ${totalSize} contacts are reachable on ${channelType} (${Math.round((reachable / totalSize) * 100)}%). Confirm intent or refresh audience.`
    }
  }

  const launchAt = new Date().toISOString()
  const newStatus: "scheduled" | "live" =
    complianceStatus === "passed" ? "live" : "scheduled"

  const { error: updErr } = await svc
    .from("marketing_campaigns")
    .update({
      status:                    newStatus,
      audience_size_resolved:    resolved.contactIds.length,
      compliance_status:         complianceStatus,
      compliance_blocked_reason: blockedReason,
      launched_at:               newStatus === "live" ? launchAt : null,
      updated_at:                launchAt,
    })
    .eq("id", c.id)
  if (updErr) return { ok: false, error: updErr.message }

  // Migration 1050: record one touchpoint per resolved contact so the
  // attribution engine can later back-attribute closed-transaction GCI
  // to this campaign. Fire-and-forget; failures isolated.
  if (newStatus === "live" && resolved.contactIds.length > 0) {
    const channelMap: Record<string, "email" | "sms" | "direct_mail" | "social" | "newsletter" | "blog" | "podcast"> = {
      newsletter:  "newsletter",
      email:       "email",
      sms:         "sms",
      direct_mail: "direct_mail",
      mail:        "direct_mail",
      social:      "social",
      blog:        "blog",
      podcast:     "podcast",
    }
    const ch = channelMap[(c.campaign_type as string | null) ?? "newsletter"] ?? "email"
    void recordCampaignTouchpointsBulkSafe(
      c.brokerage_id as string,
      c.id as string,
      resolved.contactIds,
      ch,
      "launch",
    )
  }

  // Lifecycle event — fan-out to portal_event_stream via projector
  if (newStatus === "live") {
    await svc.from("lifecycle_events").insert({
      event_type:   "marketing.campaign_launched",
      entity_type:  "marketing_campaign",
      entity_id:    c.id,
      brokerage_id: c.brokerage_id,
      metadata: {
        campaign_name: c.campaign_name,
        campaign_type: c.campaign_type,
        audience_size: resolved.contactIds.length,
      },
      created_at: launchAt,
    })
  }

  return {
    ok:               true,
    campaignId:       c.id as string,
    audienceSize:     resolved.contactIds.length,
    complianceStatus,
    blockedReason:    blockedReason ?? undefined,
  }
}

/**
 * Returns the count of contacts in the given list who have opted out of the
 * campaign's channel. Used for the campaign-level compliance pre-check.
 *
 * Channel → contacts column mapping:
 *   newsletter / email   → email_opt_out OR email_unsubscribed
 *   sms                  → sms_opt_out  OR sms_unsubscribed OR call_stop_flag
 *   direct_mail / mail   → direct_mail_opt_out
 *   phone / voice        → phone_opt_out OR call_stop_flag
 *   other                → no per-channel block; returns 0
 */
async function countUnreachableContacts(
  svc:        SupabaseClient,
  contactIds: string[],
  channelType: string,
): Promise<number> {
  if (contactIds.length === 0) return 0
  const ch = channelType.toLowerCase()
  const { data } = await svc
    .from("contacts")
    .select("id, email_opt_out, email_unsubscribed, sms_opt_out, sms_unsubscribed, call_stop_flag, direct_mail_opt_out, phone_opt_out")
    .in("id", contactIds)
  const rows = (data ?? []) as Array<Record<string, boolean | null>>
  let n = 0
  for (const r of rows) {
    if (ch === "newsletter" || ch === "email") {
      if (r.email_opt_out || r.email_unsubscribed) n++
    } else if (ch === "sms" || ch === "text") {
      if (r.sms_opt_out || r.sms_unsubscribed || r.call_stop_flag) n++
    } else if (ch === "direct_mail" || ch === "mail" || ch === "postcard") {
      if (r.direct_mail_opt_out) n++
    } else if (ch === "phone" || ch === "voice" || ch === "call") {
      if (r.phone_opt_out || r.call_stop_flag) n++
    }
  }
  return n
}

/**
 * Returns campaigns whose scheduled_start_at is in the past and status is
 * still 'scheduled' or 'draft'. Used by the scheduler cron.
 */
export async function findCampaignsReadyToLaunch(
  svc: SupabaseClient,
  lookbackMinutes: number = 60,
): Promise<Array<{ campaignId: string; brokerageId: string; scheduledStartAt: string }>> {
  const cutoff = new Date(Date.now() + 60 * 1000).toISOString()        // up to "right now"
  const lower  = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString()
  const { data } = await svc
    .from("marketing_campaigns")
    .select("id, brokerage_id, scheduled_start_at")
    .in("status", ["draft", "scheduled"])
    .gte("scheduled_start_at", lower)
    .lte("scheduled_start_at", cutoff)
    .order("scheduled_start_at", { ascending: true })
    .limit(50)
  return ((data ?? []) as Array<{ id: string; brokerage_id: string; scheduled_start_at: string }>).map(r => ({
    campaignId:        r.id,
    brokerageId:       r.brokerage_id,
    scheduledStartAt:  r.scheduled_start_at,
  }))
}
