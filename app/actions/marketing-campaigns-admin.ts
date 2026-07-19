"use server"

/**
 * Sprint 9 — Marketing campaigns admin server actions.
 *
 * List + launch (manual override of the cron). Authoring of a campaign
 * already exists via lib/kernel/marketing.ts:createMarketingCampaign;
 * this file is the broker-side ops surface.
 */

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { publishMarketingCampaignSafe } from "@/lib/marketing/campaign-publisher"

const ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])

async function requireAdmin(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const { data: row } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!row?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  const userType = row.user_type as string
  if (!ADMIN_ROLES.has(userType)) {
    // TIER PARITY (owner rule): a solo-tier subscriber IS their own broker — their
    // one working seat often carries user_type 'agent'/'solo_agent', which locked
    // them out of their own bulk-campaign rail. Same allowance the voice
    // 'draft_save_plays' intent already applies (app/api/internal/voice-command).
    const svc = createServiceClient()
    const { data: b } = await svc
      .from("brokerages").select("plan_tier").eq("id", row.brokerage_id).maybeSingle()
    if ((b as { plan_tier?: string } | null)?.plan_tier !== "solo_agent") {
      return { ok: false, error: "Forbidden" }
    }
  }
  return { ok: true, userId: user.id, brokerageId: row.brokerage_id as string, userType }
}

export interface MarketingCampaignRow {
  id:                     string
  campaign_name:          string
  campaign_type:          string
  status:                 string
  scheduled_start_at:     string | null
  launched_at:            string | null
  audience_size_resolved: number
  impressions:            number
  engagements:            number
  conversions:            number
  /** Migration 1050: rolled-up linear-model attributed GCI dollars. */
  attributed_gci_total:   number
  attribution_synced_at:  string | null
  compliance_status:      string
  compliance_blocked_reason: string | null
  created_at:             string | null
}

export async function listMarketingCampaignsAction(): Promise<
  | { ok: true; rows: MarketingCampaignRow[] }
  | { ok: false; error: string }
> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("marketing_campaigns")
    .select("id, campaign_name, campaign_type, status, scheduled_start_at, launched_at, audience_size_resolved, impressions, engagements, conversions, attributed_gci_total, attribution_synced_at, compliance_status, compliance_blocked_reason, created_at")
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })
    .limit(100)
  if (error) return { ok: false, error: error.message }

  const rows = ((data ?? []) as Array<Record<string, unknown>>).map(r => ({
    id:                        r.id as string,
    campaign_name:             r.campaign_name as string,
    campaign_type:             r.campaign_type as string,
    status:                    r.status as string,
    scheduled_start_at:        (r.scheduled_start_at as string | null) ?? null,
    launched_at:               (r.launched_at as string | null) ?? null,
    audience_size_resolved:    (r.audience_size_resolved as number | null) ?? 0,
    impressions:               (r.impressions as number | null) ?? 0,
    engagements:               (r.engagements as number | null) ?? 0,
    conversions:               (r.conversions as number | null) ?? 0,
    attributed_gci_total:      Number((r.attributed_gci_total as number | null) ?? 0),
    attribution_synced_at:     (r.attribution_synced_at as string | null) ?? null,
    compliance_status:         r.compliance_status as string,
    compliance_blocked_reason: (r.compliance_blocked_reason as string | null) ?? null,
    created_at:                (r.created_at as string | null) ?? null,
  }))
  return { ok: true, rows }
}

export async function launchMarketingCampaignAction(
  campaignId: string,
): Promise<
  | { ok: true; audienceSize: number; complianceStatus: string }
  | { ok: false; error: string }
> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth

  // Tenant check
  const svc = createServiceClient()
  const { data: c } = await svc
    .from("marketing_campaigns")
    .select("brokerage_id")
    .eq("id", campaignId)
    .maybeSingle()
  if (!c) return { ok: false, error: "Campaign not found" }
  if (c.brokerage_id !== auth.brokerageId) return { ok: false, error: "Forbidden" }

  const result = await publishMarketingCampaignSafe(campaignId)
  if (!result.ok) return { ok: false, error: result.error ?? "Launch failed" }

  revalidatePath("/dashboard/admin/marketing-campaigns")
  return {
    ok:               true,
    audienceSize:     result.audienceSize ?? 0,
    complianceStatus: result.complianceStatus ?? "unknown",
  }
}
