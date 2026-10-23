/**
 * WorkflowReportsWidget — broker-admin surface for the Workflow OS
 * analytics layer (lib/workflow/intelligence + sequence_step_executions).
 *
 * Server component. Calls getWorkflowReport({ scope: 'brokerage', ... }).
 * Renders an at-a-glance summary card of the last 30 days:
 *   - Enrollments (total / active / completed)
 *   - Step runs (success / fail / blocked rates)
 *   - Conversions + GCI value
 *   - Top sequences
 *   - By-channel breakdown
 *
 * PURELY ADDITIVE — drop into the existing admin panel stack. Returns null
 * if no workflow data exists yet (clean dashboard for new brokerages).
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, Users, CheckCircle, XCircle, DollarSign, Sparkles } from "lucide-react"
import { getWorkflowReport } from "@/app/actions/workflow-reports"

interface Props {
  brokerageId: string
}

export default async function WorkflowReportsWidget({ brokerageId }: Props) {
  const result = await getWorkflowReport({
    scope:       "brokerage",
    brokerageId,
  })

  if (!result.success || !result.report) return null
  const report = result.report

  // Hide entirely if there's no workflow activity yet — keeps dashboards clean
  if (report.totalEnrollments === 0 && report.totalStepsRun === 0) return null

  const successPct = report.totalStepsRun > 0
    ? Math.round(report.successRate * 100)
    : 0
  const completionPct = report.totalEnrollments > 0
    ? Math.round((report.completedEnrollments / report.totalEnrollments) * 100)
    : 0
  const conversionPct = report.totalEnrollments > 0
    ? Math.round((report.totalConversions / report.totalEnrollments) * 100)
    : 0

  return (
    <Card className="border-violet-200 bg-gradient-to-br from-violet-50/30 to-transparent dark:from-violet-950/10">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-violet-600" />
          Workflow OS — Last 30 days
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Top-line metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Metric
            icon={<Users className="h-4 w-4" />}
            label="Enrollments"
            value={report.totalEnrollments.toLocaleString()}
            sublabel={`${report.activeEnrollments} active · ${completionPct}% complete`}
          />
          <Metric
            icon={<CheckCircle className="h-4 w-4 text-emerald-600" />}
            label="Step success"
            value={`${successPct}%`}
            sublabel={`${report.successfulSteps.toLocaleString()} of ${report.totalStepsRun.toLocaleString()} steps`}
          />
          <Metric
            icon={<XCircle className="h-4 w-4 text-red-500" />}
            label="Failures"
            value={report.failedSteps.toLocaleString()}
            sublabel={`${report.blockedSteps.toLocaleString()} blocked`}
          />
          {/* "Attributed revenue" used to render here from a column nothing has
              ever written, so every brokerage saw $0 in the same typeface as a
              real measurement. Deal DOLLARS are split by lib/marketing/
              attribution.ts across four models — that is the campaign ROI
              surface, not this one. What this page can honestly say is how many
              enrolled contacts went on to transact. */}
          <Metric
            icon={<DollarSign className="h-4 w-4 text-amber-600" />}
            label="Converted"
            value={report.totalConversions.toLocaleString()}
            sublabel={`${conversionPct}% of enrollments reached a deal`}
          />
        </div>

        {/* By-channel breakdown */}
        {Object.keys(report.byChannel).length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              By channel
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {Object.entries(report.byChannel)
                .sort((a, b) => b[1].runs - a[1].runs)
                .slice(0, 8)
                .map(([channel, counts]) => {
                  const channelSuccessPct = counts.runs > 0
                    ? Math.round((counts.successes / counts.runs) * 100)
                    : 0
                  return (
                    <div key={channel} className="rounded border bg-white dark:bg-slate-900 p-2.5">
                      <p className="text-xs font-medium capitalize truncate">
                        {channel.replace(/_/g, " ")}
                      </p>
                      <p className="text-base font-semibold mt-0.5">{counts.runs.toLocaleString()}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {channelSuccessPct}% success
                        {counts.failures > 0 && ` · ${counts.failures} failed`}
                      </p>
                    </div>
                  )
                })}
            </div>
          </div>
        )}

        {/* Top sequences */}
        {report.topSequences.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Top sequences
            </p>
            <ul className="space-y-1.5">
              {report.topSequences.slice(0, 5).map(seq => {
                const completionPct = Math.round(seq.completionRate * 100)
                return (
                  <li key={seq.sequenceId} className="flex items-center justify-between text-sm">
                    <span className="truncate flex-1">{seq.name}</span>
                    <span className="flex items-center gap-2 shrink-0 ml-3">
                      <Badge variant="outline" className="text-[10px]">{seq.enrollments} enrolled</Badge>
                      <span className={`text-xs tabular-nums ${
                        completionPct >= 70 ? "text-emerald-600"
                        : completionPct >= 40 ? "text-amber-600"
                        : "text-muted-foreground"
                      }`}>
                        {completionPct}%
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {report.averageCompletionDays != null && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2 border-t">
            <TrendingUp className="h-3.5 w-3.5" />
            Avg time to complete: <span className="text-foreground font-medium">{report.averageCompletionDays.toFixed(1)} days</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Metric({
  icon, label, value, sublabel,
}: {
  icon:     React.ReactNode
  label:    string
  value:    string
  sublabel: string
}) {
  return (
    <div className="rounded-lg border bg-white dark:bg-slate-900 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="text-xl font-semibold mt-1 tabular-nums">{value}</p>
      <p className="text-[10px] text-muted-foreground mt-0.5">{sublabel}</p>
    </div>
  )
}
