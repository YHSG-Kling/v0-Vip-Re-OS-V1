"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
} from "recharts"
import {
  DollarSign,
  Users,
  TrendingUp,
  Award,
  ArrowUpRight,
  ArrowDownRight,
  Filter,
  RefreshCw,
  AlertCircle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDistanceToNow } from "date-fns"

interface ROIDashboardClientProps {
  userId: string
  brokerageId: string
  userRole: string
  campaigns: any[]
  summary: {
    total_spend: number
    total_leads: number
    total_conversions: number
    avg_roi_percentage: number | null
    best_channel: string | null
  } | null
  channelPerformance: any[]
  topCampaigns: any[]
  agents: any[]
  accessError?: string
}

export function ROIDashboardClient({
  userId,
  brokerageId,
  userRole,
  campaigns,
  summary,
  channelPerformance,
  topCampaigns,
  agents,
  accessError,
}: ROIDashboardClientProps) {
  const router = useRouter()
  const [refreshing, setRefreshing] = useState(false)
  const [selectedCampaignType, setSelectedCampaignType] = useState<string>("all")
  const [selectedStatus, setSelectedStatus] = useState<string>("all")
  const [selectedAgent, setSelectedAgent] = useState<string>("all")
  const [dateWindow, setDateWindow] = useState<string>("this_month")
  const [sortBy, setSortBy] = useState<string>("roi_percentage")
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc")
  const [activeTab, setActiveTab] = useState<string>("campaigns")

  // Filter and sort campaigns
  const filteredCampaigns = useMemo(() => {
    let result = [...campaigns]

    // Filter by campaign type
    if (selectedCampaignType !== "all") {
      result = result.filter(
        (c) => c.marketing_campaigns?.campaign_type === selectedCampaignType
      )
    }

    // Filter by status
    if (selectedStatus !== "all") {
      result = result.filter(
        (c) => c.marketing_campaigns?.status === selectedStatus
      )
    }

    // Filter by agent
    if (selectedAgent !== "all") {
      result = result.filter(
        (c) => c.marketing_campaigns?.agent_user_id === selectedAgent
      )
    }

    // Sort
    result.sort((a, b) => {
      const aVal = a[sortBy] ?? -Infinity
      const bVal = b[sortBy] ?? -Infinity
      return sortOrder === "desc" ? bVal - aVal : aVal - bVal
    })

    return result
  }, [campaigns, selectedCampaignType, selectedStatus, selectedAgent, sortBy, sortOrder])

  // Channel chart data
  const channelChartData = useMemo(() => {
    return channelPerformance.map((ch) => ({
      name: formatChannelName(ch.channel_type),
      roi: ch.roi_percentage ?? 0,
      spend: ch.spend ?? 0,
      leads: ch.leads ?? 0,
      conversions: ch.conversions ?? 0,
    }))
  }, [channelPerformance])

  // If access error, show upgrade prompt
  if (accessError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 p-8">
        <AlertCircle className="h-12 w-12 text-muted-foreground" />
        <h2 className="text-xl font-semibold">Feature Not Available</h2>
        <p className="text-muted-foreground text-center max-w-md">
          {accessError}
        </p>
        {/* Had no handler. This is the ONLY control on the plan-gated dead end,
            so an agent who hit the gate had no way to act on it. Billing and the
            plan upgrade live at /settings/billing — the same destination the
            admin usage page already sends people to. */}
        <Button variant="outline" asChild>
          <Link href="/settings/billing">Upgrade Plan</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Campaign ROI</h1>
          <p className="mt-1 text-muted-foreground">
            Track and analyze your marketing campaign performance
          </p>
        </div>
        {/* Had no onClick — the ROI numbers went stale and the refresh button
            was decoration. The data comes from the server page's own loader, so
            router.refresh() re-runs it; there is no second fetch path to drift. */}
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true)
            router.refresh()
            // router.refresh() resolves before React has re-rendered with the
            // new payload, so hold the spinner briefly rather than flashing it.
            setTimeout(() => setRefreshing(false), 800)
          }}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing…" : "Refresh Data"}
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Spend</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ${(summary?.total_spend ?? 0).toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground">
              Across all campaigns
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Leads</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {(summary?.total_leads ?? 0).toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground">
              Generated this period
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Conversions</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {(summary?.total_conversions ?? 0).toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground">
              Closed deals attributed
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Avg ROI</CardTitle>
            {(summary?.avg_roi_percentage ?? 0) > 0 ? (
              <ArrowUpRight className="h-4 w-4 text-green-500" />
            ) : (
              <ArrowDownRight className="h-4 w-4 text-red-500" />
            )}
          </CardHeader>
          <CardContent>
            <div
              className={cn(
                "text-2xl font-bold",
                summary?.avg_roi_percentage != null
                  ? (summary.avg_roi_percentage) > 100
                    ? "text-green-600"
                    : (summary.avg_roi_percentage) > 0
                    ? "text-yellow-600"
                    : "text-red-600"
                  : ""
              )}
            >
              {summary?.avg_roi_percentage != null
                ? `${summary.avg_roi_percentage.toFixed(1)}%`
                : "N/A"}
            </div>
            <p className="text-xs text-muted-foreground">
              Average return on investment
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Best Channel</CardTitle>
            <Award className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold capitalize">
              {summary?.best_channel
                ? formatChannelName(summary.best_channel)
                : "N/A"}
            </div>
            <p className="text-xs text-muted-foreground">
              Highest performing channel
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="campaigns">Campaign ROI</TabsTrigger>
          <TabsTrigger value="channels">Channel Comparison</TabsTrigger>
          <TabsTrigger value="leaderboard">Leaderboard</TabsTrigger>
        </TabsList>

        {/* Campaign ROI Tab */}
        <TabsContent value="campaigns" className="space-y-4">
          {/* Filters */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Filter className="h-4 w-4" />
                <CardTitle className="text-base">Filters</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Campaign Type</label>
                  <Select
                    value={selectedCampaignType}
                    onValueChange={setSelectedCampaignType}
                  >
                    <SelectTrigger className="w-[160px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Types</SelectItem>
                      <SelectItem value="social">Social</SelectItem>
                      <SelectItem value="ad">Ad</SelectItem>
                      <SelectItem value="direct_mail">Direct Mail</SelectItem>
                      <SelectItem value="newsletter">Newsletter</SelectItem>
                      <SelectItem value="podcast">Podcast</SelectItem>
                      <SelectItem value="video">Video</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Status</label>
                  <Select
                    value={selectedStatus}
                    onValueChange={setSelectedStatus}
                  >
                    <SelectTrigger className="w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Status</SelectItem>
                      <SelectItem value="live">Live</SelectItem>
                      <SelectItem value="paused">Paused</SelectItem>
                      <SelectItem value="ended">Ended</SelectItem>
                      <SelectItem value="draft">Draft</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {agents.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium">Agent</label>
                    <Select
                      value={selectedAgent}
                      onValueChange={setSelectedAgent}
                    >
                      <SelectTrigger className="w-[180px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Agents</SelectItem>
                        {agents.map((agent) => (
                          <SelectItem key={agent.id} value={agent.id}>
                            {agent.first_name} {agent.last_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Date Window</label>
                  <Select value={dateWindow} onValueChange={setDateWindow}>
                    <SelectTrigger className="w-[160px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="this_month">This Month</SelectItem>
                      <SelectItem value="last_month">Last Month</SelectItem>
                      <SelectItem value="last_90_days">Last 90 Days</SelectItem>
                      <SelectItem value="ytd">Year to Date</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Campaign ROI Table */}
          <Card>
            <CardHeader>
              <CardTitle>Campaign Performance</CardTitle>
              <CardDescription>
                ROI metrics for all your marketing campaigns
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Spend</TableHead>
                    <TableHead className="text-right">Leads</TableHead>
                    <TableHead className="text-right">Conversions</TableHead>
                    <TableHead className="text-right">CPL</TableHead>
                    <TableHead className="text-right">CPC</TableHead>
                    <TableHead className="text-right">ROI %</TableHead>
                    <TableHead className="text-right">Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCampaigns.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-8">
                        <p className="text-muted-foreground">
                          No campaigns found matching filters
                        </p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredCampaigns.map((campaign) => (
                      <TableRow key={campaign.id}>
                        <TableCell className="font-medium">
                          {campaign.marketing_campaigns?.campaign_name ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="capitalize">
                            {formatChannelName(
                              campaign.marketing_campaigns?.campaign_type ?? ""
                            )}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          ${(campaign.total_spend ?? 0).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          {campaign.total_leads ?? 0}
                        </TableCell>
                        <TableCell className="text-right">
                          {campaign.total_conversions ?? 0}
                        </TableCell>
                        <TableCell className="text-right">
                          {campaign.cost_per_lead !== null
                            ? `$${campaign.cost_per_lead.toFixed(2)}`
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {campaign.cost_per_conversion !== null
                            ? `$${campaign.cost_per_conversion.toFixed(2)}`
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <span
                            className={cn(
                              "font-medium",
                              campaign.roi_percentage !== null
                                ? campaign.roi_percentage > 100
                                  ? "text-green-600"
                                  : campaign.roi_percentage > 0
                                  ? "text-yellow-600"
                                  : "text-red-600"
                                : ""
                            )}
                          >
                            {campaign.roi_percentage !== null
                              ? `${campaign.roi_percentage.toFixed(1)}%`
                              : "—"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">
                          {campaign.calculated_at
                            ? formatDistanceToNow(new Date(campaign.calculated_at), {
                                addSuffix: true,
                              })
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Channel Comparison Tab */}
        <TabsContent value="channels" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Channel ROI Comparison</CardTitle>
              <CardDescription>
                Compare ROI performance across marketing channels
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[400px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={channelChartData} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} />
                    <XAxis type="number" unit="%" />
                    <YAxis dataKey="name" type="category" width={100} />
                    <Tooltip
                      formatter={((value: number, name: string) => {
                        if (name === "roi") return [`${value.toFixed(1)}%`, "ROI"]
                        if (name === "spend") return [`$${value.toLocaleString()}`, "Spend"]
                        if (name === "leads") return [`${value}`, "Leads"]
                        if (name === "conversions") return [`${value}`, "Conversions"]
                        return [`${value}`, name]
                      }) as any}
                    />
                    <Legend />
                    <Bar dataKey="roi" name="ROI %" radius={[0, 4, 4, 0]}>
                      {channelChartData.map((entry, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={
                            entry.roi > 100
                              ? "#16a34a"
                              : entry.roi > 0
                              ? "#ca8a04"
                              : "#dc2626"
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Channel Details Table */}
          <Card>
            <CardHeader>
              <CardTitle>Channel Metrics</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Channel</TableHead>
                    <TableHead className="text-right">Spend</TableHead>
                    <TableHead className="text-right">Leads</TableHead>
                    <TableHead className="text-right">Conversions</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">ROI %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {channelPerformance.map((ch) => (
                    <TableRow key={ch.id}>
                      <TableCell className="font-medium capitalize">
                        {formatChannelName(ch.channel_type)}
                      </TableCell>
                      <TableCell className="text-right">
                        ${(ch.spend ?? 0).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">{ch.leads ?? 0}</TableCell>
                      <TableCell className="text-right">
                        {ch.conversions ?? 0}
                      </TableCell>
                      <TableCell className="text-right">
                        ${(ch.revenue ?? 0).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={cn(
                            "font-medium",
                            ch.roi_percentage !== null
                              ? ch.roi_percentage > 100
                                ? "text-green-600"
                                : ch.roi_percentage > 0
                                ? "text-yellow-600"
                                : "text-red-600"
                              : ""
                          )}
                        >
                          {ch.roi_percentage !== null
                            ? `${ch.roi_percentage.toFixed(1)}%`
                            : "—"}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Leaderboard Tab */}
        <TabsContent value="leaderboard" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Top Performing Campaigns</CardTitle>
              <CardDescription>
                Your highest ROI campaigns ranked by performance
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {topCampaigns.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">
                    No campaigns with positive ROI yet
                  </p>
                ) : (
                  topCampaigns.map((campaign, index) => (
                    <div
                      key={campaign.id}
                      className="flex items-center gap-4 p-4 rounded-lg border bg-card"
                    >
                      <div
                        className={cn(
                          "flex h-10 w-10 items-center justify-center rounded-full text-lg font-bold",
                          index === 0
                            ? "bg-yellow-100 text-yellow-700"
                            : index === 1
                            ? "bg-gray-100 text-gray-700"
                            : index === 2
                            ? "bg-orange-100 text-orange-700"
                            : "bg-muted text-muted-foreground"
                        )}
                      >
                        {index + 1}
                      </div>
                      <div className="flex-1">
                        <p className="font-medium">
                          {campaign.marketing_campaigns?.campaign_name ?? "Unknown"}
                        </p>
                        <p className="text-sm text-muted-foreground capitalize">
                          {formatChannelName(
                            campaign.marketing_campaigns?.campaign_type ?? ""
                          )}
                        </p>
                      </div>
                      <div className="text-right">
                        <p
                          className={cn(
                            "text-xl font-bold",
                            campaign.roi_percentage > 100
                              ? "text-green-600"
                              : "text-yellow-600"
                          )}
                        >
                          {campaign.roi_percentage?.toFixed(1)}%
                        </p>
                        <p className="text-sm text-muted-foreground">
                          ${(campaign.total_revenue ?? 0).toLocaleString()} revenue
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {topCampaigns.length > 0 && (
                <div className="mt-4 text-center">
                  {/* Had no handler, and "View Full Dashboard" was a lie — this
                      IS the dashboard. The leaderboard is capped at the top 5
                      campaigns; the unabridged, filterable table is the
                      Campaign ROI tab, so that is where this goes now. */}
                  <Button variant="link" size="sm" onClick={() => setActiveTab("campaigns")}>
                    View all {campaigns.length} campaigns
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

// Helper function to format channel names for display
function formatChannelName(channel: string): string {
  const nameMap: Record<string, string> = {
    social: "Social Media",
    ad: "Paid Ads",
    direct_mail: "Direct Mail",
    newsletter: "Newsletter",
    podcast: "Podcast",
    video: "Video",
  }
  return nameMap[channel] ?? channel
}
