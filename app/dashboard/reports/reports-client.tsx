"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  BarChart3,
  Download,
  FileText,
  Mail,
  TrendingUp,
  AlertCircle,
  CheckCircle2,
  Clock,
  Eye,
  Star,
  Activity,
  Send,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  exportReportCsvAction,
  exportReportPdfAction,
  emailReportAction,
  loadReportingWorkspaceAction,
  generateSourcePerformanceReportAction,
  generateCampaignROIReportAction,
  generateReputationReportAction,
  generateTransactionPipelineReportAction,
  generateTeamPerformanceReportAction,
  generateAgentPerformanceReportAction,
} from "@/app/actions/reporting-kernel"

type ReportPeriod = "month" | "quarter" | "ytd"

/** First day of the selected window, as YYYY-MM-DD. */
function periodStart(p: ReportPeriod): string {
  const now = new Date()
  if (p === "month") return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
  if (p === "quarter") {
    const q = Math.floor(now.getMonth() / 3) * 3
    return new Date(now.getFullYear(), q, 1).toISOString().slice(0, 10)
  }
  return `${now.getFullYear()}-01-01`
}

interface ReportsClientProps {
  agentId: string
  brokerageId: string
  role: string
  userId: string
  monthStart: string
  initialCampaignData: any
  initialReputationData: any
  initialSourceData: any
}

export function ReportsClient({
  agentId,
  brokerageId,
  role,
  userId,
  monthStart,
  initialCampaignData,
  initialReputationData,
  initialSourceData,
}: ReportsClientProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // ── PERIOD ─────────────────────────────────────────────────────────────────
  // The page prefetches source / campaign / reputation for YTD. Changing the
  // period re-queries them through the reporting-kernel action wrappers, which
  // resolve the actor context server-side (agents.id RESOLVED, never the users
  // id substituted) — the client never states who it is.
  const [dateFrom, setDateFrom] = useState<string>(() => periodStart("ytd"))
  const [period, setPeriod] = useState<ReportPeriod>("ytd")
  const [periodError, setPeriodError] = useState<string | null>(null)

  const [campaignData, setCampaignData]     = useState<any>(initialCampaignData)
  const [reputationData, setReputationData] = useState<any>(initialReputationData)
  const [sourceData, setSourceData]         = useState<any>(initialSourceData)

  // Pipeline / Team / Scorecard load on demand — they are NOT prefetched.
  const [pipelineData, setPipelineData]   = useState<any>(null)
  const [pipelineError, setPipelineError] = useState<string | null>(null)
  const [teamData, setTeamData]           = useState<any>(null)
  const [teamError, setTeamError]         = useState<string | null>(null)
  const [workspace, setWorkspace]         = useState<any>(null)
  const [scorecard, setScorecard]         = useState<any>(null)
  const [scorecardError, setScorecardError] = useState<string | null>(null)

  function applyPeriod(next: ReportPeriod) {
    setPeriod(next)
    setPeriodError(null)
    const from = periodStart(next)
    setDateFrom(from)
    startTransition(async () => {
      const [src, camp, rep] = await Promise.all([
        generateSourcePerformanceReportAction({ dateFrom: from }),
        generateCampaignROIReportAction({ dateFrom: from }),
        generateReputationReportAction({}),
      ])
      // Every outcome READ. A refused report is named, not rendered as an empty
      // (and therefore reassuring) period.
      const refusals = [
        !src.success  ? `sources: ${src.error ?? "failed"}`     : null,
        !camp.success ? `campaigns: ${camp.error ?? "failed"}`  : null,
        !rep.success  ? `reputation: ${rep.error ?? "failed"}`  : null,
      ].filter(Boolean) as string[]
      if (src.success)  setSourceData(src.data ?? null)
      if (camp.success) setCampaignData(camp.data ?? null)
      if (rep.success)  setReputationData(rep.data ?? null)
      setPeriodError(refusals.length ? refusals.join(" · ") : null)
    })
  }

  function loadPipeline() {
    setPipelineError(null)
    startTransition(async () => {
      const res = await generateTransactionPipelineReportAction({})
      if (!res.success) { setPipelineError(res.error ?? "Pipeline report failed"); return }
      setPipelineData(res.data ?? null)
    })
  }

  function loadTeam() {
    setTeamError(null)
    startTransition(async () => {
      const res = await generateTeamPerformanceReportAction()
      if (!res.success) { setTeamError(res.error ?? "Team report failed"); return }
      setTeamData(res.data ?? null)
    })
  }

  function loadScorecard() {
    setScorecardError(null)
    startTransition(async () => {
      const [ws, perf] = await Promise.all([
        loadReportingWorkspaceAction({ dateFrom }),
        generateAgentPerformanceReportAction({
          periodStart: dateFrom,
          periodEnd:   new Date().toISOString().slice(0, 10),
        }),
      ])
      if (ws.success) setWorkspace(ws.data ?? null)
      if (perf.success) setScorecard(perf.data ?? null)
      const refusals = [
        !ws.success   ? (ws.error ?? "workspace failed")   : null,
        !perf.success ? (perf.error ?? "scorecard failed") : null,
      ].filter(Boolean) as string[]
      setScorecardError(refusals.length ? refusals.join(" · ") : null)
    })
  }

  // Summary is a PERFORMANCE snapshot built from the analytics already loaded —
  // commission is intentionally NOT shown here (it lives in Financials →
  // Commission Tracker; duplicating it made Reports read as a commission rehash).
  const sources   = sourceData?.sources ?? []
  const campaigns = campaignData?.campaigns ?? []
  const totalLeads    = sources.reduce((s: number, x: any) => s + (x.contact_count ?? 0), 0)
  const avgCloseRate  = sources.length
    ? sources.reduce((s: number, x: any) => s + (x.close_rate ?? 0), 0) / sources.length
    : 0
  const avgRoi = campaigns.length
    ? campaigns.reduce((s: number, x: any) => s + (x.roi_percentage ?? x.roi ?? 0), 0) / campaigns.length
    : 0
  const avgRating   = reputationData?.avgRating ?? null
  const totalReviews = reputationData?.totalReviews ?? 0
  const topSource = [...sources].sort(
    (a: any, b: any) => (b.revenue ?? b.totalRevenue ?? 0) - (a.revenue ?? a.totalRevenue ?? 0),
  )[0] ?? null
  const topCampaign = [...campaigns].sort(
    (a: any, b: any) => (b.roi_percentage ?? b.roi ?? 0) - (a.roi_percentage ?? a.roi ?? 0),
  )[0] ?? null
  const hasSummaryData = sources.length > 0 || campaigns.length > 0 || !!reputationData

  // Email dialog state
  const [emailDialogOpen, setEmailDialogOpen] = useState(false)
  const [emailRecipients, setEmailRecipients] = useState("")
  const [emailSubject, setEmailSubject] = useState(`Reports - ${new Date().toLocaleDateString()}`)
  const [emailMessage, setEmailMessage] = useState("")
  const [emailReportType, setEmailReportType] = useState("summary")
  const [emailError, setEmailError] = useState("")
  const [emailSuccess, setEmailSuccess] = useState(false)

  const handleExport = (format: "csv" | "pdf", reportType: string) => {
    startTransition(async () => {
      try {
        if (format === "csv") {
          const result = await exportReportCsvAction({
            reportType,
            agentId,
            brokerageId,
            dateFrom,
          })
          if (!result.success || !result.data) throw new Error(result.error ?? "Export failed")
          const blob = new Blob([result.data], { type: "text/csv" })
          const url = window.URL.createObjectURL(blob)
          const a = document.createElement("a")
          a.href = url
          a.download = `report-${reportType}-${new Date().toISOString().split("T")[0]}.csv`
          document.body.appendChild(a)
          a.click()
          window.URL.revokeObjectURL(url)
          document.body.removeChild(a)
        } else {
          const result = await exportReportPdfAction({
            reportType,
            agentId,
            brokerageId,
            dateFrom,
          })
          if (!result.success || !result.pdfUrl) throw new Error(result.error ?? "Export failed")
          const a = document.createElement("a")
          a.href = result.pdfUrl
          a.target = "_blank"
          a.download = `report-${reportType}-${new Date().toISOString().split("T")[0]}.html`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
        }
      } catch (error: any) {
        // Error is surfaced to user via disabled button state — no toast needed for export
      }
    })
  }

  const handleEmailReport = () => {
    if (!emailRecipients.trim() || !emailSubject.trim()) {
      setEmailError("Recipients and subject are required.")
      return
    }
    setEmailError("")
    setEmailSuccess(false)
    startTransition(async () => {
      try {
        const result = await emailReportAction({
          reportType:  emailReportType,
          recipients:  emailRecipients.split(",").map((e) => e.trim()).filter(Boolean),
          subject:     emailSubject,
          message:     emailMessage || undefined,
          agentId,
          brokerageId,
          dateFrom,
        })
        if (!result.success) {
          setEmailError(result.error ?? "Failed to send report.")
          return
        }
        setEmailSuccess(true)
        setEmailRecipients("")
        setEmailSubject(`Reports - ${new Date().toLocaleDateString()}`)
        setEmailMessage("")
        setTimeout(() => {
          setEmailDialogOpen(false)
          setEmailSuccess(false)
        }, 2000)
      } catch (error) {
        setEmailError("An error occurred while sending the report.")
      }
    })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
          <p className="text-muted-foreground">Comprehensive analytics and performance insights</p>
        </div>
        <div className="flex items-center gap-2">
          {/* PERIOD — re-queries source / campaign / reputation through the
              reporting kernel, and the exports below follow the same window. */}
          <Select value={period} onValueChange={(v) => applyPeriod(v as ReportPeriod)}>
            <SelectTrigger className="w-[150px] h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="month">This month</SelectItem>
              <SelectItem value="quarter">This quarter</SelectItem>
              <SelectItem value="ytd">Year to date</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEmailDialogOpen(true)}
            className="bg-transparent"
          >
            <Mail className="h-4 w-4 mr-2" />
            Email Report
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleExport("csv", "summary")}
            disabled={isPending}
            className="bg-transparent"
          >
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleExport("pdf", "summary")}
            disabled={isPending}
            className="bg-transparent"
          >
            <FileText className="h-4 w-4 mr-2" />
            Export PDF
          </Button>
        </div>
      </div>

      {/* Main Tabs */}
      <Tabs defaultValue="summary" className="space-y-4">
        <TabsList>
          <TabsTrigger value="summary" className="flex items-center gap-1.5">
            <BarChart3 className="h-4 w-4" />
            Summary
          </TabsTrigger>
          <TabsTrigger value="source" className="flex items-center gap-1.5">
            <TrendingUp className="h-4 w-4" />
            Sources
          </TabsTrigger>
          <TabsTrigger value="campaigns" className="flex items-center gap-1.5">
            <Activity className="h-4 w-4" />
            Campaigns
          </TabsTrigger>
          <TabsTrigger value="reputation" className="flex items-center gap-1.5">
            <Star className="h-4 w-4" />
            Reputation
          </TabsTrigger>
          <TabsTrigger value="pipeline" className="flex items-center gap-1.5">
            <Clock className="h-4 w-4" />
            Pipeline
          </TabsTrigger>
          <TabsTrigger value="team" className="flex items-center gap-1.5">
            <Send className="h-4 w-4" />
            Team
          </TabsTrigger>
        </TabsList>

        {periodError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            Some reports could not be refreshed for this period — {periodError}. The figures below are
            from the last window that loaded, not this one.
          </div>
        )}

        {/* Summary Tab — performance snapshot (NOT commission; that's in Financials) */}
        <TabsContent value="summary" className="space-y-4">
          {/* MY SCORECARD — the reporting workspace + the persisted agent
              performance report for the selected window. Loaded on demand: the
              performance report WRITES a row, so it must be an explicit act, not
              a side effect of opening the page. */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">My Scorecard</CardTitle>
                  <CardDescription>
                    Activity and outcomes since {new Date(dateFrom).toLocaleDateString()}
                  </CardDescription>
                </div>
                <Button size="sm" variant="outline" onClick={loadScorecard} disabled={isPending} className="bg-transparent">
                  {scorecard || workspace ? "Refresh" : "Load scorecard"}
                </Button>
              </div>
            </CardHeader>
            {(scorecard || workspace || scorecardError) && (
              <CardContent className="space-y-3">
                {scorecardError && <p className="text-sm text-destructive">{scorecardError}</p>}
                {workspace && (
                  <div className="grid gap-3 grid-cols-2 md:grid-cols-4 text-center">
                    <div>
                      <div className="text-xl font-bold">{workspace.agentStats?.ytdTransactions ?? 0}</div>
                      <div className="text-xs text-muted-foreground">transactions</div>
                    </div>
                    <div>
                      <div className="text-xl font-bold">{workspace.agentStats?.activeListings ?? 0}</div>
                      <div className="text-xs text-muted-foreground">active listings</div>
                    </div>
                    <div>
                      <div className="text-xl font-bold">{workspace.agentStats?.pendingPipeline ?? 0}</div>
                      <div className="text-xs text-muted-foreground">in pipeline</div>
                    </div>
                    <div>
                      <div className="text-xl font-bold">{workspace.agentStats?.newContactsLast30 ?? 0}</div>
                      <div className="text-xs text-muted-foreground">new contacts (30d)</div>
                    </div>
                  </div>
                )}
                {scorecard?.metrics && (
                  <div className="grid gap-3 grid-cols-2 md:grid-cols-4 text-center border-t pt-3">
                    <div>
                      <div className="text-xl font-bold">{scorecard.metrics.closedDeals ?? 0}</div>
                      <div className="text-xs text-muted-foreground">closed this period</div>
                    </div>
                    <div>
                      <div className="text-xl font-bold">{Math.round(scorecard.metrics.conversionRate ?? 0)}%</div>
                      <div className="text-xs text-muted-foreground">conversion rate</div>
                    </div>
                    <div>
                      <div className="text-xl font-bold">{scorecard.metrics.newContacts ?? 0}</div>
                      <div className="text-xs text-muted-foreground">contacts added</div>
                    </div>
                    <div>
                      <div className="text-xl font-bold">
                        {scorecard.metrics.avgRating ? scorecard.metrics.avgRating.toFixed(1) : "—"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        avg rating · {scorecard.metrics.totalReviews ?? 0} reviews
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            )}
          </Card>

          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                  <TrendingUp className="h-4 w-4" /> Total Leads
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{totalLeads.toLocaleString("en-US")}</div>
                <p className="text-xs text-muted-foreground mt-1">across {sources.length} source{sources.length === 1 ? "" : "s"}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4" /> Avg Close Rate
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{(avgCloseRate * 100).toFixed(0)}%</div>
                <p className="text-xs text-muted-foreground mt-1">lead → closed, blended</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                  <Activity className="h-4 w-4" /> Campaign ROI
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${avgRoi >= 0 ? "text-green-600" : "text-red-600"}`}>{avgRoi.toFixed(0)}%</div>
                <p className="text-xs text-muted-foreground mt-1">avg across {campaigns.length} campaign{campaigns.length === 1 ? "" : "s"}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                  <Star className="h-4 w-4" /> Avg Rating
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{avgRating != null ? avgRating.toFixed(1) : "N/A"}</div>
                <p className="text-xs text-muted-foreground mt-1">{totalReviews} review{totalReviews === 1 ? "" : "s"}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Highlights</CardTitle>
              <CardDescription>Your best-performing channels this year — open a tab for the full breakdown</CardDescription>
            </CardHeader>
            <CardContent>
              {hasSummaryData ? (
                <div className="space-y-3">
                  {topSource && (
                    <div className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <div className="font-medium text-sm capitalize">Top source · {topSource.source ?? topSource.source_family ?? "Unknown"}</div>
                        <div className="text-xs text-muted-foreground">
                          {(topSource.contact_count ?? 0)} contacts &bull; {((topSource.close_rate ?? 0) * 100).toFixed(0)}% close rate
                        </div>
                      </div>
                      <div className="text-right text-sm font-medium">
                        ${(topSource.revenue ?? topSource.totalRevenue ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                        <div className="text-xs text-muted-foreground font-normal">influenced revenue</div>
                      </div>
                    </div>
                  )}
                  {topCampaign && (
                    <div className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <div className="font-medium text-sm">Top campaign · {topCampaign.campaign_name ?? topCampaign.name ?? "Unnamed"}</div>
                        <div className="text-xs text-muted-foreground">{topCampaign.total_leads ?? topCampaign.leadsGenerated ?? 0} leads generated</div>
                      </div>
                      <div className="text-right text-sm font-medium">
                        {(topCampaign.roi_percentage ?? topCampaign.roi ?? 0).toFixed(0)}% ROI
                      </div>
                    </div>
                  )}
                  {reputationData && (
                    <div className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <div className="font-medium text-sm">Reputation</div>
                        <div className="text-xs text-muted-foreground">{totalReviews} reviews · {reputationData.responseRate?.toFixed(0) ?? 0}% response rate</div>
                      </div>
                      <div className="text-right text-sm font-medium flex items-center gap-1">
                        <Star className="h-3.5 w-3.5 fill-yellow-500 text-yellow-500" />
                        {avgRating != null ? avgRating.toFixed(1) : "N/A"}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-muted-foreground">No performance data yet — as leads, campaigns, and reviews come in, your snapshot builds here.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Source Performance Tab */}
        <TabsContent value="source" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Source Performance</CardTitle>
                  <CardDescription>Leads and revenue by source</CardDescription>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleExport("csv", "source")}
                  disabled={isPending}
                  className="bg-transparent"
                >
                  Export CSV
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {sourceData?.sources && sourceData.sources.length > 0 ? (
                <div className="space-y-3">
                  {sourceData.sources.map((source: any) => (
                    <div key={source.source} className="flex items-center justify-between p-4 border rounded-lg">
                      <div>
                        <div className="font-medium capitalize">{source.source ?? source.source_family ?? "Unknown"}</div>
                        <div className="text-sm text-muted-foreground">
                          {source.contact_count ?? 0} contacts &bull; {((source.close_rate ?? 0) * 100).toFixed(0)}% close rate
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-medium">
                          ${(source.revenue ?? source.totalRevenue ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {source.roi_multiple ? `${source.roi_multiple}x ROI` : (source.transaction_count ?? 0) + " transactions"}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground">No source data available</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Campaign ROI Tab */}
        <TabsContent value="campaigns" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Campaign ROI</CardTitle>
                  <CardDescription>Marketing spend vs. revenue generated</CardDescription>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleExport("csv", "campaign")}
                  disabled={isPending}
                  className="bg-transparent"
                >
                  Export CSV
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {campaignData?.campaigns && campaignData.campaigns.length > 0 ? (
                <div className="space-y-3">
                  {campaignData.campaigns.map((campaign: any) => {
                    const name        = campaign.campaign_name ?? campaign.name ?? "Unnamed"
                    const budget      = campaign.budget_total  ?? campaign.budget ?? 0
                    const spent       = campaign.budget_spent  ?? campaign.budgetSpent ?? campaign.total_spend ?? 0
                    const leads       = campaign.total_leads   ?? campaign.leadsGenerated ?? 0
                    const roi         = campaign.roi_percentage ?? campaign.roi ?? 0
                    const revenue     = campaign.total_revenue ?? campaign.revenueGenerated ?? 0
                    return (
                      <div key={campaign.id} className="flex items-center justify-between p-4 border rounded-lg">
                        <div className="flex-1">
                          <div className="font-medium">{name}</div>
                          <div className="text-sm text-muted-foreground flex items-center gap-4 mt-1">
                            {budget > 0 && <span>Budget: ${budget.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>}
                            <span>Spent: ${spent.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                            <span>{leads} leads</span>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className={`font-bold ${roi >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {typeof roi === "number" ? roi.toFixed(1) : roi}% ROI
                          </div>
                          <div className="text-sm text-muted-foreground">
                            ${revenue.toLocaleString("en-US", { maximumFractionDigits: 0 })} revenue
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="text-muted-foreground">No campaign data available</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Reputation Tab */}
        <TabsContent value="reputation" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Reputation Summary</CardTitle>
                  <CardDescription>Reviews, ratings, and referral performance</CardDescription>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleExport("csv", "reputation")}
                  disabled={isPending}
                  className="bg-transparent"
                >
                  Export CSV
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {reputationData ? (
                <div className="grid gap-4 md:grid-cols-3 mb-6">
                  <Card className="border-0 bg-muted/50">
                    <CardContent className="pt-6">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-muted-foreground">Average Rating</p>
                          <div className="text-2xl font-bold">
                            {reputationData.avgRating?.toFixed(1) ?? "N/A"}
                          </div>
                        </div>
                        <Star className="h-8 w-8 text-yellow-500 fill-yellow-500" />
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-0 bg-muted/50">
                    <CardContent className="pt-6">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-muted-foreground">Reviews Received</p>
                          <div className="text-2xl font-bold">{reputationData.totalReviews ?? 0}</div>
                        </div>
                        <Eye className="h-8 w-8 text-blue-500" />
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-0 bg-muted/50">
                    <CardContent className="pt-6">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-muted-foreground">Response Rate</p>
                          <div className="text-2xl font-bold">
                            {reputationData.responseRate?.toFixed(0) ?? 0}%
                          </div>
                        </div>
                        <CheckCircle2 className="h-8 w-8 text-green-500" />
                      </div>
                    </CardContent>
                  </Card>
                </div>
              ) : null}

              {reputationData?.recentReviews && reputationData.recentReviews.length > 0 ? (
                <div>
                  <h4 className="font-medium mb-3">Recent Reviews</h4>
                  <div className="space-y-3">
                    {reputationData.recentReviews.map((review: any, idx: number) => (
                      <div key={idx} className="p-4 border rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="flex gap-1">
                              {[...Array(5)].map((_, i) => (
                                <Star
                                  key={i}
                                  className={`h-4 w-4 ${
                                    i < review.rating ? "fill-yellow-500 text-yellow-500" : "text-gray-300"
                                  }`}
                                />
                              ))}
                            </div>
                            <span className="text-sm font-medium">{review.rating}/5</span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {new Date(review.created_at).toLocaleDateString()}
                          </span>
                        </div>
                        {review.review_text && (
                          <p className="text-sm text-muted-foreground italic">{review.review_text}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-muted-foreground">No review data available</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Pipeline Tab — transaction pipeline by stage, loaded on demand */}
        <TabsContent value="pipeline" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Transaction Pipeline</CardTitle>
                  <CardDescription>Open deals by stage, pipeline value, and what has closed YTD</CardDescription>
                </div>
                <Button size="sm" variant="outline" onClick={loadPipeline} disabled={isPending} className="bg-transparent">
                  {pipelineData ? "Refresh" : "Load pipeline"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {pipelineError && (
                <p className="text-sm text-destructive mb-3">{pipelineError}</p>
              )}
              {!pipelineData && !pipelineError && (
                <p className="text-muted-foreground text-sm">Load the pipeline report to see stage-by-stage volume.</p>
              )}
              {pipelineData && (
                <div className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-3">
                    <Card className="border-0 bg-muted/50">
                      <CardContent className="pt-6">
                        <p className="text-sm text-muted-foreground">Pipeline Value</p>
                        <div className="text-2xl font-bold">
                          ${Number(pipelineData.totalPipelineValue ?? 0).toLocaleString()}
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="border-0 bg-muted/50">
                      <CardContent className="pt-6">
                        <p className="text-sm text-muted-foreground">Closed YTD</p>
                        <div className="text-2xl font-bold">{pipelineData.closedYTD ?? 0}</div>
                      </CardContent>
                    </Card>
                    <Card className="border-0 bg-muted/50">
                      <CardContent className="pt-6">
                        <p className="text-sm text-muted-foreground">Closed YTD Value</p>
                        <div className="text-2xl font-bold">
                          ${Number(pipelineData.closedYTDValue ?? 0).toLocaleString()}
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                  {(pipelineData.byStage ?? []).length > 0 ? (
                    <div className="space-y-2">
                      {pipelineData.byStage.map((row: any) => (
                        <div key={row.stage} className="flex items-center justify-between border rounded-lg p-3">
                          <div>
                            <p className="font-medium capitalize">{String(row.stage).replace(/_/g, " ")}</p>
                            <p className="text-xs text-muted-foreground">
                              {row.count} deal{row.count === 1 ? "" : "s"} · avg {Math.round(row.avg_days_in_stage ?? 0)} days in stage
                            </p>
                          </div>
                          <span className="font-semibold">${Number(row.total_value ?? 0).toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm">No open deals in the pipeline.</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Team Tab — team revenue vs goal, loaded on demand */}
        <TabsContent value="team" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Team Performance</CardTitle>
                  <CardDescription>Revenue against goal for every team in scope</CardDescription>
                </div>
                <Button size="sm" variant="outline" onClick={loadTeam} disabled={isPending} className="bg-transparent">
                  {teamData ? "Refresh" : "Load teams"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {teamError && <p className="text-sm text-destructive mb-3">{teamError}</p>}
              {!teamData && !teamError && (
                <p className="text-muted-foreground text-sm">Load the team report to see attainment.</p>
              )}
              {teamData && ((teamData.teams ?? []).length > 0 ? (
                <div className="space-y-2">
                  {teamData.teams.map((t: any) => (
                    <div key={t.id} className="flex items-center justify-between border rounded-lg p-3">
                      <div>
                        <p className="font-medium">{t.team_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {t.agent_count} agent{t.agent_count === 1 ? "" : "s"}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold">${Number(t.total_revenue ?? 0).toLocaleString()}</p>
                        <p className="text-xs text-muted-foreground">
                          {Math.round(t.attainment_pct ?? 0)}% of ${Number(t.goal_amount ?? 0).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No teams in scope — team reports are visible to team leads, brokers and admins.
                </p>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Email Report Dialog */}
      <Dialog open={emailDialogOpen} onOpenChange={setEmailDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Email Report</DialogTitle>
            <DialogDescription>Send a report to team members or stakeholders</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="report-type">Report Type</Label>
              <Select value={emailReportType} onValueChange={setEmailReportType}>
                <SelectTrigger>
                  <SelectValue placeholder="Select report type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="summary">Summary</SelectItem>
                  <SelectItem value="source">Source Performance</SelectItem>
                  <SelectItem value="campaign">Campaign ROI</SelectItem>
                  <SelectItem value="reputation">Reputation</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="recipients">
                Recipients <span className="text-destructive">*</span>
              </Label>
              <Input
                id="recipients"
                value={emailRecipients}
                onChange={(e) => setEmailRecipients(e.target.value)}
                placeholder="email@example.com, another@example.com"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="subject">
                Subject <span className="text-destructive">*</span>
              </Label>
              <Input
                id="subject"
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
                placeholder="Report subject"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="message">Message</Label>
              <Textarea
                id="message"
                value={emailMessage}
                onChange={(e) => setEmailMessage(e.target.value)}
                placeholder="Optional message to include with the report..."
                rows={3}
              />
            </div>

            {emailError && <p className="text-sm text-destructive">{emailError}</p>}
            {emailSuccess && (
              <p className="text-sm text-green-600 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" />
                Report sent successfully!
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEmailDialogOpen(false)
                setEmailError("")
                setEmailSuccess(false)
              }}
              className="bg-transparent"
            >
              Cancel
            </Button>
            <Button onClick={handleEmailReport} disabled={isPending || emailSuccess}>
              {isPending ? (
                <>
                  <Clock className="h-4 w-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Send Report
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
