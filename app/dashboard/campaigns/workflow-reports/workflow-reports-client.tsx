"use client"

/**
 * WorkflowReportsClient — renders aggregated workflow OS metrics.
 * Filter UI updates URL params; the server component re-fetches.
 */

import { useRouter } from "next/navigation"
import { useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Loader2, Activity, CheckCircle2, XCircle, Pause, DollarSign, TrendingUp } from "lucide-react"
import type { WorkflowReportSummary, ReportScope } from "@/app/actions/workflow-reports"

interface Props {
  role:         string
  brokerageId:  string
  teamId:       string | null
  currentScope: ReportScope
  report:       WorkflowReportSummary | null
  error:        string | null
  filters:      { fromDate: string; toDate: string; channel: string }
}

export default function WorkflowReportsClient({
  role, currentScope, report, error, filters,
}: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function setUrl(updates: Record<string, string | null>) {
    const url = new URL(window.location.href)
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === "") url.searchParams.delete(k)
      else url.searchParams.set(k, v)
    }
    startTransition(() => router.push(url.pathname + url.search))
  }

  // Available scopes depend on role
  const availableScopes: Array<{ value: ReportScope; label: string }> = []
  availableScopes.push({ value: "agent", label: "My deals" })
  if (role === "team_lead" || role === "broker" || role === "admin" || role === "platform_admin") {
    availableScopes.push({ value: "team", label: "My team" })
  }
  if (role === "broker" || role === "admin" || role === "platform_admin") {
    availableScopes.push({ value: "brokerage", label: "Brokerage" })
  }

  return (
    <main className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Workflow Reports</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Sequence enrollments, step success rates, and conversion attribution.
          </p>
        </div>
        {pending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </header>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6 grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div>
            <label className="text-xs font-medium block mb-1">Scope</label>
            <Select value={currentScope} onValueChange={v => setUrl({ scope: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {availableScopes.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium block mb-1">From</label>
            <Input
              type="date"
              value={filters.fromDate.split("T")[0] ?? ""}
              onChange={e => setUrl({ from: e.target.value ? new Date(e.target.value).toISOString() : null })}
            />
          </div>
          <div>
            <label className="text-xs font-medium block mb-1">To</label>
            <Input
              type="date"
              value={filters.toDate.split("T")[0] ?? ""}
              onChange={e => setUrl({ to: e.target.value ? new Date(e.target.value).toISOString() : null })}
            />
          </div>
          <div>
            <label className="text-xs font-medium block mb-1">Channel</label>
            <Select value={filters.channel || "all"} onValueChange={v => setUrl({ channel: v === "all" ? null : v })}>
              <SelectTrigger><SelectValue placeholder="All channels" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All channels</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="sms">SMS</SelectItem>
                <SelectItem value="voice_drop">Voice drop</SelectItem>
                <SelectItem value="direct_mail">Direct mail</SelectItem>
                <SelectItem value="newsletter">Newsletter</SelectItem>
                <SelectItem value="ai_image">AI image</SelectItem>
                <SelectItem value="video">Video</SelectItem>
                <SelectItem value="social_post">Social post</SelectItem>
                <SelectItem value="ad_campaign">Ad campaign</SelectItem>
                <SelectItem value="send_gift">Gift</SelectItem>
                <SelectItem value="send_for_esign">eSign</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {report && (
        <>
          {/* Top stat cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="Enrollments"      value={report.totalEnrollments} icon={Activity} color="text-blue-600" />
            <StatCard label="Active"           value={report.activeEnrollments} icon={Activity} color="text-amber-600" />
            <StatCard label="Completed"        value={report.completedEnrollments} icon={CheckCircle2} color="text-emerald-600" />
            <StatCard label="Avg days to done" value={report.averageCompletionDays != null ? report.averageCompletionDays.toFixed(1) : "—"} icon={Activity} color="text-violet-600" />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="Steps run"        value={report.totalStepsRun} icon={Activity} color="text-slate-600" />
            <StatCard label="Successful"       value={report.successfulSteps} icon={CheckCircle2} color="text-emerald-600" />
            <StatCard label="Failed / blocked" value={report.failedSteps + report.blockedSteps} icon={XCircle} color="text-red-600" />
            <StatCard label="Success rate"     value={`${(report.successRate * 100).toFixed(1)}%`} icon={TrendingUp} color="text-emerald-600" />
          </div>

          {/* Both of these used to read workflow_step_runs.converted_at /
              conversion_value_cents — columns with no writer anywhere in the
              codebase, so the pair rendered "0" and "$0" for every brokerage,
              permanently. The count now comes from the enrollment (stamped when
              an enrolled contact's transaction closes); the dollar tile is gone
              because splitting deal revenue across what touched a contact is
              the attribution engine's job, and a second answer here is what put
              the dead columns on this page to begin with. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StatCard
              label="Converted"
              value={report.totalConversions}
              icon={CheckCircle2}
              color="text-emerald-700"
              hint="Enrolled contacts who went on to a transaction"
            />
            <StatCard
              label="Conversion rate"
              value={report.totalEnrollments > 0
                ? `${((report.totalConversions / report.totalEnrollments) * 100).toFixed(1)}%`
                : "—"}
              icon={TrendingUp}
              color="text-emerald-700"
              hint="Converted ÷ enrollments in range"
            />
          </div>

          {/* By channel */}
          <Card>
            <CardHeader><CardTitle className="text-base">By channel</CardTitle></CardHeader>
            <CardContent>
              {Object.keys(report.byChannel).length === 0 ? (
                <p className="text-sm text-muted-foreground">No step runs in this range.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b">
                      <tr>
                        <th className="text-left py-2 font-medium">Channel</th>
                        <th className="text-right py-2 font-medium">Runs</th>
                        <th className="text-right py-2 font-medium">Successes</th>
                        <th className="text-right py-2 font-medium">Failures</th>
                        <th className="text-right py-2 font-medium">Success rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(report.byChannel)
                        .sort(([, a], [, b]) => b.runs - a.runs)
                        .map(([channel, stats]) => {
                          const successRate = stats.runs > 0 ? (stats.successes / stats.runs) * 100 : 0
                          return (
                            <tr key={channel} className="border-b last:border-0">
                              <td className="py-2.5 font-medium capitalize">{channel.replace(/_/g, " ")}</td>
                              <td className="text-right">{stats.runs}</td>
                              <td className="text-right text-emerald-600">{stats.successes}</td>
                              <td className="text-right text-red-600">{stats.failures}</td>
                              <td className="text-right">
                                <Badge variant={successRate >= 80 ? "default" : successRate >= 50 ? "secondary" : "destructive"}>
                                  {successRate.toFixed(1)}%
                                </Badge>
                              </td>
                            </tr>
                          )
                        })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Top sequences */}
          <Card>
            <CardHeader><CardTitle className="text-base">Top sequences by enrollment</CardTitle></CardHeader>
            <CardContent>
              {report.topSequences.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sequences with enrollments in this range.</p>
              ) : (
                <ul className="space-y-2">
                  {report.topSequences.map(seq => (
                    <li key={seq.sequenceId} className="flex items-center justify-between rounded-md border bg-card px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{seq.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {seq.enrollments} enrolled · {(seq.completionRate * 100).toFixed(1)}% completion
                        </p>
                      </div>
                      <Button asChild size="sm" variant="ghost">
                        <a href={`/dashboard/campaigns/sequences/${seq.sequenceId}`}>Open →</a>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </main>
  )
}

function StatCard({
  label, value, icon: Icon, color, hint,
}: {
  label:  string
  value:  string | number
  icon:   React.ElementType
  color:  string
  hint?:  string
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="text-2xl font-semibold mt-1">{value}</p>
            {hint && <p className="text-[10px] text-muted-foreground mt-1.5">{hint}</p>}
          </div>
          <Icon className={`h-4 w-4 ${color}`} />
        </div>
      </CardContent>
    </Card>
  )
}
