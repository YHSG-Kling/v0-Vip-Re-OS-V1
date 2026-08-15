import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Brain, Zap, TrendingUp, Users, AlertTriangle, Gauge, DollarSign } from "lucide-react"
import { getCurrentMonthUsage } from "@/lib/ai/cost-tracking"
import { getAgentAICostRanking } from "@/app/actions/pl-truth-engine"
import { getBrokerageAIQuotaStatus } from "@/lib/ai/fair-use"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"

export const dynamic = "force-dynamic"

function formatCost(cents: number) {
  return `$${(cents / 100).toFixed(2)}`
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toString()
}

function tierLabel(t: string | null | undefined) {
  switch (t) {
    case "solo_agent":     return "Solo agent"
    case "team":           return "Team"
    case "brokerage":      return "Brokerage"
    case "multi_location": return "Multi-location"
    default:               return t ?? "—"
  }
}

function quotaBadge(status: string) {
  switch (status) {
    case "blocked":   return <Badge className="bg-red-100 text-red-800">At limit — blocked</Badge>
    case "warning":   return <Badge className="bg-amber-100 text-amber-800">Soft warning (80%)</Badge>
    case "unlimited": return <Badge className="bg-slate-100 text-slate-700">Unlimited</Badge>
    default:          return <Badge className="bg-emerald-100 text-emerald-800">Within limit</Badge>
  }
}

export default async function AIUsagePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Read BOTH identity columns + brokerage_id to gate dollar visibility
  // (superadmin only). `profile?.user_type === "superadmin"` alone was FALSE for
  // the platform's only superadmin, whose row is (user_type='admin',
  // platform_role='superadmin') — so every dollar figure on this page (per-model
  // cost, per-feature cost, the per-agent cost column and the ROI badge) was
  // hidden from the one person the gate was written to show them to, and the page
  // rendered its token-only broker view instead. Same shape as
  // public.is_platform_admin() in RLS; see app/actions/vendor-budget.ts:136-147.
  const { data: profile } = await supabase
    .from("users")
    .select("user_type, platform_role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  const isSuperadmin =
    profile?.user_type === "superadmin" || (profile as any)?.platform_role === "superadmin"
  const brokerageId  = profile?.brokerage_id as string | null

  const [usage, agentRankingResult, quota] = await Promise.all([
    getCurrentMonthUsage({ brokerageId: brokerageId ?? undefined }),
    getAgentAICostRanking(),
    brokerageId ? getBrokerageAIQuotaStatus(brokerageId) : Promise.resolve(null),
  ])

  if (!usage) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        No AI usage data available for this month.
      </div>
    )
  }

  // Models + features by token count (not cost) for the brokerage view.
  const topModels = Object.entries(usage.usageByModel ?? {})
    .sort(([, a]: any, [, b]: any) => (b.tokens ?? 0) - (a.tokens ?? 0))
    .slice(0, 8)
  const topFeatures = Object.entries(usage.usageByFeature ?? {})
    .sort(([, a]: any, [, b]: any) => (b.tokens ?? 0) - (a.tokens ?? 0))
    .slice(0, 10)

  const maxModelTokens   = topModels[0]   ? Number((topModels[0][1]   as any).tokens ?? 0) : 1
  const maxFeatureTokens = topFeatures[0] ? Number((topFeatures[0][1] as any).tokens ?? 0) : 1

  const agentRows = agentRankingResult.ok ? agentRankingResult.rows : []
  const maxAgentTokens = agentRows[0]?.token_count ?? 1
  const totalAgentTokens = agentRows.reduce((s, r) => s + (r.token_count ?? 0), 0) || 1

  // ROI is still meaningful even though brokers don't see dollar cost — it's
  // token efficiency: agent X's GCI ÷ tokens consumed. We render it as the
  // existing ROI multiple (GCI ÷ cost) since that's what the action returns,
  // but the BADGE only renders for superadmin to keep dollar context hidden.
  const belowBreakEven = agentRows.filter(r => r.roi_multiple !== null && r.roi_multiple < 1)

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">AI Usage</h1>
        <p className="text-muted-foreground text-sm mt-1">
          AI is included in your subscription. This page shows your monthly consumption
          against your plan&apos;s fair-use allowance.
        </p>
      </div>

      {/* Fair-use quota card — primary hero for brokers */}
      {quota && (
        <Card className={
          quota.quotaStatus === "blocked" ? "border-red-300 bg-red-50/40" :
          quota.quotaStatus === "warning" ? "border-amber-300 bg-amber-50/40" :
          ""
        }>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Gauge className="h-4 w-4 text-primary" />
                Monthly AI fair-use quota
              </CardTitle>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{tierLabel(quota.planTier)} plan</Badge>
                {quotaBadge(quota.quotaStatus)}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-3xl font-bold">{formatTokens(quota.tokensUsed)}</span>
              <span className="text-sm text-muted-foreground">
                of {quota.tokensLimit < 0 ? "unlimited" : `${formatTokens(quota.tokensLimit)} tokens`}
              </span>
            </div>
            <Progress
              value={quota.tokensLimit < 0 ? 0 : quota.percentUsed}
              className={
                quota.quotaStatus === "blocked" ? "h-2 bg-red-100" :
                quota.quotaStatus === "warning" ? "h-2 bg-amber-100" :
                "h-2"
              }
            />
            <p className="text-xs text-muted-foreground">
              {quota.quotaStatus === "blocked" && (
                <span className="text-red-700 font-medium">
                  Your plan has reached its monthly AI allowance. AI features will resume next month, or upgrade to continue immediately.
                </span>
              )}
              {quota.quotaStatus === "warning" && (
                <span className="text-amber-700">
                  You&apos;ve used {quota.percentUsed}% of this month&apos;s AI allowance — consider upgrading or pacing AI-heavy workflows.
                </span>
              )}
              {quota.quotaStatus === "ok" && (
                <span>Plenty of headroom this month.</span>
              )}
              {quota.quotaStatus === "unlimited" && (
                <span>Your plan has no AI usage limit.</span>
              )}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Hero metrics row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Zap className="h-4 w-4 text-amber-500" />
              <p className="text-xs text-muted-foreground">Tokens (MTD)</p>
            </div>
            <p className="text-3xl font-bold">{formatTokens(usage.totalTokens)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Brain className="h-4 w-4 text-purple-500" />
              <p className="text-xs text-muted-foreground">Models in use</p>
            </div>
            <p className="text-3xl font-bold">{topModels.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Users className="h-4 w-4 text-blue-500" />
              <p className="text-xs text-muted-foreground">Agents using AI</p>
            </div>
            <p className="text-3xl font-bold">{agentRows.length}</p>
          </CardContent>
        </Card>
        {/* Dollar cost card — SUPERADMIN ONLY. AI is bundled in sub for brokers. */}
        {isSuperadmin && (
          <Card className="border-purple-200 bg-purple-50/30">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-1">
                <DollarSign className="h-4 w-4 text-purple-600" />
                <p className="text-xs text-muted-foreground">Platform cost (superadmin)</p>
              </div>
              <p className="text-3xl font-bold">{formatCost(usage.totalCostCents)}</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Model + Feature breakdown — token-based for brokers */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Usage by Model</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {topModels.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data</p>
            ) : topModels.map(([model, data]: any) => (
              <div key={model} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="font-medium truncate max-w-[60%]">{model}</span>
                  <span className="text-muted-foreground">
                    {formatTokens(Number(data.tokens ?? 0))}
                    {isSuperadmin && <span className="ml-2 text-purple-600">({formatCost(data.cost_cents)})</span>}
                  </span>
                </div>
                <Progress value={(Number(data.tokens ?? 0) / maxModelTokens) * 100} className="h-1.5" />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Usage by Feature</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {topFeatures.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data</p>
            ) : topFeatures.map(([feature, data]: any) => (
              <div key={feature} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="font-medium truncate max-w-[60%]">{feature.replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground">
                    {formatTokens(Number(data.tokens ?? 0))}
                    {isSuperadmin && <span className="ml-2 text-purple-600">({formatCost(data.cost_cents)})</span>}
                  </span>
                </div>
                <Progress value={(Number(data.tokens ?? 0) / maxFeatureTokens) * 100} className="h-1.5" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Per-agent — token usage and (superadmin only) ROI */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-emerald-600" />
            Per-Agent AI Usage
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              {isSuperadmin
                ? "ROI = GCI generated ÷ AI cost this month"
                : "Tokens consumed this month per agent"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {agentRows.length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">
              No per-agent AI usage data yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/10">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Agent</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Tokens</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Top Feature</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">GCI (MTD)</th>
                    {isSuperadmin && (
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground">AI Cost</th>
                    )}
                    {isSuperadmin && (
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground">ROI</th>
                    )}
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {agentRows.map(r => (
                    <tr key={r.agent_id} className="border-b last:border-0 hover:bg-muted/10">
                      <td className="px-4 py-2.5 font-medium">{r.agent_name}</td>
                      <td className="px-4 py-2.5 text-right">{formatTokens(r.token_count)}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {r.top_feature?.replace(/_/g, " ") ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {r.gci_gross > 0
                          ? `$${r.gci_gross.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      {isSuperadmin && (
                        <td className="px-4 py-2.5 text-right text-purple-700">
                          {formatCost(r.cost_cents)}
                        </td>
                      )}
                      {isSuperadmin && (
                        <td className="px-4 py-2.5 text-right">
                          {r.roi_multiple === null
                            ? <Badge variant="outline" className="text-xs">no GCI</Badge>
                            : r.roi_multiple < 1
                            ? <Badge className="bg-red-100 text-red-800 text-xs">{r.roi_multiple.toFixed(1)}x</Badge>
                            : r.roi_multiple >= 10
                            ? <Badge className="bg-emerald-100 text-emerald-800 text-xs">{r.roi_multiple.toFixed(0)}x</Badge>
                            : <Badge className="bg-blue-100 text-blue-800 text-xs">{r.roi_multiple.toFixed(1)}x</Badge>}
                        </td>
                      )}
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                        <div className="flex items-center justify-end gap-2">
                          <Progress
                            value={(r.token_count / Math.max(maxAgentTokens, 1)) * 100}
                            className="h-1.5 w-16"
                          />
                          {((r.token_count / totalAgentTokens) * 100).toFixed(0)}%
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Below-break-even surface is SUPERADMIN ONLY — that signal is platform-margin */}
      {isSuperadmin && belowBreakEven.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/30">
          <CardContent className="pt-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-amber-800">
                  {belowBreakEven.length} agent{belowBreakEven.length > 1 ? "s" : ""} below AI break-even this month
                </p>
                <p className="text-xs text-amber-700 mt-1">
                  {belowBreakEven.map(r => r.agent_name).join(", ")}. AI spend exceeds GCI generated.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
