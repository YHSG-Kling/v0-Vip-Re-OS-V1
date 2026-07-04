import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import Link from "next/link"
import {
  Building2, DollarSign, TrendingDown, TrendingUp, AlertTriangle,
  Gauge, Activity, ShieldAlert, Clock,
} from "lucide-react"
import {
  getPlatformOverviewAction,
  getCronHealthAction,
  getTenantSafetyFeedAction,
} from "@/app/actions/superadmin/platform-overview"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getBrokerageBudgetWarningEnabled } from "@/lib/vendor-governance/budget-gate"
import { BudgetWarningToggle } from "./budget-warning-toggle"
import { getPlatformControls } from "@/lib/platform/platform-controls"
import { PlatformControlsPanel } from "./platform-controls-panel"

export const dynamic = "force-dynamic"

function fmtCents(c: number) {
  return `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`
  return n.toString()
}
function fmtDuration(ms: number | null) {
  if (ms == null) return "—"
  if (ms < 1000)   return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
}
function fmtAgo(iso: string | null) {
  if (!iso) return "never"
  const dt = new Date(iso).getTime()
  const ms = Date.now() - dt
  if (ms < 60_000)         return "just now"
  if (ms < 3_600_000)      return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000)     return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}
function tierLabel(t: string | null | undefined) {
  switch (t) {
    case "solo_agent":     return "Solo"
    case "team":           return "Team"
    case "brokerage":      return "Brokerage"
    case "multi_location": return "Multi-loc"
    default:               return t ?? "—"
  }
}
function marginBadge(pct: number | null) {
  if (pct === null) return <Badge variant="outline" className="text-xs">no MRR</Badge>
  if (pct >= 70) return <Badge className="bg-emerald-100 text-emerald-800 text-xs">{pct.toFixed(0)}%</Badge>
  if (pct >= 40) return <Badge className="bg-blue-100 text-blue-800 text-xs">{pct.toFixed(0)}%</Badge>
  if (pct >= 0)  return <Badge className="bg-amber-100 text-amber-800 text-xs">{pct.toFixed(0)}%</Badge>
  return <Badge className="bg-red-100 text-red-800 text-xs">{pct.toFixed(0)}%</Badge>
}
function quotaBadge(s: string | null) {
  switch (s) {
    case "blocked":   return <Badge className="bg-red-100 text-red-800 text-xs">blocked</Badge>
    case "warning":   return <Badge className="bg-amber-100 text-amber-800 text-xs">warning</Badge>
    case "unlimited": return <Badge className="bg-slate-100 text-slate-700 text-xs">unlimited</Badge>
    case "ok":        return <Badge className="bg-emerald-100 text-emerald-800 text-xs">ok</Badge>
    default:          return <Badge variant="outline" className="text-xs">—</Badge>
  }
}

export default async function SuperadminPlatformPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (profile?.user_type !== "superadmin") {
    return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>
  }

  const [overviewRes, cronRes, safetyRes, budgetWarningEnabled, platformControls] = await Promise.all([
    getPlatformOverviewAction(),
    getCronHealthAction(),
    getTenantSafetyFeedAction(15),
    getBrokerageBudgetWarningEnabled(),
    getPlatformControls(),
  ])

  if (!overviewRes.ok) return <div className="p-6 text-red-600">Failed: {overviewRes.error}</div>

  const { totals, rows, fair_use_violators, losing_money } = overviewRes
  const cron = cronRes.ok ? cronRes : null
  const safety = safetyRes.ok ? safetyRes : null

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Platform — Superadmin</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Cross-tenant margin, fair-use violators, cron health, and tenant isolation findings.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">{totals.brokerage_count} brokerages</Badge>
          <Button asChild size="sm" variant="outline">
            <Link href="/dashboard/superadmin/brokerages">Manage all</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/dashboard/superadmin/connectors">Connectors</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/dashboard/superadmin/api-tokens">API Tokens</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/dashboard/superadmin/brokerages/new">+ Add subscriber</Link>
          </Button>
        </div>
      </div>

      {/* THE GOD SWITCH — platform-wide emergency mode / AI engine / rate limit (enforced at the autonomy gate) */}
      <PlatformControlsPanel initial={platformControls} />

      {/* Vendor-spend governance — brokerage warning visibility control */}
      <BudgetWarningToggle initialEnabled={budgetWarningEnabled} />

      {/* Hero row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Building2 className="h-4 w-4 text-blue-500" />
              <p className="text-xs text-muted-foreground">Active brokerages</p>
            </div>
            <p className="text-3xl font-bold">{totals.brokerage_count}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="h-4 w-4 text-emerald-600" />
              <p className="text-xs text-muted-foreground">MRR (MTD)</p>
            </div>
            <p className="text-3xl font-bold">{fmtCents(totals.total_mrr_cents)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              <Gauge className="h-4 w-4 text-purple-600" />
              <p className="text-xs text-muted-foreground">AI cost (MTD)</p>
            </div>
            <p className="text-3xl font-bold">{fmtCents(totals.total_ai_cents)}</p>
          </CardContent>
        </Card>
        <Card className={
          totals.margin_percent !== null && totals.margin_percent < 30
            ? "border-amber-300 bg-amber-50/30" : ""
        }>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              {totals.total_margin_cents >= 0
                ? <TrendingUp className="h-4 w-4 text-emerald-600" />
                : <TrendingDown className="h-4 w-4 text-red-600" />}
              <p className="text-xs text-muted-foreground">Platform margin</p>
            </div>
            <p className={`text-3xl font-bold ${totals.total_margin_cents < 0 ? "text-red-600" : ""}`}>
              {fmtCents(totals.total_margin_cents)}
            </p>
            {totals.margin_percent !== null && (
              <p className="text-xs text-muted-foreground mt-1">
                {totals.margin_percent.toFixed(1)}% gross margin on AI
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tier distribution */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Tier distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {(["solo_agent", "team", "brokerage", "multi_location"] as const).map(t => {
              const stats = totals.by_tier[t]
              const margin = stats.mrr_cents - stats.ai_cost_cents
              return (
                <div key={t} className="border rounded p-3">
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs font-medium uppercase text-muted-foreground">{tierLabel(t)}</span>
                    <span className="text-lg font-bold">{stats.count}</span>
                  </div>
                  <div className="text-xs mt-1 space-y-0.5">
                    <div className="flex justify-between"><span className="text-muted-foreground">MRR</span><span>{fmtCents(stats.mrr_cents)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">AI</span><span className="text-purple-700">{fmtCents(stats.ai_cost_cents)}</span></div>
                    <div className="flex justify-between font-medium"><span>Margin</span><span className={margin < 0 ? "text-red-600" : "text-emerald-700"}>{fmtCents(margin)}</span></div>
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Losing money / margin-at-risk alert */}
      {losing_money.length > 0 && (
        <Card className="border-red-200 bg-red-50/30">
          <CardContent className="pt-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-red-800">
                  {losing_money.length} brokerage{losing_money.length > 1 ? "s" : ""} consuming more AI than they pay
                </p>
                <p className="text-xs text-red-700 mt-1">
                  {losing_money.slice(0, 6).map(r => `${r.brokerage_name ?? "(unnamed)"} (${fmtCents(r.margin_cents)})`).join(" · ")}
                  {losing_money.length > 6 && " …"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Margin per tenant table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Margin per tenant
            <span className="ml-auto text-xs font-normal text-muted-foreground">Worst margin first</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/10">
                  <th className="text-left px-4 py-2 font-medium text-muted-foreground">Brokerage</th>
                  <th className="text-left px-4 py-2 font-medium text-muted-foreground">Tier</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground">MRR</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground">AI Cost</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground">Tokens</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground">Margin</th>
                  <th className="text-center px-4 py-2 font-medium text-muted-foreground">%</th>
                  <th className="text-center px-4 py-2 font-medium text-muted-foreground">Quota</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={8} className="text-center p-6 text-muted-foreground">No brokerages yet.</td></tr>
                ) : rows.map(r => (
                  <tr key={r.brokerage_id} className="border-b last:border-0 hover:bg-muted/10">
                    <td className="px-4 py-2.5 font-medium">{r.brokerage_name ?? "(unnamed)"}</td>
                    <td className="px-4 py-2.5"><Badge variant="outline" className="text-xs">{tierLabel(r.plan_tier)}</Badge></td>
                    <td className="px-4 py-2.5 text-right">{fmtCents(r.mrr_cents)}</td>
                    <td className="px-4 py-2.5 text-right text-purple-700">{fmtCents(r.ai_cost_cents)}</td>
                    <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{fmtTokens(r.ai_tokens)}</td>
                    <td className={`px-4 py-2.5 text-right font-medium ${r.margin_cents < 0 ? "text-red-600" : "text-emerald-700"}`}>
                      {fmtCents(r.margin_cents)}
                    </td>
                    <td className="px-4 py-2.5 text-center">{marginBadge(r.margin_percent)}</td>
                    <td className="px-4 py-2.5 text-center">
                      <div className="flex flex-col items-center gap-0.5">
                        {quotaBadge(r.quota_status)}
                        {r.quota_percent_used != null && r.quota_status !== "unlimited" && (
                          <span className="text-[10px] text-muted-foreground">{r.quota_percent_used}%</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Fair-use violators sidebar */}
      {fair_use_violators.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/20">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              Fair-use violators ({fair_use_violators.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {fair_use_violators.slice(0, 12).map(r => (
              <div key={r.brokerage_id} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2 min-w-0">
                  {quotaBadge(r.quota_status)}
                  <span className="truncate">{r.brokerage_name ?? "(unnamed)"}</span>
                  <Badge variant="outline" className="text-[10px]">{tierLabel(r.plan_tier)}</Badge>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Progress value={r.quota_percent_used ?? 0} className="h-1.5 w-20" />
                  <span className="text-xs text-muted-foreground tabular-nums">{r.quota_percent_used}%</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Cron health rollup */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            Cron health (all tenants)
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              {cron ? `${cron.totals.stale} stale · ${cron.totals.failing} failing` : "—"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!cron ? (
            <p className="p-4 text-sm text-muted-foreground">Failed to load cron health.</p>
          ) : cron.rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No crons have reported in yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/10">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Cron</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Status</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Last run</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Duration</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">7d fail / total</th>
                  </tr>
                </thead>
                <tbody>
                  {cron.rows.map(r => (
                    <tr key={r.cron_name} className="border-b last:border-0 hover:bg-muted/10">
                      <td className="px-4 py-2.5 font-mono text-xs">{r.cron_name}</td>
                      <td className="px-4 py-2.5">
                        {r.is_stale && <Badge className="bg-amber-100 text-amber-800 text-xs">stale</Badge>}
                        {!r.is_stale && r.last_status === "success" && <Badge className="bg-emerald-100 text-emerald-800 text-xs">ok</Badge>}
                        {!r.is_stale && r.last_status === "failure" && <Badge className="bg-red-100 text-red-800 text-xs">failure</Badge>}
                        {!r.is_stale && r.last_status === "running" && <Badge className="bg-blue-100 text-blue-800 text-xs">running</Badge>}
                        {!r.is_stale && r.last_status === "partial" && <Badge className="bg-amber-100 text-amber-800 text-xs">partial</Badge>}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{fmtAgo(r.last_run_at)}</td>
                      <td className="px-4 py-2.5 text-right text-xs">{fmtDuration(r.last_duration_ms)}</td>
                      <td className="px-4 py-2.5 text-right text-xs">
                        <span className={r.failure_count_7d > 0 ? "text-red-600 font-medium" : "text-muted-foreground"}>
                          {r.failure_count_7d}
                        </span>
                        {" / "}
                        <span className="text-muted-foreground">{r.run_count_7d}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tenant isolation feed */}
      <Card className={safety && safety.unresolved_count > 0 ? "border-red-200 bg-red-50/20" : ""}>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-red-600" />
            Tenant isolation findings
            {safety && safety.unresolved_count > 0 && (
              <Badge className="bg-red-100 text-red-800 ml-2">{safety.unresolved_count} unresolved</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!safety ? (
            <p className="p-4 text-sm text-muted-foreground">Failed to load tenant safety findings.</p>
          ) : safety.rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No tenant isolation findings — clean.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/10">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Finding</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Table</th>
                    <th className="text-center px-4 py-2 font-medium text-muted-foreground">Severity</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Rows</th>
                    <th className="text-center px-4 py-2 font-medium text-muted-foreground">Status</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Detected</th>
                  </tr>
                </thead>
                <tbody>
                  {safety.rows.map(f => (
                    <tr key={f.id} className="border-b last:border-0 hover:bg-muted/10">
                      <td className="px-4 py-2.5 text-xs font-mono">{f.finding_type}</td>
                      <td className="px-4 py-2.5 text-xs">{f.table_name}</td>
                      <td className="px-4 py-2.5 text-center">
                        <Badge className={
                          f.severity === "critical" ? "bg-red-100 text-red-800 text-xs" :
                          f.severity === "high"     ? "bg-orange-100 text-orange-800 text-xs" :
                          f.severity === "medium"   ? "bg-amber-100 text-amber-800 text-xs" :
                          "bg-slate-100 text-slate-700 text-xs"
                        }>{f.severity}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs">{f.affected_rows ?? "—"}</td>
                      <td className="px-4 py-2.5 text-center">
                        {f.resolved
                          ? <Badge className="bg-emerald-100 text-emerald-800 text-xs">resolved</Badge>
                          : <Badge className="bg-red-100 text-red-800 text-xs">open</Badge>}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{fmtAgo(f.created_at)}</td>
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
