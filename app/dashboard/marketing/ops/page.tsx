import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { fetchReadinessStatistics } from "@/app/actions/campaign-readiness"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { BarChart3, AlertTriangle, Clock, CheckCircle2, Zap, Radio, Link2 } from "lucide-react"
import Link from "next/link"
import { formatDistanceToNow } from "date-fns"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Marketing Ops | VIP Real Estate AI OS",
  description: "Brokerage marketing health at a glance",
}

export default async function MarketingOpsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id, role")
    .eq("id", user.id)
    .single()

  if (!userRow?.brokerage_id) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-muted-foreground text-sm">
        No brokerage associated with your account.
      </div>
    )
  }

  const brokerageId = userRow.brokerage_id

  // Date window for readiness statistics (rolling 30 days)
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
        .in("status", ["draft", "pending_approval", "approved", "printing"])
        .limit(20),
      fetchReadinessStatistics(
        thirtyDaysAgo.toISOString(),
        now.toISOString()
      ).catch(() => null),
      supabase
        .from("brokerage_integrations")
        .select("id, provider_type, provider_name, status, last_health_check_at, last_error")
        .eq("brokerage_id", brokerageId)
        .in("provider_type", ["social", "email", "sms", "direct_mail"]),
    ])

  const campaigns = campaignResult.data ?? []
  const socialPosts = socialResult.data ?? []
  const mailCampaigns = mailResult.data ?? []
  const integrations = integrationsResult.data ?? []

  const activeCampaigns = campaigns.filter((c) => c.status === "live")
  const pendingApproval = campaigns.filter((c) => c.status === "pending_approval")
  const failedPublishes = socialPosts.filter((p) => p.status === "failed")
  const staleCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  const neverLaunched = campaigns.filter(
    (c) => c.status === "draft" && new Date(c.created_at).getTime() < staleCutoff
  )

  const passRate =
    readinessResult?.success && readinessResult.statistics
      ? readinessResult.statistics.ready_percentage
      : null

  const needsAttention =
    failedPublishes.length > 0 || pendingApproval.length > 0 || neverLaunched.length > 0

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-indigo-600" />
          Marketing Ops
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Brokerage marketing health at a glance
        </p>
      </div>

      {/* Health summary strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 mb-1">
              <Radio className="h-4 w-4 text-green-600" />
              <span className="text-xs text-muted-foreground font-medium">Active Campaigns</span>
            </div>
            <p className="text-2xl font-bold">{activeCampaigns.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-4 w-4 text-amber-500" />
              <span className="text-xs text-muted-foreground font-medium">Pending Approval</span>
            </div>
            <p className="text-2xl font-bold">{pendingApproval.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              <span className="text-xs text-muted-foreground font-medium">Failed Publishes</span>
            </div>
            <p className="text-2xl font-bold">{failedPublishes.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 className="h-4 w-4 text-indigo-600" />
              <span className="text-xs text-muted-foreground font-medium">Readiness Pass Rate</span>
            </div>
            <p className="text-2xl font-bold">
              {passRate != null ? `${Math.round(passRate)}%` : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Section 1 — Needs Attention */}
      {needsAttention && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
            <Zap className="h-4 w-4" />
            Needs Attention
          </h2>

          {failedPublishes.length > 0 && (
            <Card className="border-red-200 bg-red-50/40">
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-500" />
                  Failed Social Publishes ({failedPublishes.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-3 space-y-1">
                {failedPublishes.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between rounded px-2 py-1.5 bg-white border border-red-100 text-sm"
                  >
                    <span className="text-muted-foreground truncate max-w-xs">
                      <span className="font-medium text-foreground capitalize">{p.platform}</span>
                      {p.content ? ` · ${p.content.substring(0, 60)}…` : ""}
                    </span>
                    <Link
                      href={`/dashboard/social?post=${p.id}`}
                      className="ml-3 shrink-0 text-xs text-red-600 hover:underline font-medium"
                    >
                      Retry →
                    </Link>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {pendingApproval.length > 0 && (
            <Card className="border-amber-200 bg-amber-50/40">
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Clock className="h-4 w-4 text-amber-500" />
                  Awaiting Approval ({pendingApproval.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-3 space-y-1">
                {pendingApproval.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between rounded px-2 py-1.5 bg-white border border-amber-100 text-sm"
                  >
                    <span className="font-medium truncate max-w-xs">{c.campaign_name}</span>
                    <Link
                      href={`/dashboard/marketing/studio?campaign=${c.id}`}
                      className="ml-3 shrink-0 text-xs text-amber-700 hover:underline font-medium"
                    >
                      Review →
                    </Link>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {neverLaunched.length > 0 && (
            <Card className="border-gray-200">
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Clock className="h-4 w-4 text-gray-400" />
                  Stale Drafts — 7+ days, never launched ({neverLaunched.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-3 space-y-1">
                {neverLaunched.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between rounded px-2 py-1.5 bg-white border border-gray-100 text-sm"
                  >
                    <span className="truncate max-w-xs">
                      <span className="font-medium">{c.campaign_name}</span>
                      <span className="text-muted-foreground ml-2 text-xs">
                        {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                      </span>
                    </span>
                    <Link
                      href={`/dashboard/marketing/studio?campaign=${c.id}`}
                      className="ml-3 shrink-0 text-xs text-indigo-600 hover:underline font-medium"
                    >
                      Launch →
                    </Link>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Section 2 — Direct Mail Pipeline */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Direct Mail Pipeline
        </h2>
        {mailCampaigns.length === 0 ? (
          <p className="text-sm text-muted-foreground py-3">No active mail campaigns.</p>
        ) : (
          <div className="space-y-2">
            {mailCampaigns.map((mc) => (
              <div
                key={mc.id}
                className="flex items-center gap-3 border rounded-md px-3 py-2.5 bg-card"
              >
                <Badge variant="outline" className="capitalize shrink-0">
                  {mc.status.replace(/_/g, " ")}
                </Badge>
                <span className="text-sm font-medium truncate flex-1">{mc.campaign_name}</span>
                {mc.quantity != null && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {mc.quantity.toLocaleString()} pieces
                  </span>
                )}
                <Link
                  href={`/dashboard/campaigns/mail?campaign=${mc.id}`}
                  className="text-xs text-indigo-600 hover:underline shrink-0 font-medium"
                >
                  View →
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Section 3 — Connected Channels */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Link2 className="h-4 w-4" />
          Connected Channels
        </h2>
        {integrations.length === 0 ? (
          <p className="text-sm text-muted-foreground py-3">
            No channel integrations found. Connect channels in{" "}
            <Link href="/dashboard/settings/integrations" className="underline">
              Settings → Integrations
            </Link>
            .
          </p>
        ) : (
          <div className="rounded-md border overflow-hidden divide-y">
            {integrations.map((intg) => {
              const isHealthy = intg.status === "active" || intg.status === "connected"
              const isError = intg.status === "error" || intg.status === "failed"
              return (
                <div
                  key={intg.id}
                  className="flex items-center gap-3 px-3 py-2.5 bg-card text-sm"
                >
                  <Badge
                    variant={isError ? "destructive" : isHealthy ? "default" : "secondary"}
                    className="capitalize shrink-0 text-xs"
                  >
                    {intg.status}
                  </Badge>
                  <span className="font-medium flex-1 truncate">{intg.provider_name}</span>
                  <span className="text-xs text-muted-foreground capitalize shrink-0">
                    {intg.provider_type}
                  </span>
                  {intg.last_health_check_at && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      checked{" "}
                      {formatDistanceToNow(new Date(intg.last_health_check_at), {
                        addSuffix: true,
                      })}
                    </span>
                  )}
                  {isError && intg.last_error && (
                    <span
                      className="text-xs text-red-600 truncate max-w-xs shrink-0"
                      title={intg.last_error}
                    >
                      {intg.last_error.substring(0, 40)}…
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
