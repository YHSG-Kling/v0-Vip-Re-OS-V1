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
} from "@/app/actions/reporting-kernel"

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

  // Summary is a PERFORMANCE snapshot built from the analytics already loaded —
  // commission is intentionally NOT shown here (it lives in Financials →
  // Commission Tracker; duplicating it made Reports read as a commission rehash).
  const sources   = initialSourceData?.sources ?? []
  const campaigns = initialCampaignData?.campaigns ?? []
  const totalLeads    = sources.reduce((s: number, x: any) => s + (x.contact_count ?? 0), 0)
  const avgCloseRate  = sources.length
    ? sources.reduce((s: number, x: any) => s + (x.close_rate ?? 0), 0) / sources.length
    : 0
  const avgRoi = campaigns.length
    ? campaigns.reduce((s: number, x: any) => s + (x.roi_percentage ?? x.roi ?? 0), 0) / campaigns.length
    : 0
  const avgRating   = initialReputationData?.avgRating ?? null
  const totalReviews = initialReputationData?.totalReviews ?? 0
  const topSource = [...sources].sort(
    (a: any, b: any) => (b.revenue ?? b.totalRevenue ?? 0) - (a.revenue ?? a.totalRevenue ?? 0),
  )[0] ?? null
  const topCampaign = [...campaigns].sort(
    (a: any, b: any) => (b.roi_percentage ?? b.roi ?? 0) - (a.roi_percentage ?? a.roi ?? 0),
  )[0] ?? null
  const hasSummaryData = sources.length > 0 || campaigns.length > 0 || !!initialReputationData

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
            dateFrom: monthStart,
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
            dateFrom: monthStart,
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
          dateFrom:    monthStart,
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
        </TabsList>

        {/* Summary Tab — performance snapshot (NOT commission; that's in Financials) */}
        <TabsContent value="summary" className="space-y-4">
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
                  {initialReputationData && (
                    <div className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <div className="font-medium text-sm">Reputation</div>
                        <div className="text-xs text-muted-foreground">{totalReviews} reviews · {initialReputationData.responseRate?.toFixed(0) ?? 0}% response rate</div>
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
              {initialSourceData?.sources && initialSourceData.sources.length > 0 ? (
                <div className="space-y-3">
                  {initialSourceData.sources.map((source: any) => (
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
              {initialCampaignData?.campaigns && initialCampaignData.campaigns.length > 0 ? (
                <div className="space-y-3">
                  {initialCampaignData.campaigns.map((campaign: any) => {
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
              {initialReputationData ? (
                <div className="grid gap-4 md:grid-cols-3 mb-6">
                  <Card className="border-0 bg-muted/50">
                    <CardContent className="pt-6">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-muted-foreground">Average Rating</p>
                          <div className="text-2xl font-bold">
                            {initialReputationData.avgRating?.toFixed(1) ?? "N/A"}
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
                          <div className="text-2xl font-bold">{initialReputationData.totalReviews ?? 0}</div>
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
                            {initialReputationData.responseRate?.toFixed(0) ?? 0}%
                          </div>
                        </div>
                        <CheckCircle2 className="h-8 w-8 text-green-500" />
                      </div>
                    </CardContent>
                  </Card>
                </div>
              ) : null}

              {initialReputationData?.recentReviews && initialReputationData.recentReviews.length > 0 ? (
                <div>
                  <h4 className="font-medium mb-3">Recent Reviews</h4>
                  <div className="space-y-3">
                    {initialReputationData.recentReviews.map((review: any, idx: number) => (
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
