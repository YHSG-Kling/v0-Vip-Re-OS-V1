"use server"

/**
 * app/actions/marketing-ops.ts
 *
 * The marketing OPS snapshot — the brokerage marketing-health read that used to
 * live on a separate "Ops Center" page (/dashboard/marketing/ops). That surface
 * duplicated the Marketing Studio menu area, so its unique read-only functions
 * (health strip, needs-attention triage incl. stale-draft detection, direct-mail
 * pipeline, connected-channel health) moved INTO Studio as a tab. This action is
 * that tab's data source — one gated server read, no writes.
 */

import { createClient } from "@/lib/supabase/server"
import { fetchReadinessStatistics } from "@/app/actions/campaign-readiness"

export interface MarketingOpsSnapshot {
  counts: { active: number; pendingApproval: number; failedPublishes: number; passRate: number | null }
  needsAttention: boolean
  failedPublishes: Array<{ id: string; platform: string | null; content: string | null }>
  pendingApproval: Array<{ id: string; campaign_name: string }>
  neverLaunched: Array<{ id: string; campaign_name: string; created_at: string }>
  mailCampaigns: Array<{ id: string; campaign_name: string; status: string; quantity: number | null }>
  integrations: Array<{
    id: string; provider_type: string; provider_name: string; status: string
    last_health_check_at: string | null; last_error: string | null
  }>
}

export async function getMarketingOpsSnapshot(): Promise<
  { ok: true; snapshot: MarketingOpsSnapshot } | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const { data: userRow } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = userRow?.brokerage_id
  if (!brokerageId) return { ok: false, error: "No brokerage associated with your account." }

  const now = new Date()
  const thirtyDaysAgo = new Date(now)
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const [campaignResult, socialResult, mailResult, readinessResult, integrationsResult] =
    await Promise.all([
      supabase
        .from("marketing_campaigns")
        .select("id, campaign_name, campaign_type, status, created_at, agent_user_id")
        .eq("brokerage_id", brokerageId)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("social_posts")
        .select("id, content, platform, status, scheduled_for, created_at")
        .eq("brokerage_id", brokerageId)
        .in("status", ["draft", "scheduled", "failed"])
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("direct_mail_campaigns")
        .select("id, campaign_name, status, quantity, created_at")
        .eq("brokerage_id", brokerageId)
        // In-flight = not yet mailed. Of the four this listed, only "approved"
        // exists, so the ops view silently showed approved campaigns only.
        .in("status", ["planning", "approved", "printed"])
        .limit(20),
      fetchReadinessStatistics(thirtyDaysAgo.toISOString(), now.toISOString()).catch(() => null),
      supabase
        .from("brokerage_integrations")
        .select("id, provider_type, provider_name, status, last_health_check_at, last_error")
        .eq("brokerage_id", brokerageId)
        .in("provider_type", ["social", "email", "sms", "direct_mail"]),
    ])

  const campaigns = campaignResult.data ?? []
  const socialPosts = socialResult.data ?? []
  const mailCampaigns = (mailResult.data ?? []) as MarketingOpsSnapshot["mailCampaigns"]
  const integrations = (integrationsResult.data ?? []) as MarketingOpsSnapshot["integrations"]

  const active = campaigns.filter((c) => c.status === "live").length
  const pendingApproval = campaigns
    .filter((c) => c.status === "pending_approval")
    .map((c) => ({ id: c.id, campaign_name: c.campaign_name }))
  const failedPublishes = socialPosts
    .filter((p) => p.status === "failed")
    .map((p) => ({ id: p.id, platform: p.platform, content: p.content }))
  const staleCutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000
  const neverLaunched = campaigns
    .filter((c) => c.status === "draft" && new Date(c.created_at).getTime() < staleCutoff)
    .map((c) => ({ id: c.id, campaign_name: c.campaign_name, created_at: c.created_at }))

  const passRate =
    readinessResult?.success && readinessResult.statistics
      ? readinessResult.statistics.ready_percentage
      : null

  return {
    ok: true,
    snapshot: {
      counts: { active, pendingApproval: pendingApproval.length, failedPublishes: failedPublishes.length, passRate },
      needsAttention: failedPublishes.length > 0 || pendingApproval.length > 0 || neverLaunched.length > 0,
      failedPublishes,
      pendingApproval,
      neverLaunched,
      mailCampaigns,
      integrations,
    },
  }
}
