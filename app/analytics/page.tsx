"use client"

import React from "react"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Gift,
  Users,
  Calculator,
  Heart,
  TrendingUp,
  Sparkles,
  Download,
  DollarSign,
  Target,
  Activity,
  Loader2,
  ArrowRight,
  X,
} from "lucide-react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { loadValueDrivenDashboard, getLeadValueJourneys } from "@/app/actions/analytics"
import { generatePageInsight } from "@/app/actions/generate-page-insight"
import { cn } from "@/lib/utils"

export default function AnalyticsDashboard() {
  const [view, setView] = useState("overview")
  const [period, setPeriod] = useState("month")
  const [dashboardData, setDashboardData] = useState<any>(null)
  const [leadJourneys, setLeadJourneys] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [aiSummary, setAiSummary] = useState<string | null>(null)
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false)

  useEffect(() => {
    loadData()
  }, [period])

  async function loadData() {
    try {
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      // Get agent ID from user using kernel resolver
      const agentId = await resolveAgentId(supabase, user.id)
      if (!agentId) {
        setLoading(false)
        return
      }

      const [dashboard, journeys] = await Promise.all([
        loadValueDrivenDashboard(agentId, period),
        getLeadValueJourneys(agentId, 20),
      ])

      setDashboardData(dashboard)
      setLeadJourneys(journeys)
      setLoading(false)
    } catch (error) {
      console.error("[v0] Failed to load analytics:", error)
      setLoading(false)
    }
  }

  const handleAiSummary = async () => {
    setAiSummaryLoading(true)
    const context = `Trust capital score: ${dashboardData?.trust_capital_score ?? 0}. Generosity score: ${dashboardData?.generosity_score ?? 0}%. Total value delivered: $${dashboardData?.total_value_delivered ?? 0}. Converted leads: ${dashboardData?.converted_leads ?? 0}. Period: ${period}.`
    const result = await generatePageInsight({
      context,
      question: "Based on this data, what is the single most important thing I should focus on next week to grow my business?",
    })
    setAiSummary(result.success ? (result.insight ?? null) : "Could not generate summary.")
    setAiSummaryLoading(false)
  }

  if (loading) {
    return (
      <div className="container mx-auto py-8">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
            <p className="text-muted-foreground">Loading analytics...</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b sticky top-0 z-10 bg-background">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <h1 className="text-2xl font-bold">Analytics</h1>

              {/* View Switcher */}
              <Tabs value={view} onValueChange={setView} className="w-auto">
                <TabsList>
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="value">Value Delivered</TabsTrigger>
                  <TabsTrigger value="performance">Performance</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-3">
              <Select value={period} onValueChange={setPeriod}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Select period" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="today">Today</SelectItem>
                  <SelectItem value="week">This Week</SelectItem>
                  <SelectItem value="month">This Month</SelectItem>
                  <SelectItem value="quarter">This Quarter</SelectItem>
                  <SelectItem value="ytd">Year to Date</SelectItem>
                </SelectContent>
              </Select>

              <Link href="/dashboard/diagnosis">
                <Button variant="ghost" size="sm" className="text-primary gap-1">
                  Open Diagnosis
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </Link>
              <Button
                variant="outline"
                size="sm"
                onClick={handleAiSummary}
                disabled={aiSummaryLoading || !dashboardData}
              >
                {aiSummaryLoading ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-2" />
                )}
                AI Summary
              </Button>
              <Button variant="outline">
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
            </div>
          </div>

          {/* AI Summary banner — shown after request */}
          {aiSummary && (
            <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3">
              <Sparkles className="h-4 w-4 text-indigo-500 mt-0.5 shrink-0" />
              <p className="text-sm text-indigo-900 leading-relaxed flex-1">{aiSummary}</p>
              <button
                onClick={() => setAiSummary(null)}
                className="shrink-0 text-indigo-300 hover:text-indigo-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="container mx-auto px-4 py-6">
        {/* AI Coach Card */}
        <Card className="mb-6 bg-gradient-to-r from-indigo-500 to-purple-600 text-white border-0">
          <CardContent className="pt-6">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center mb-3">
                  <Sparkles className="h-6 w-6 mr-2" />
                  <h2 className="text-xl font-bold">Your AI Coach</h2>
                </div>
                <p className="text-lg text-white/90 leading-relaxed">
                  {dashboardData?.trust_capital_score > 75
                    ? "Outstanding work! Your generosity is building powerful trust capital. Keep delivering value."
                    : dashboardData?.trust_capital_score > 50
                      ? "You're building trust steadily. Increase free value delivery to accelerate growth."
                      : "Focus on giving more value without asking. Help 5 more people this week with free tools."}
                </p>
              </div>

              {/* Trust Capital Score */}
              <div className="text-center ml-6">
                <div className="text-5xl font-bold mb-1">{dashboardData?.trust_capital_score || 0}</div>
                <div className="text-sm text-white/80">Trust Capital</div>
                <div className="mt-2">
                  <div className="w-24 h-24 rounded-full bg-white/20 flex items-center justify-center">
                    <div className="text-2xl font-bold">{dashboardData?.generosity_score || 0}%</div>
                  </div>
                  <div className="text-xs text-white/70 mt-1">Generosity</div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Tabs value={view} onValueChange={setView}>
          <TabsContent value="overview" className="space-y-6">
            {/* Metric Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <MetricCard
                title="Total Value Delivered"
                value={formatCurrency(dashboardData?.valueMetrics.total_value_delivered || 0)}
                change="+23%"
                trend="up"
                icon={<Gift className="h-5 w-5" />}
                color="purple"
              />

              <MetricCard
                title="People Helped"
                value={dashboardData?.valueMetrics.people_helped || 0}
                subtitle="Unique individuals"
                change="+47"
                trend="up"
                icon={<Users className="h-5 w-5" />}
                color="blue"
              />

              <MetricCard
                title="Monthly GCI"
                value={formatCurrency(dashboardData?.traditionalMetrics.monthly_gci || 0)}
                change="+15%"
                trend="up"
                icon={<DollarSign className="h-5 w-5" />}
                color="green"
              />

              <MetricCard
                title="Reciprocity Rate"
                value={`${dashboardData?.valueMetrics.reciprocity_rate || 0}%`}
                subtitle="Value → Client"
                change="+5%"
                trend="up"
                icon={<Heart className="h-5 w-5" />}
                color="red"
              />
            </div>

            {/* Performance Comparison */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Traditional Metrics */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Target className="h-5 w-5 text-muted-foreground" />
                    Traditional Performance
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <MetricRow label="Monthly GCI" value={formatCurrency(dashboardData?.traditionalMetrics.monthly_gci || 0)} />
                  <MetricRow label="Units Closed" value={dashboardData?.traditionalMetrics.units_closed || 0} />
                  <MetricRow label="Active Leads" value={dashboardData?.traditionalMetrics.active_leads || 0} />
                  <MetricRow label="Conversion Rate" value={`${dashboardData?.traditionalMetrics.conversion_rate || 0}%`} />
                </CardContent>
              </Card>

              {/* Value Metrics */}
              <Card className="bg-gradient-to-br from-purple-50 to-indigo-50 dark:from-purple-950/20 dark:to-indigo-950/20">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Heart className="h-5 w-5 text-purple-600" />
                    Value-First Performance
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <MetricRow
                    label="Value Delivered"
                    value={formatCurrency(dashboardData?.valueMetrics.total_value_delivered || 0)}
                    highlight
                  />
                  <MetricRow label="People Helped" value={dashboardData?.valueMetrics.people_helped || 0} highlight />
                  <MetricRow
                    label="Trust Capital"
                    value={`${dashboardData?.trust_capital_score || 0}/100`}
                    highlight
                  />
                  <MetricRow
                    label="Generosity Score"
                    value={`${dashboardData?.generosity_score || 0}/100`}
                    highlight
                  />
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="value" className="space-y-6">
            {/* Lead Value Journeys Table */}
            <Card>
              <CardHeader>
                <CardTitle>Lead Value Journeys</CardTitle>
                <CardDescription>Track how much value each lead receives before converting</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          Contact
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          Value Received
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          Touchpoints
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          Journey Time
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          Status
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          ROI Multiple
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {leadJourneys.map((journey) => (
                        <tr key={journey.id} className="hover:bg-muted/50">
                          <td className="px-4 py-4">
                            <div className="flex items-center">
                              <div className="w-8 h-8 rounded-full bg-purple-100 dark:bg-purple-950/20 flex items-center justify-center mr-3">
                                <span className="text-sm font-semibold text-purple-700 dark:text-purple-400">
                                  {journey.contacts?.name?.charAt(0) || "?"}
                                </span>
                              </div>
                              <div>
                                <p className="text-sm font-medium">{journey.contacts?.name || "Unknown"}</p>
                                <p className="text-xs text-muted-foreground">{journey.contacts?.email || ""}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-4 text-sm font-semibold text-purple-600 dark:text-purple-400">
                            {formatCurrency(journey.total_value_received || 0)}
                          </td>
                          <td className="px-4 py-4 text-sm">{journey.touchpoints_count || 0} interactions</td>
                          <td className="px-4 py-4 text-sm">{journey.time_to_conversion_days || 0} days</td>
                          <td className="px-4 py-4">
                            <Badge
                              variant={journey.became_client ? "default" : journey.became_referrer ? "secondary" : "outline"}
                            >
                              {journey.became_client ? "Converted" : journey.became_referrer ? "Referrer" : "Nurturing"}
                            </Badge>
                          </td>
                          <td className="px-4 py-4 text-sm font-semibold text-green-600 dark:text-green-400">
                            {journey.roi_multiple ? `${journey.roi_multiple.toFixed(1)}x` : "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {leadJourneys.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground">
                      No lead journeys tracked yet. Start delivering value to see data here.
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="performance" className="space-y-6">
            {/* Key performance metrics grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: "Monthly GCI", value: dashboardData ? `$${((dashboardData.traditionalMetrics?.monthly_gci || 0) / 1000).toFixed(1)}K` : "—", sub: "Gross commission income" },
                { label: "Units Closed", value: dashboardData?.traditionalMetrics?.units_closed ?? "—", sub: "Transactions closed" },
                { label: "Active Leads", value: dashboardData?.traditionalMetrics?.active_leads ?? "—", sub: "In pipeline" },
                { label: "Conversion Rate", value: dashboardData ? `${dashboardData.traditionalMetrics?.conversion_rate ?? 0}%` : "—", sub: "Lead → closed" },
              ].map(({ label, value, sub }) => (
                <Card key={label}>
                  <CardContent className="pt-5 pb-5">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{label}</p>
                    <p className="text-2xl font-bold">{value}</p>
                    <p className="text-xs text-muted-foreground mt-1">{sub}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Value over time bar chart */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Value Delivered Over Time</CardTitle>
                <CardDescription>Daily value delivered to leads and clients during the selected period</CardDescription>
              </CardHeader>
              <CardContent>
                {!dashboardData || (dashboardData.valueOverTime?.length ?? 0) === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
                    <Activity className="h-8 w-8 opacity-40" />
                    <p className="text-sm">No value data recorded for this period yet.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* Bar chart */}
                    <div className="flex items-end gap-1 h-32">
                      {(dashboardData.valueOverTime as { date: string; value: number }[]).map((point, i) => {
                        const max = Math.max(...(dashboardData.valueOverTime as any[]).map((p: any) => p.value), 1)
                        const pct = Math.max((point.value / max) * 100, point.value > 0 ? 4 : 0)
                        return (
                          <div key={i} className="flex flex-col items-center flex-1 gap-0.5 group" title={`${point.date}: $${point.value.toFixed(0)}`}>
                            <div
                              className="w-full bg-primary/80 rounded-t transition-all group-hover:bg-primary"
                              style={{ height: `${pct}%` }}
                            />
                          </div>
                        )
                      })}
                    </div>
                    {/* X-axis labels — show first, middle, last */}
                    {(() => {
                      const pts = dashboardData.valueOverTime as { date: string; value: number }[]
                      return (
                        <div className="flex justify-between text-[10px] text-muted-foreground px-0.5">
                          <span>{pts[0]?.date?.slice(5)}</span>
                          <span>{pts[Math.floor(pts.length / 2)]?.date?.slice(5)}</span>
                          <span>{pts[pts.length - 1]?.date?.slice(5)}</span>
                        </div>
                      )
                    })()}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Trust capital + generosity gauges */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                { label: "Trust Capital Score", value: dashboardData?.trust_capital_score ?? 0, desc: "Relationship strength with your network" },
                { label: "Generosity Score", value: dashboardData?.generosity_score ?? 0, desc: "Value given vs. revenue received" },
              ].map(({ label, value, desc }) => (
                <Card key={label}>
                  <CardContent className="pt-5 pb-5">
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <p className="text-sm font-medium">{label}</p>
                        <p className="text-xs text-muted-foreground">{desc}</p>
                      </div>
                      <span className="text-2xl font-bold">{value}<span className="text-base text-muted-foreground">/100</span></span>
                    </div>
                    <div className="h-2 w-full bg-muted rounded-full">
                      <div
                        className="h-2 bg-primary rounded-full transition-all"
                        style={{ width: `${Math.min(value, 100)}%` }}
                      />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Activity metrics */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Value Activity Breakdown</CardTitle>
                <CardDescription>What actions generated value during this period</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {[
                    { label: "Tools Used", value: dashboardData?.valueMetrics?.free_tools_used ?? 0 },
                    { label: "Guides Shared", value: dashboardData?.valueMetrics?.guides_shared ?? 0 },
                    { label: "People Helped", value: dashboardData?.valueMetrics?.people_helped ?? 0 },
                    { label: "Reciprocity Rate", value: `${dashboardData?.valueMetrics?.reciprocity_rate ?? 0}%`, raw: true },
                  ].map(({ label, value, raw }) => {
                    const maxVal = raw ? 100 : Math.max(
                      dashboardData?.valueMetrics?.free_tools_used ?? 0,
                      dashboardData?.valueMetrics?.guides_shared ?? 0,
                      dashboardData?.valueMetrics?.people_helped ?? 0,
                      1,
                    )
                    const numVal = raw ? parseFloat(String(value)) : Number(value)
                    return (
                      <div key={label} className="flex items-center gap-3">
                        <div className="w-32 shrink-0 text-sm">{label}</div>
                        <div className="flex-1 bg-muted rounded-full h-2">
                          <div
                            className="bg-primary h-2 rounded-full transition-all"
                            style={{ width: `${Math.min((numVal / maxVal) * 100, 100)}%` }}
                          />
                        </div>
                        <span className="text-sm font-medium w-12 text-right">{value}</span>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

interface MetricCardProps {
  title: string
  value: string | number
  subtitle?: string
  change?: string
  trend?: "up" | "down"
  icon: React.ReactNode
  color?: "purple" | "blue" | "green" | "red"
}

function MetricCard({ title, value, subtitle, change, trend, icon, color = "blue" }: MetricCardProps) {
  const colorClasses = {
    purple: "bg-purple-100 text-purple-600 dark:bg-purple-950/20 dark:text-purple-400",
    blue: "bg-blue-100 text-blue-600 dark:bg-blue-950/20 dark:text-blue-400",
    green: "bg-green-100 text-green-600 dark:bg-green-950/20 dark:text-green-400",
    red: "bg-red-100 text-red-600 dark:bg-red-950/20 dark:text-red-400",
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between mb-4">
          <div className={cn("p-2 rounded-lg", colorClasses[color])}>{icon}</div>
          {change && (
            <div className={cn("text-sm font-medium", trend === "up" ? "text-green-600" : "text-red-600")}>
              {change}
            </div>
          )}
        </div>
        <div>
          <p className="text-sm text-muted-foreground mb-1">{title}</p>
          <p className="text-2xl font-bold">{value}</p>
          {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
        </div>
      </CardContent>
    </Card>
  )
}

function MetricRow({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn("text-sm", highlight ? "text-purple-700 dark:text-purple-300" : "text-muted-foreground")}>
        {label}
      </span>
      <span className={cn("text-xl font-bold", highlight && "text-purple-700 dark:text-purple-300")}>{value}</span>
    </div>
  )
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}
