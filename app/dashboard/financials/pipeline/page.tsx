import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { getRevenuePipelineProjectionAction } from "@/app/actions/revenue-pipeline"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { TrendingUp } from "lucide-react"

export const dynamic = "force-dynamic"

const ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`

export default async function RevenuePipelinePage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ADMIN_ROLES.has(ctx.userType)) redirect("/dashboard")

  const res = await getRevenuePipelineProjectionAction()
  if (!res.success) {
    return <div className="p-6 text-red-600">Failed to load pipeline: {res.error}</div>
  }
  const { windows, perAgent } = res.projection

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <TrendingUp className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Revenue Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            Probability-weighted GCI forecast — every open deal weighted by its stage's close likelihood and
            estimated close date.
          </p>
        </div>
      </div>

      {/* 30 / 60 / 90 windows */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {windows.map((w) => (
          <Card key={w.windowDays}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Next {w.windowDays} days</CardTitle>
              <CardDescription>{w.dealCount} open deal{w.dealCount === 1 ? "" : "s"}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{usd(w.weightedGci)}</p>
              <p className="text-xs text-muted-foreground mt-1">weighted GCI · {usd(w.rawGci)} unweighted</p>
              {w.byStage.length > 0 && (
                <div className="mt-3 space-y-1">
                  {w.byStage.slice(0, 4).map((s) => (
                    <div key={s.stage} className="flex justify-between text-xs text-muted-foreground">
                      <span className="capitalize">{s.stage.toLowerCase().replace(/_/g, " ")} ({s.count})</span>
                      <span className="tabular-nums">{usd(s.weightedGci)}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Per-agent rollup */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">By Agent</CardTitle>
          <CardDescription>Weighted GCI by horizon, plus open work in flight.</CardDescription>
        </CardHeader>
        <CardContent>
          {perAgent.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No open deals in the forecast window. New transactions appear here as they progress.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-4 font-medium">Agent</th>
                    <th className="py-2 pr-4 font-medium text-right">30d</th>
                    <th className="py-2 pr-4 font-medium text-right">60d</th>
                    <th className="py-2 pr-4 font-medium text-right">90d</th>
                    <th className="py-2 pr-4 font-medium text-right">Pending</th>
                    <th className="py-2 pr-4 font-medium text-right">Listings</th>
                    <th className="py-2 font-medium text-right">Buyers</th>
                  </tr>
                </thead>
                <tbody>
                  {perAgent.map((a) => (
                    <tr key={a.agentId} className="border-b last:border-0">
                      <td className="py-2 pr-4">{a.agentName}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{usd(a.weighted30)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{usd(a.weighted60)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums font-medium">{usd(a.weighted90)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{a.pendingCount}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{a.activeListingCount}</td>
                      <td className="py-2 text-right tabular-nums">{a.activeBuyerCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
