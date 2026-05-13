import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Brain, DollarSign, Zap, TrendingUp, Users, AlertTriangle } from "lucide-react"
import { getCurrentMonthUsage } from "@/lib/ai/cost-tracking"
import { getAgentAICostRanking } from "@/app/actions/pl-truth-engine"
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

function roiBadge(roi: number | null) {
  if (roi == null) return <Badge variant="outline" className="text-xs">no GCI yet</Badge>
  if (roi >= 50) return <Badge className="bg-emerald-100 text-emerald-800 text-xs">{roi.toFixed(0)}x ROI</Badge>
  if (roi >= 10) return <Badge className="bg-blue-100 text-blue-800 text-xs">{roi.toFixed(0)}x ROI</Badge>
  if (roi >= 1)  return <Badge className="bg-amber-100 text-amber-800 text-xs">{roi.toFixed(1)}x ROI</Badge>
  return <Badge className="bg-red-100 text-red-800 text-xs">{roi.toFixed(1)}x — below break-even</Badge>
}

export default async function AIUsagePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const [usage, agentRankingResult] = await Promise.all([
    getCurrentMonthUsage({}),
    getAgentAICostRanking(),
  ])

  if (!usage) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        No AI usage data available for this month.
      </div>
    )
  }

  const topModels = Object.entries(usage.usageByModel ?? {})
    .sort(([, a]: any, [, b]: any) => b.cost_cents - a.cost_cents)
    .slice(0, 8)

  const topFeatures = Object.entries(usage.usageByFeature ?? {})
    .sort(([, a]: any, [, b]: any) => b.cost_cents - a.cost_cents)
    .slice(0, 10)

  const maxModelCost   = topModels[0]   ? (topModels[0][1]   as any).cost_cents : 1
  const maxFeatureCost = topFeatures[0] ? (topFeatures[0][1] as any).cost_cents : 1

  const agentRows = agentRankingResult.ok ? agentRankingResult.rows : []
  const maxAgentCost = agentRows[0]?.cost_cents ?? 1

  // Agents where AI ROI < 1 (spending more on AI than GCI they generated)
  const belowBreakEven = agentRows.filter(r => r.roi_multiple !== null && r.roi_multiple < 1)

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">AI Usage &amp; Cost</h1>
        <p className="text-muted-foreground text-sm mt-1">
          This month&apos;s AI consumption — by model, feature, and agent with GCI ROI attribution
        </p>
      </div>

      {/* Hero metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="h-4 w-4 text-primary" />
              <p className="text-xs text-muted-foreground">Total Cost (MTD)</p>
            </div>
            <p className="text-3xl font-bold">{formatCost(usage.totalCostCents)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Zap className="h-4 w-4 text-amber-500" />
              <p className="text-xs text-muted-foreground">Total Tokens</p>
            </div>
            <p className="text-3xl font-bold">{formatTokens(usage.totalTokens)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Brain className="h-4 w-4 text-purple-500" />
              <p className="text-xs text-muted-foreground">Models Used</p>
            </div>
            <p className="text-3xl font-bold">{topModels.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Users className="h-4 w-4 text-blue-500" />
              <p className="text-xs text-muted-foreground">Agents with AI Spend</p>
            </div>
            <p className="text-3xl font-bold">{agentRows.length}</p>
            {belowBreakEven.length > 0 && (
              <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                {belowBreakEven.length} below break-even
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Model + Feature breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Cost by Model</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {topModels.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data</p>
            ) : topModels.map(([model, data]: any) => (
              <div key={model} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="font-medium truncate max-w-[60%]">{model}</span>
                  <span className="text-muted-foreground">{formatCost(data.cost_cents)}</span>
                </div>
                <Progress value={(data.cost_cents / maxModelCost) * 100} className="h-1.5" />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Cost by Feature</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {topFeatures.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data</p>
            ) : topFeatures.map(([feature, data]: any) => (
              <div key={feature} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="font-medium truncate max-w-[60%]">{feature.replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground">{formatCost(data.cost_cents)}</span>
                </div>
                <Progress value={(data.cost_cents / maxFeatureCost) * 100} className="h-1.5" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Per-agent cost + ROI attribution */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-emerald-600" />
            Per-Agent AI Cost &amp; GCI ROI
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              ROI = GCI generated ÷ AI spend this month
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {agentRows.length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">
              No per-agent AI usage data yet. Ensure <code>agent_id</code> is passed to{" "}
              <code>logAIUsage()</code> in each AI feature.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/10">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Agent</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">AI Spend</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Tokens</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Top Feature</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">GCI (MTD)</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">AI ROI</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Spend %</th>
                  </tr>
                </thead>
                <tbody>
                  {agentRows.map(r => (
                    <tr key={r.agent_id} className="border-b last:border-0 hover:bg-muted/10">
                      <td className="px-4 py-2.5 font-medium">{r.agent_name}</td>
                      <td className="px-4 py-2.5 text-right text-purple-700">
                        {formatCost(r.cost_cents)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground text-xs">
                        {formatTokens(r.token_count)}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {r.top_feature?.replace(/_/g, " ") ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {r.gci_gross > 0
                          ? `$${r.gci_gross.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {roiBadge(r.roi_multiple)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                        <div className="flex items-center justify-end gap-2">
                          <Progress
                            value={(r.cost_cents / maxAgentCost) * 100}
                            className="h-1.5 w-16"
                          />
                          {((r.cost_cents / usage.totalCostCents) * 100).toFixed(0)}%
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

      {belowBreakEven.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/30">
          <CardContent className="pt-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-amber-800">
                  {belowBreakEven.length} agent{belowBreakEven.length > 1 ? "s" : ""} below AI break-even this month
                </p>
                <p className="text-xs text-amber-700 mt-1">
                  {belowBreakEven.map(r => r.agent_name).join(", ")}. Their AI spend exceeds GCI generated.
                  Review feature usage or check if transactions are being recorded correctly.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
