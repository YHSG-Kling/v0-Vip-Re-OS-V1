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
} from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { loadValueDrivenDashboard, getLeadValueJourneys } from "@/app/actions/analytics"
import { cn } from "@/lib/utils"

export default function AnalyticsDashboard() {
  const [view, setView] = useState("overview")
  const [period, setPeriod] = useState("month")
  const [dashboardData, setDashboardData] = useState<any>(null)
  const [leadJourneys, setLeadJourneys] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

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

      // Get agent ID from user
      const { data: agent } = await supabase.from("agents").select("*").eq("user_id", user.id).maybeSingle()
      const agentId = agent?.id || user.id

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

              <Button variant="outline">
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
            </div>
          </div>
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

          <TabsContent value="performance">
            <Card>
              <CardHeader>
                <CardTitle>Performance Trends</CardTitle>
                <CardDescription>Coming soon: Historical performance charts and trends</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-center py-12 text-muted-foreground">
                  <Activity className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>Performance trend charts will be available soon</p>
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
