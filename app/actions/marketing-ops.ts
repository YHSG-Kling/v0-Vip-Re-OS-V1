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
import { fetchReadinessStatistics, fetchReadinessTrends } from "@/app/actions/campaign-readiness"

export interface MarketingOpsSnapshot {
  counts: { active: number; pendingApproval: number; failedPublishes: number; passRate: number | null }
  /**
   * Why the pass rate is null. A readiness statistic that could NOT be computed
   * (refused read, no brokerage, unreachable table) must be visibly different
   * from a computed 0% — supabase-js resolves a failed query, so an aggregate
   * over a refusal is indistinguishable from a genuine zero unless the failure
   * is carried out separately. null passRate + null passRateError = "no
   * evaluations recorded yet"; null passRate + a message = "could not compute".
   */
  passRateError: string | null
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
      // TENANT SCOPE. The readiness aggregate runs on the SERVICE-ROLE client
      // inside lib/campaign-readiness, so RLS is not its boundary — the
      // brokerage filter is. brokerageId here is the SESSION's (resolved from
      // the authenticated user's users row above), never anything the client
      // sent; the action re-checks it against the session and refuses a
      // mismatch. A thrown/rejected read is captured as a REASON, not folded
      // into a zero.
      fetchReadinessStatistics(brokerageId, thirtyDaysAgo.toISOString(), now.toISOString()).catch(
        (err: unknown): Awaited<ReturnType<typeof fetchReadinessStatistics>> => ({
          success: false,
          error: err instanceof Error ? err.message : "Readiness statistics could not be read",
        })
      ),
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

  // A REFUSED readiness read is not a 0% pass rate. Three distinct outcomes:
  //   · computed over ≥1 evaluation  → a number
  //   · computed over 0 evaluations  → null, no error ("nothing evaluated yet")
  //   · NOT computed (refused/threw) → null + the reason
  // Collapsing the third into 0% is exactly what supabase-js's resolve-on-error
  // makes easy, and exactly what must not happen on a tenant surface.
  const stats = readinessResult.success ? readinessResult.statistics : undefined
  const passRate = stats && stats.total_evaluations > 0 ? stats.ready_percentage : null
  const passRateError = stats
    ? null
    : (readinessResult.error ?? "Readiness pass rate could not be computed")

  return {
    ok: true,
    snapshot: {
      counts: { active, pendingApproval: pendingApproval.length, failedPublishes: failedPublishes.length, passRate },
      passRateError,
      needsAttention: failedPublishes.length > 0 || pendingApproval.length > 0 || neverLaunched.length > 0,
      failedPublishes,
      pendingApproval,
      neverLaunched,
      mailCampaigns,
      integrations,
    },
  }
}

export interface ReadinessTrendPoint {
  date: string
  ready_count: number
  blocked_count: number
  ready_percentage: number
}

/**
 * The Ops tab's READINESS TREND read — the daily ready/blocked split behind the
 * pass-rate tile, so a brokerage can see whether its campaign content is getting
 * more or less publishable over time rather than just today's single number.
 *
 * This is the surface fetchReadinessTrends was written for. It was held back
 * while the lib query behind it aggregated every brokerage on the platform; with
 * that query now brokerage-filtered and REQUIRING a brokerageId, it is wired.
 *
 * The brokerage comes from the SESSION (the authenticated user's users row) and
 * is never accepted from the client. A read that could not be performed returns
 * { ok: false, error } — it never degrades into an empty trend series, which
 * would render as a legitimate "no activity" flatline.
 */
export async function getReadinessTrendSnapshot(
  days: number = 30
): Promise<{ ok: true; trends: ReadinessTrendPoint[] } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const { data: userRow, error: userError } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (userError) return { ok: false, error: userError.message }
  const brokerageId = userRow?.brokerage_id
  if (!brokerageId) return { ok: false, error: "No brokerage associated with your account." }

  const span = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 365) : 30
  const now = new Date()
  const start = new Date(now)
  start.setDate(start.getDate() - span)

  const result = await fetchReadinessTrends(
    brokerageId,
    start.toISOString(),
    now.toISOString()
  ).catch((err: unknown): Awaited<ReturnType<typeof fetchReadinessTrends>> => ({
    success: false,
    error: err instanceof Error ? err.message : "Readiness trends could not be read",
  }))

  // A refused read is NOT an empty trend. `trends` is only trusted when the read
  // reported success AND actually returned a series.
  if (!result.success || !result.trends) {
    return { ok: false, error: result.error ?? "Readiness trends could not be read" }
  }

  return { ok: true, trends: result.trends }
}
