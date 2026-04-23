import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Brain, DollarSign, Zap } from "lucide-react"
import { getCurrentMonthUsage } from "@/lib/ai/cost-tracking"

function formatCost(cents: number) {
  return `$${(cents / 100).toFixed(2)}`
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toString()
}

export default async function AIUsagePage() {
  const usage = await getCurrentMonthUsage({})

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

  const maxModelCost = topModels[0] ? (topModels[0][1] as any).cost_cents : 1
  const maxFeatureCost = topFeatures[0] ? (topFeatures[0][1] as any).cost_cents : 1

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">AI Usage & Cost</h1>
        <p className="text-muted-foreground text-sm mt-1">This month&apos;s AI consumption across your platform</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
      </div>

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
    </div>
  )
}
