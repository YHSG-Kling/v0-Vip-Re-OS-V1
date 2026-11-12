"use client"

import { useState, useMemo, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ROI_WINDOW_OPTIONS, isRoiWindowKey, resolveRoiWindow, type RoiWindowKey } from "./roi-window"
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
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Filter,
  RefreshCw,
  AlertCircle,
  Download,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDistanceToNow } from "date-fns"
// Wave 152 (lane 152B): the authorized ROI outcome ledger's SHAPE (type-only — erased, no server code reaches the client).
import type { RoiOutcomeLedger } from "@/lib/intelligence/roi-ledger"

/** Cents → "$12,345" for display; null stays "—" (never a silent $0). */
function usdCents(c: number | null | undefined): string {
  return c == null ? "—" : `$${Math.round(c / 100).toLocaleString()}`
}
/** A ratio is a number or a plain-words reason — never Infinity, never a fake 0. */
function RatioValue({ r, as }: { r: { value: number | null; na: string | null }; as: "pct" | "usd" }) {
  if (r.value == null) return <span className="text-muted-foreground" title={r.na ?? undefined}>N/A</span>
  return <span>{as === "pct" ? `${(r.value * 100).toFixed(1)}%` : usdCents(r.value)}</span>
}

// ─── Campaign table sorting ───────────────────────────────────────────────────
//
// `sortBy` / `sortOrder` were READ by the sort below and by the memo's dep array
// but neither setter was ever called, so the table was frozen at
// `roi_percentage desc` and no column header could change it. These are the
// missing half: one column list drives both the headers and the comparator, so a
// header can never offer an ordering the comparator does not implement.
const ROI_COLUMNS: Array<{ key: string; label: string; numeric: boolean }> = [
  { key: "campaign_name",       label: "Campaign",    numeric: false },
  { key: "campaign_type",       label: "Type",        numeric: false },
  { key: "total_spend",         label: "Spend",       numeric: true },
  { key: "total_leads",         label: "Leads",       numeric: true },
  // Wave 152: these are hand-raises (ad conversions, mail calls / forms / appointments) — NOT closed deals; closed
  // deals and earned commission live on the Outcomes tab.
  { key: "total_conversions",   label: "Responses",   numeric: true },
  { key: "cost_per_lead",       label: "CPL",         numeric: true },
  { key: "cost_per_conversion", label: "CPC",         numeric: true },
  { key: "roi_percentage",      label: "ROI %",       numeric: true },
  { key: "calculated_at",       label: "Updated",     numeric: true },
]

/** The value a row sorts by for a column — nested and date fields included. */
function roiSortValue(row: any, key: string): number | string | null {
  switch (key) {
    case "campaign_name":
      return row.marketing_campaigns?.campaign_name ?? ""
    case "campaign_type":
      return row.marketing_campaigns?.campaign_type ?? ""
    case "calculated_at":
      return row.calculated_at ? new Date(row.calculated_at).getTime() : null
    default: {
      const v = row[key]
      return typeof v === "number" ? v : v == null ? null : Number(v)
    }
  }
}

function compareRoiRows(a: any, b: any, key: string, order: "asc" | "desc"): number {
  const av = roiSortValue(a, key)
  const bv = roiSortValue(b, key)

  if (typeof av === "string" || typeof bv === "string") {
    const cmp = String(av ?? "").localeCompare(String(bv ?? ""))
    return order === "desc" ? -cmp : cmp
  }

  // MISSING NUMBERS SORT LAST IN BOTH DIRECTIONS. The old comparator coerced
  // null to -Infinity, which read as "the worst campaign" descending and "the
  // best" ascending — a campaign with no CPL yet is not the cheapest lead in the
  // brokerage. Descending (the only order previously reachable) is unchanged:
  // absent values stayed at the bottom then and stay there now.
  const an = av as number | null
  const bn = bv as number | null
  if (an == null || Number.isNaN(an)) return bn == null || Number.isNaN(bn) ? 0 : 1
  if (bn == null || Number.isNaN(bn)) return -1
  return order === "desc" ? bn - an : an - bn
}

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
  /** The window the server page fetched the channel comparison for (from ?window=). */
  window: RoiWindowKey
  accessError?: string
  /** Wave 152 (152B): THE authorized ROI outcome ledger for this viewer and window (null when it could not be read). */
  outcomes?: RoiOutcomeLedger | null
  /** The plain-words reason the outcomes could not be read (nothing partial is shown in its place). */
  outcomesError?: string | null
  /** The CSV built on the server from the SAME ledger object — the export cannot disagree with this page. */
  outcomesCsv?: string | null
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
  window: windowKey,
  accessError,
  outcomes = null,
  outcomesError = null,
  outcomesCsv = null,
}: ROIDashboardClientProps) {
  const router = useRouter()
  const [refreshing, setRefreshing] = useState(false)
  const [selectedCampaignType, setSelectedCampaignType] = useState<string>("all")
  const [selectedStatus, setSelectedStatus] = useState<string>("all")
  const [selectedAgent, setSelectedAgent] = useState<string>("all")
  // Wave 142 (lane 142H): `dateWindow` was set by the select and read by NOTHING. The window lives in the
  // URL so the server page re-fetches the channel comparison for it (useTransition keeps the select
  // responsive while the page re-renders — vercel-react-best-practices rendering-usetransition-loading).
  const [dateWindow, setDateWindow] = useState<RoiWindowKey>(windowKey)
  const [windowPending, startWindowChange] = useTransition()
  const windowLabel = resolveRoiWindow(dateWindow).label
  const changeWindow = (v: string) => {
    if (!isRoiWindowKey(v)) return
    setDateWindow(v)
    startWindowChange(() => router.replace(`?window=${v}`))
  }
  const [sortBy, setSortBy] = useState<string>("roi_percentage")
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc")
  const [activeTab, setActiveTab] = useState<string>("outcomes")

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
    result.sort((a, b) => compareRoiRows(a, b, sortBy, sortOrder))

    return result
  }, [campaigns, selectedCampaignType, selectedStatus, selectedAgent, sortBy, sortOrder])

  // Click a header: same column flips direction, a new column starts at desc
  // (highest first, which is what every metric in this table is read for).
  const toggleSort = (key: string) => {
    if (sortBy === key) {
      setSortOrder((o) => (o === "desc" ? "asc" : "desc"))
    } else {
      setSortBy(key)
      setSortOrder("desc")
    }
  }

  // Channel chart data
  const channelChartData = useMemo(() => {
    return channelPerformance.map((ch) => ({
      name: formatChannelName(ch.channel_type),
      // Wave 152: an N/A return stays null (no bar) — charting it as 0% drew a number the data does not have.
      roi: ch.roi_percentage ?? null,
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

      {/* Summary Cards — wave 152 (152B): from the authorized outcome ledger (this viewer's scope, this window).
          The old cards summed the brokerage-wide cache (an unknown spend added as $0), averaged ROI percentages
          across campaigns, and labelled ad/mail hand-raises "Closed deals attributed". */}
      {outcomesError ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{outcomesError}</span>
        </div>
      ) : null}
      {outcomes ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Recorded Spend</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{outcomes.costs.status === "unknown" ? "Unknown" : usdCents(outcomes.costs.knownCents)}</div>
              <p className="text-xs text-muted-foreground">
                {outcomes.costs.byStatus.unknown > 0
                  ? `${outcomes.costs.byStatus.unknown} campaign(s) have no recorded cost (unknown, not $0)`
                  : `Spend is ${outcomes.costs.status} for ${windowLabel.toLowerCase()}`}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Contacts Reached</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{outcomes.acquisition.contactsReached.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground">{outcomes.engagement.appointments} appointment(s) booked by them</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Closed Deals</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{outcomes.results.sourcedDealsClosed}</div>
              <p className="text-xs text-muted-foreground">
                sourced by a campaign · {outcomes.results.influencedDealsClosed} touched by one
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Realized Return</CardTitle>
              {(outcomes.ratios.realizedReturnOnMarketingSpend.value ?? 0) > 0 ? (
                <ArrowUpRight className="h-4 w-4 text-green-600" />
              ) : (
                <ArrowDownRight className="h-4 w-4 text-muted-foreground" />
              )}
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                <RatioValue r={outcomes.ratios.realizedReturnOnMarketingSpend} as="pct" />
              </div>
              <p className="text-xs text-muted-foreground">
                {outcomes.ratios.realizedReturnOnMarketingSpend.na ?? "Earned commission back on recorded spend"}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Earned Commission</CardTitle>
              <Award className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{outcomes.revenue ? usdCents(outcomes.attribution?.sourcedEarnedCents ?? null) : "Hidden"}</div>
              <p className="text-xs text-muted-foreground">
                {outcomes.revenue ? "sourced by campaigns, closed deals only" : (outcomes.scope.moneyNote ?? "")}
              </p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="outcomes">Outcomes</TabsTrigger>
          <TabsTrigger value="campaigns">Campaign ROI</TabsTrigger>
          <TabsTrigger value="channels">Channel Comparison</TabsTrigger>
          <TabsTrigger value="leaderboard">Leaderboard</TabsTrigger>
        </TabsList>

        {/* Outcomes Tab — wave 152 (152B): the authorized ROI outcome ledger, every number with its reason */}
        <TabsContent value="outcomes" className="space-y-4">
          {outcomes ? (
            <OutcomesPanel ledger={outcomes} csv={outcomesCsv} windowLabel={windowLabel} />
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {outcomesError ?? "Outcomes are not available for this view."}
              </CardContent>
            </Card>
          )}
        </TabsContent>

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
                  <Select value={dateWindow} onValueChange={changeWindow} disabled={windowPending}>
                    <SelectTrigger className="w-[160px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROI_WINDOW_OPTIONS.map((o) => (
                        <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* campaign_roi rows are lifetime totals per campaign (no period columns) — the window
                      applies where the data is windowed, and says so rather than pretending. */}
                  <p className="text-[11px] text-muted-foreground max-w-[220px]">
                    Applies to the Channel Comparison tab. Campaign rows are lifetime totals.
                  </p>
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
                    {ROI_COLUMNS.map((col) => {
                      const active = sortBy === col.key
                      const Arrow = !active ? ArrowUpDown : sortOrder === "desc" ? ArrowDown : ArrowUp
                      return (
                        <TableHead
                          key={col.key}
                          className={col.numeric ? "text-right" : undefined}
                          aria-sort={
                            active ? (sortOrder === "desc" ? "descending" : "ascending") : "none"
                          }
                        >
                          <button
                            type="button"
                            onClick={() => toggleSort(col.key)}
                            title={
                              active && sortOrder === "desc"
                                ? `Sort by ${col.label} ascending`
                                : `Sort by ${col.label} descending`
                            }
                            className={cn(
                              "inline-flex items-center gap-1 transition-colors hover:text-foreground",
                              col.numeric && "flex-row-reverse",
                              active ? "font-semibold text-foreground" : "text-muted-foreground",
                            )}
                          >
                            {col.label}
                            <Arrow
                              className={cn("h-3.5 w-3.5", active ? "opacity-100" : "opacity-40")}
                            />
                          </button>
                        </TableHead>
                      )
                    })}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCampaigns.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={ROI_COLUMNS.length} className="text-center py-8">
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
                          {campaign.total_spend == null ? (
                            <span className="text-muted-foreground" title="Nothing records what this campaign cost — unknown, not $0.">Unknown</span>
                          ) : (
                            `$${Number(campaign.total_spend).toLocaleString()}`
                          )}
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
                                  ? "text-green-700"
                                  : campaign.roi_percentage > 0
                                  ? "text-yellow-700"
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
                Compare ROI performance across marketing channels · {windowLabel}
                {windowPending ? " (updating…)" : ""}
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
                      formatter={((value: number | null, name: string) => {
                        if (value == null) return ["N/A — spend or earned commission not established", name]
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
                            entry.roi == null
                              ? "#9ca3af"
                              : entry.roi > 100
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
                        {ch.spend == null ? <span className="text-muted-foreground">Unknown</span> : `$${Number(ch.spend).toLocaleString()}`}
                      </TableCell>
                      <TableCell className="text-right">{ch.leads ?? 0}</TableCell>
                      <TableCell className="text-right">
                        {ch.conversions ?? 0}
                      </TableCell>
                      <TableCell className="text-right">
                        {ch.revenue == null ? "—" : `$${Number(ch.revenue).toLocaleString()}`}
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={cn(
                            "font-medium",
                            ch.roi_percentage !== null
                              ? ch.roi_percentage > 100
                                ? "text-green-700"
                                : ch.roi_percentage > 0
                                ? "text-yellow-700"
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
                              ? "text-green-700"
                              : "text-yellow-700"
                          )}
                        >
                          {campaign.roi_percentage?.toFixed(1)}%
                        </p>
                        {campaign.total_revenue != null ? (
                          <p className="text-sm text-muted-foreground">
                            ${Number(campaign.total_revenue).toLocaleString()} earned commission
                          </p>
                        ) : null}
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

// ─── Outcomes (wave 152, lane 152B) ─────────────────────────────────────────────
// Renders THE authorized ROI outcome ledger exactly as the server built it: the metric families side by side and
// never mixed, every N/A with its reason, a "why this number?" per campaign, Contact → deal journeys with their
// evidence rows, provider economics, and recommendations that change nothing until a person acts. The CSV is the
// server's serialization of the same object, so the download cannot disagree with what is on screen.
function OutcomesPanel({ ledger, csv, windowLabel }: { ledger: RoiOutcomeLedger; csv: string | null; windowLabel: string }) {
  const download = () => {
    if (!csv) return
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `marketing-outcomes-${ledger.window.sinceDay}-to-${ledger.window.untilDay}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }
  const rev = ledger.revenue
  const stat = (label: string, value: string | number, note?: string) => (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  )
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>What your marketing produced · {windowLabel}</CardTitle>
            <CardDescription>
              Completeness: <Badge variant="outline" className="capitalize">{ledger.completeness.label}</Badge>{" "}
              · attribution model: {ledger.model.replace("_", " ")} · view: {ledger.scope.kind}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={download} disabled={!csv}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {ledger.scope.moneyNote ? <p className="text-sm text-muted-foreground">{ledger.scope.moneyNote}</p> : null}
          {ledger.completeness.notes.length ? (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {ledger.completeness.notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Activity → acquisition → engagement → results</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            {stat("Touches sent", ledger.activity.touchpointsSent)}
            {stat("QR scans", ledger.activity.qrScans, `${ledger.activity.qrFirstScans} first-time scans`)}
            {stat("Mail responses", ledger.activity.mailResponses, "distinct people")}
            {stat("Contacts reached", ledger.acquisition.contactsReached)}
            {stat("Appointments", ledger.engagement.appointments)}
            {stat("Under contract", ledger.results.dealsContracted)}
            {stat("Closed", ledger.results.dealsClosed, `${ledger.results.sourcedDealsClosed} sourced by a campaign`)}
            {stat("Fell through", ledger.results.dealsReversed, "no revenue counted")}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Money · costs · ratios</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            {rev ? (
              <>
                {stat("Projected (estimate)", usdCents(rev.projectedCents), "open deals, no contract")}
                {stat("Contracted (estimate)", usdCents(rev.contractedCents), "under contract, not closed")}
                {stat("Earned", usdCents(rev.earnedCents), rev.closedNotEstablished ? `${rev.closedNotEstablished} closed deal(s) await a finalized commission` : "closed deals")}
                {stat("Received", usdCents(rev.receivedCents))}
                {stat("Paid out to agents", usdCents(rev.disbursedCents))}
                {stat("Net to the business", usdCents(rev.netBrokerageCents))}
              </>
            ) : (
              <p className="col-span-2 text-sm text-muted-foreground">{ledger.scope.moneyNote}</p>
            )}
            {stat("Recorded spend", ledger.costs.status === "unknown" ? "Unknown" : usdCents(ledger.costs.knownCents), `${ledger.costs.status}; ${ledger.costs.eligibleCampaigns} campaign(s) fully recorded`)}
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">Realized return</p>
              <p className="text-lg font-semibold"><RatioValue r={ledger.ratios.realizedReturnOnMarketingSpend} as="pct" /></p>
              <p className="text-[11px] text-muted-foreground">{ledger.ratios.realizedReturnOnMarketingSpend.na ?? ledger.why.realizedReturnOnMarketingSpend}</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">Cost per contact · appointment · closed deal</p>
              <p className="text-sm font-semibold">
                <RatioValue r={ledger.ratios.costPerContact} as="usd" /> · <RatioValue r={ledger.ratios.costPerAppointment} as="usd" /> · <RatioValue r={ledger.ratios.costPerClosedTransaction} as="usd" />
              </p>
            </div>
            {ledger.attribution ? (
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Sourced vs. influenced</p>
                <p className="text-sm font-semibold">{usdCents(ledger.attribution.sourcedEarnedCents)} on {ledger.attribution.sourcedDeals} deal(s)</p>
                <p className="text-[11px] text-muted-foreground">
                  {ledger.attribution.influencedDeals} deal(s) touched (not additive) · {ledger.attribution.reconciled ? "every deal reconciles exactly" : "a deal's split is held for review"}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Campaigns, asset by asset</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Contacts</TableHead>
                <TableHead className="text-right">Appointments</TableHead>
                <TableHead className="text-right">Sourced closings</TableHead>
                <TableHead className="text-right">Earned (sourced)</TableHead>
                <TableHead className="text-right">Return</TableHead>
                <TableHead className="text-right">Cost / contact</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledger.campaigns.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="py-6 text-center text-muted-foreground">No campaigns in your view yet.</TableCell></TableRow>
              ) : ledger.campaigns.map((c) => (
                <TableRow key={c.campaignId}>
                  <TableCell>
                    <details>
                      <summary className="cursor-pointer font-medium">{c.name} <span className="text-xs text-muted-foreground">({formatChannelName(c.type)})</span></summary>
                      <ul className="mt-1 list-disc pl-5 text-[11px] text-muted-foreground">
                        {c.why.map((w) => <li key={w}>{w}</li>)}
                      </ul>
                    </details>
                  </TableCell>
                  <TableCell className="text-right" title={c.cost.note}>{c.cost.status === "unknown" ? "Unknown" : usdCents(c.cost.cents)}<div className="text-[10px] text-muted-foreground">{c.cost.status.replace("_", " ")}</div></TableCell>
                  <TableCell className="text-right">{c.acquisition.contactsReached}</TableCell>
                  <TableCell className="text-right">{c.engagement.appointments}</TableCell>
                  <TableCell className="text-right">{c.results.sourcedDealsClosed}<div className="text-[10px] text-muted-foreground">{c.results.influencedDealsClosed} touched</div></TableCell>
                  <TableCell className="text-right">{c.revenue ? usdCents(c.revenue.sourcedEarnedCents) : "Hidden"}</TableCell>
                  <TableCell className="text-right"><RatioValue r={c.ratios.realizedReturnOnMarketingSpend} as="pct" /></TableCell>
                  <TableCell className="text-right"><RatioValue r={c.ratios.costPerContact} as="usd" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {ledger.placements?.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">QR code placements</CardTitle>
            <CardDescription>{ledger.why.placements}</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Placement</TableHead>
                  <TableHead className="text-right">Codes</TableHead>
                  <TableHead className="text-right">Likely people</TableHead>
                  <TableHead className="text-right">Automated / repeat</TableHead>
                  <TableHead className="text-right">Contacts captured</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Cost / contact captured</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledger.placements.map((p) => (
                  <TableRow key={p.placement}>
                    <TableCell className="capitalize">{p.placement.replace(/_/g, " ")}<div className="text-[10px] text-muted-foreground">{p.campaigns} campaign(s)</div></TableCell>
                    <TableCell className="text-right">{p.codes}</TableCell>
                    <TableCell className="text-right">{p.humanLikelyScans}{p.unclassifiedScans ? <div className="text-[10px] text-muted-foreground">+{p.unclassifiedScans} not classified</div> : null}</TableCell>
                    <TableCell className="text-right">{p.automatedOrRepeatScans}</TableCell>
                    <TableCell className="text-right">{p.contactsCaptured}</TableCell>
                    <TableCell className="text-right" title={p.cost.note}>{p.cost.status === "attributable" ? usdCents(p.cost.cents) : p.cost.status === "shared" ? "Shared" : "Unknown"}</TableCell>
                    <TableCell className="text-right"><RatioValue r={p.costPerContactCaptured} as="usd" /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {ledger.journeys.length ? (
        <Card>
          <CardHeader><CardTitle className="text-base">Contact → deal journeys</CardTitle><CardDescription>Each step names the record it came from.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            {ledger.journeys.map((j) => (
              <details key={j.transactionId} className="rounded-md border p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  <Link href={`/dashboard/transactions/${j.transactionId}`} className="underline">{j.dealName ?? "Deal"}</Link>{" "}
                  <Badge variant="outline" className="ml-1 capitalize">{j.revenueStatus.replace("_", " ")}</Badge>
                  {j.earnedCents != null ? <span className="ml-2 text-muted-foreground">{usdCents(j.earnedCents)}</span> : null}
                </summary>
                <ol className="mt-2 space-y-1 text-xs">
                  {j.steps.map((s) => (
                    <li key={s.ref + s.kind} className="flex gap-2">
                      <span className="w-24 shrink-0 text-muted-foreground">{s.at ? String(s.at).slice(0, 10) : "—"}</span>
                      <span>{s.label}</span>
                      <span className="text-muted-foreground">({s.ref})</span>
                    </li>
                  ))}
                </ol>
              </details>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Provider economics</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {ledger.providerEconomics.shownAtAccountLevel ? (
              <>
                <p>Data providers covered by the platform: {usdCents(ledger.providerEconomics.vendorPlatformCoveredCents)} · paid on your own provider account: {usdCents(ledger.providerEconomics.vendorTenantPaidCents)} · calls without a known price: {ledger.providerEconomics.vendorUnpricedCalls}</p>
                <p>AI usage covered by the platform: {usdCents(ledger.providerEconomics.aiPlatformFundedCents)} · outside platform coverage: {usdCents(ledger.providerEconomics.aiTenantCents)}</p>
                <p>Records acquired: {ledger.providerEconomics.rawRecords} · promoted to leads: {ledger.providerEconomics.rawPromoted} · cost per promoted record: <RatioValue r={ledger.providerEconomics.costPerPromotedRecord} as="usd" /></p>
              </>
            ) : (
              <p className="text-muted-foreground">Provider costs are shown on the account-wide view.</p>
            )}
            {ledger.providerEconomics.notMeasured.map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Recommended for your review</CardTitle><CardDescription>Nothing changes until someone on your team decides.</CardDescription></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {ledger.recommendations.length === 0 ? (
              <p className="text-muted-foreground">No recommendation yet — a comparison needs at least three similar campaigns with recorded costs.</p>
            ) : ledger.recommendations.map((r, i) => (
              <div key={`${r.kind}-${r.campaignId ?? i}`} className="rounded-md border p-2">
                <p>{r.text}</p>
                <p className="text-[11px] text-muted-foreground">
                  {r.comparableSample ? `Compared with ${r.comparableSample} similar campaign(s). ` : ""}Evidence: {r.evidence.slice(0, 3).join(", ") || "—"}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
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
