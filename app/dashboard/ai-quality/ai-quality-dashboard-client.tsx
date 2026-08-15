"use client"

import { useState } from "react"
import {
  Brain,
  MessageSquare,
  TrendingUp,
  TrendingDown,
  ThumbsUp,
  ThumbsDown,
  ChevronDown,
  ChevronRight,
  BarChart3,
  Sparkles,
  Calendar,
  FileText,
  Users,
  AlertTriangle,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts"
import { cn } from "@/lib/utils"

interface MetricData {
  source_system: string
  total_feedback: number
  positive_count: number
  negative_count: number
  approval_rate: number
  top_negative_themes: string[]
}

interface CalibrationEntry {
  id: string
  source_system: string
  trigger_type: string
  feedback_records_used: number
  approval_rate_before: number
  prompt_changes: {
    system_prompt_additions: string
    avoid_patterns: string[]
    suggested_examples: string
  }
  status: string
  created_at: string
}

interface AgentStat {
  agent_id: string
  agent_name: string
  total: number
  positive: number
  approval_rate: number
}

interface AIQualityDashboardClientProps {
  thisWeekMetrics: MetricData[]
  lastWeekMetrics: MetricData[]
  calibrationLog: CalibrationEntry[]
  agentStats: AgentStat[]
  thisWeekStart: string
  lastWeekStart: string
}

const SYSTEM_ICONS: Record<string, typeof Brain> = {
  daily_briefing: Calendar,
  coaching_report: Users,
  market_insight: TrendingUp,
  behavioral_pattern: BarChart3,
  smart_suggestion: Sparkles,
  isa_response: MessageSquare,
  content_generation: FileText,
  intent_classifier: Brain,
}

const SYSTEM_LABELS: Record<string, string> = {
  daily_briefing: "Daily Briefing",
  coaching_report: "Coaching Report",
  market_insight: "Market Insight",
  behavioral_pattern: "Behavioral Pattern",
  smart_suggestion: "Smart Suggestion",
  isa_response: "ISA Response",
  content_generation: "Content Generation",
  intent_classifier: "Intent Classifier",
}

export function AIQualityDashboardClient({
  thisWeekMetrics,
  lastWeekMetrics,
  calibrationLog,
  agentStats,
  thisWeekStart,
  lastWeekStart,
}: AIQualityDashboardClientProps) {
  const [expandedCalibration, setExpandedCalibration] = useState<string | null>(null)

  // Build metrics map for easy lookup
  const lastWeekMap = new Map(lastWeekMetrics.map((m) => [m.source_system, m]))

  // Calculate trend for each system
  const getSystemTrend = (system: string, currentRate: number) => {
    const lastWeek = lastWeekMap.get(system)
    if (!lastWeek) return null
    return currentRate - lastWeek.approval_rate
  }

  // Prepare scatter chart data from calibration log
  const timelineData = calibrationLog.map((entry) => ({
    date: new Date(entry.created_at).getTime(),
    approval_rate: entry.approval_rate_before,
    system: entry.source_system,
  }))

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    })
  }

  const getApprovalColor = (rate: number) => {
    if (rate >= 80) return "text-green-600 bg-green-50"
    if (rate >= 60) return "text-amber-600 bg-amber-50"
    return "text-red-600 bg-red-50"
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">AI Quality & Learning</h1>
            <p className="text-muted-foreground">
              This Week ({formatDate(thisWeekStart)}) vs Last Week ({formatDate(lastWeekStart)})
            </p>
          </div>
          <Badge variant="outline" className="text-sm">
            {thisWeekMetrics.reduce((sum, m) => sum + m.total_feedback, 0)} total feedbacks this week
          </Badge>
        </div>

        {/* System Performance Grid */}
        <div>
          <h2 className="text-lg font-semibold mb-4">System Performance</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {Object.keys(SYSTEM_LABELS).map((system) => {
              const metrics = thisWeekMetrics.find((m) => m.source_system === system)
              const Icon = SYSTEM_ICONS[system] || Brain
              const approvalRate = metrics?.approval_rate ?? 0
              const trend = metrics ? getSystemTrend(system, approvalRate) : null

              return (
                <Card key={system}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4 text-muted-foreground" />
                        <CardTitle className="text-sm font-medium">
                          {SYSTEM_LABELS[system]}
                        </CardTitle>
                      </div>
                      {approvalRate < 70 && (
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {/* Approval Rate */}
                    <div className="flex items-baseline gap-2">
                      <span
                        className={cn(
                          "text-3xl font-bold px-2 py-1 rounded",
                          getApprovalColor(approvalRate)
                        )}
                      >
                        {approvalRate}%
                      </span>
                      {trend !== null && (
                        <span
                          className={cn(
                            "flex items-center text-sm",
                            trend > 0 ? "text-green-600" : trend < 0 ? "text-red-600" : "text-muted-foreground"
                          )}
                        >
                          {trend > 0 ? (
                            <TrendingUp className="h-3 w-3 mr-1" />
                          ) : trend < 0 ? (
                            <TrendingDown className="h-3 w-3 mr-1" />
                          ) : null}
                          {trend > 0 ? "+" : ""}
                          {trend}pp
                        </span>
                      )}
                    </div>

                    {/* Feedback Counts */}
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <ThumbsUp className="h-3 w-3" />
                        {metrics?.positive_count ?? 0}
                      </span>
                      <span className="flex items-center gap-1">
                        <ThumbsDown className="h-3 w-3" />
                        {metrics?.negative_count ?? 0}
                      </span>
                    </div>

                    {/* Negative Themes */}
                    {metrics?.top_negative_themes && metrics.top_negative_themes.length > 0 && (
                      <Accordion type="single" collapsible className="w-full">
                        <AccordionItem value="themes" className="border-none">
                          <AccordionTrigger className="py-1 text-xs text-muted-foreground hover:no-underline">
                            Top Issues ({metrics.top_negative_themes.length})
                          </AccordionTrigger>
                          <AccordionContent>
                            <ul className="space-y-1">
                              {metrics.top_negative_themes.map((theme, i) => (
                                <li key={i} className="text-xs text-muted-foreground">
                                  {theme}
                                </li>
                              ))}
                            </ul>
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </div>

        {/* Two Column Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Calibration Log Table */}
          <Card>
            <CardHeader>
              <CardTitle>Calibration Log</CardTitle>
              <CardDescription>Recent prompt improvement sessions</CardDescription>
            </CardHeader>
            <CardContent>
              {calibrationLog.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No calibrations yet. Calibrations are generated for systems with {`<`}70% approval rate.
                </p>
              ) : (
                <div className="space-y-2">
                  {calibrationLog.slice(0, 10).map((entry) => (
                    <div
                      key={entry.id}
                      className="border rounded-lg overflow-hidden"
                    >
                      <button
                        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
                        onClick={() =>
                          setExpandedCalibration(
                            expandedCalibration === entry.id ? null : entry.id
                          )
                        }
                      >
                        <div className="flex items-center gap-3">
                          <Badge variant="outline" className="text-xs">
                            {SYSTEM_LABELS[entry.source_system] || entry.source_system}
                          </Badge>
                          <span className="text-sm text-muted-foreground">
                            {new Date(entry.created_at).toLocaleDateString()}
                          </span>
                          <span className={cn("text-sm", getApprovalColor(entry.approval_rate_before))}>
                            {entry.approval_rate_before}%
                          </span>
                        </div>
                        {expandedCalibration === entry.id ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>
                      {expandedCalibration === entry.id && (
                        <div className="p-3 border-t bg-muted/30 space-y-3">
                          <div>
                            <p className="text-xs font-medium text-muted-foreground mb-1">
                              Suggested Prompt Additions
                            </p>
                            <p className="text-sm">
                              {entry.prompt_changes.system_prompt_additions}
                            </p>
                          </div>
                          {entry.prompt_changes.avoid_patterns.length > 0 && (
                            <div>
                              <p className="text-xs font-medium text-muted-foreground mb-1">
                                Avoid Patterns
                              </p>
                              <ul className="list-disc list-inside text-sm">
                                {entry.prompt_changes.avoid_patterns.map((p, i) => (
                                  <li key={i}>{p}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Agent Personalization Panel */}
          <Card>
            <CardHeader>
              <CardTitle>Agent Personalization</CardTitle>
              <CardDescription>Per-agent approval rates (agents with {">"}10 feedbacks)</CardDescription>
            </CardHeader>
            <CardContent>
              {agentStats.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No agents have enough feedback yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent</TableHead>
                      <TableHead className="text-right">Feedbacks</TableHead>
                      <TableHead className="text-right">Approval</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agentStats.map((stat) => (
                      <TableRow key={stat.agent_id}>
                        <TableCell className="font-medium">{stat.agent_name}</TableCell>
                        <TableCell className="text-right">{stat.total}</TableCell>
                        <TableCell className="text-right">
                          <span className={cn("px-2 py-1 rounded text-sm", getApprovalColor(stat.approval_rate))}>
                            {stat.approval_rate}%
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Learning Timeline */}
        <Card>
          <CardHeader>
            <CardTitle>Learning Timeline</CardTitle>
            <CardDescription>Calibration events and approval rates over time</CardDescription>
          </CardHeader>
          <CardContent>
            {timelineData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No calibration data yet. Timeline will populate as calibrations occur.
              </p>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      type="number"
                      domain={["auto", "auto"]}
                      tickFormatter={(value) =>
                        new Date(value).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })
                      }
                      name="Date"
                    />
                    <YAxis
                      dataKey="approval_rate"
                      domain={[0, 100]}
                      name="Approval Rate"
                      unit="%"
                    />
                    <Tooltip
                      formatter={((value: number, name: string) => {
                        if (name === "approval_rate") return [`${value}%`, "Approval Rate"]
                        return [value, name]
                      }) as any}
                      labelFormatter={(value) =>
                        new Date(value).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      }
                    />
                    <Scatter
                      data={timelineData}
                      fill="hsl(var(--primary))"
                      shape="circle"
                    />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
