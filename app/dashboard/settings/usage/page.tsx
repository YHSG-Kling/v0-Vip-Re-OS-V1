/**
 * Usage Meter — broker / admin / superadmin / team_lead view.
 *
 * Shows the brokerage's plan tier, current month's usage per metric (with
 * soft-warning + exceeded callouts), and a top-5 consumers leaderboard.
 *
 * No vendor names — everything labeled by capability ("Voice synthesis",
 * "Twin avatars", "Live AI minutes").
 */

import { loadUsageOverview, type MetricSnapshot } from "@/app/actions/usage-overview"
import { Card } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { AlertTriangle, CheckCircle2, Infinity as InfinityIcon, TrendingUp } from "lucide-react"

export const dynamic = "force-dynamic"

const TIER_LABELS: Record<string, string> = {
  starter: "Starter",
  professional: "Professional",
  team: "Team",
  enterprise: "Enterprise",
}

export default async function UsagePage() {
  const res = await loadUsageOverview()

  if (!res.ok) {
    // Walkthrough [14]: this entry sits in the AGENT navigation but loadUsageOverview
    // admits broker/admin/superadmin/team_lead only, so a plain agent was silently
    // redirected to /dashboard — a click that appeared to do nothing. The entry itself
    // is NOT wrong: team leads share this navigation and legitimately see the meter.
    // What was wrong was bouncing without saying why. Consumption is billed to the
    // brokerage, so the meter is the broker's; an agent's own activity is on their
    // dashboard.
    if (res.error === "Forbidden") {
      return (
        <div className="p-6 max-w-lg space-y-2">
          <p className="text-sm font-medium">Plan usage is tracked at the brokerage level</p>
          <p className="text-sm text-muted-foreground">
            AI, voice and storage consumption is billed to your brokerage, so the meter is
            visible to your broker, admins and team leads. Your own activity and results are
            on your{" "}
            <a href="/dashboard" className="text-blue-600 hover:underline">
              dashboard
            </a>
            .
          </p>
        </div>
      )
    }
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Couldn&apos;t load usage. {res.error}
      </div>
    )
  }

  const { data } = res
  if (!data) return null

  const periodLabel = new Date(data.periodStart).toLocaleDateString("en-US", {
    month: "long", year: "numeric",
  })

  const exceededCount = data.metrics.filter((m) => m.status === "exceeded").length
  const warningCount = data.metrics.filter((m) => m.status === "warning").length

  return (
    <div className="container mx-auto px-4 py-6 max-w-5xl">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Usage</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your brokerage's consumption for {periodLabel}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-sm">
            {TIER_LABELS[data.planTier] ?? data.planTier} plan
          </Badge>
        </div>
      </div>

      {/* Status banner */}
      {exceededCount > 0 && (
        <Card className="border-destructive/40 bg-destructive/5 p-4 mb-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium text-sm text-destructive">
              {exceededCount === 1 ? "1 limit reached" : `${exceededCount} limits reached`}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Some features are temporarily blocked. Upgrade your plan to continue.
            </p>
          </div>
        </Card>
      )}
      {exceededCount === 0 && warningCount > 0 && (
        <Card className="border-amber-300 bg-amber-50 p-4 mb-4 flex items-start gap-3">
          <TrendingUp className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium text-sm text-amber-800">
              {warningCount === 1 ? "1 metric near its limit" : `${warningCount} metrics near their limits`}
            </p>
            <p className="text-xs text-amber-700/80 mt-0.5">
              Consider upgrading before you run out.
            </p>
          </div>
        </Card>
      )}
      {exceededCount === 0 && warningCount === 0 && data.metrics.length > 0 && (
        <Card className="border-emerald-300 bg-emerald-50 p-4 mb-4 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          <p className="text-sm text-emerald-800">All limits comfortable for this month.</p>
        </Card>
      )}

      {/* Metrics grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8">
        {data.metrics.map((m) => (
          <MetricCard key={m.metric} metric={m} />
        ))}
      </div>

      {/* Top consumers */}
      {data.topConsumers.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Top consumers this month</h2>
          <Card className="divide-y">
            {data.topConsumers.map((c, i) => (
              <div key={i} className="px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">
                    {c.agentName ?? "Unattributed"}
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {(c.metric.replace(/_/g, " "))}
                  </p>
                </div>
                <span className="text-sm tabular-nums font-medium">
                  {c.total.toLocaleString()}
                </span>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  )
}

function MetricCard({ metric }: { metric: MetricSnapshot }) {
  const barColor =
    metric.status === "exceeded" ? "bg-destructive" :
      metric.status === "warning" ? "bg-amber-500" : "bg-emerald-500"

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-medium">{metric.label}</p>
        {metric.unlimited ? (
          <Badge variant="outline" className="gap-1 text-xs">
            <InfinityIcon className="h-3 w-3" /> Unlimited
          </Badge>
        ) : metric.status === "exceeded" ? (
          <Badge variant="destructive" className="text-xs">Limit reached</Badge>
        ) : metric.status === "warning" ? (
          <Badge className="bg-amber-100 text-amber-800 text-xs">Near limit</Badge>
        ) : null}
      </div>

      {!metric.unlimited && (
        <>
          <div className="flex items-baseline justify-between text-xs text-muted-foreground mb-1.5">
            <span className="tabular-nums">
              <span className="font-medium text-foreground">{metric.used.toLocaleString()}</span>
              {" "}/ {metric.limit.toLocaleString()}
            </span>
            <span className="tabular-nums">{metric.percent}%</span>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${barColor}`}
              style={{ width: `${Math.min(100, metric.percent)}%` }}
            />
          </div>
        </>
      )}
      {metric.unlimited && (
        <p className="text-xs text-muted-foreground tabular-nums">
          Used: {metric.used.toLocaleString()}
        </p>
      )}
    </Card>
  )
}
