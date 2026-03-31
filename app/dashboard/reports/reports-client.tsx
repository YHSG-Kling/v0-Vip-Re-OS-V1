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
  DollarSign,
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
  initialFinancialData: any
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
  initialFinancialData,
  initialReputationData,
  initialSourceData,
}: ReportsClientProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

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
          if (!result.success) throw new Error(result.error)
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
          if (!result.success) throw new Error(result.error)
          const a = document.createElement("a")
          a.href = result.pdfUrl
          a.download = `report-${reportType}-${new Date().toISOString().split("T")[0]}.pdf`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
        }
      } catch (error) {
        console.error("[v0] Export error:", error)
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
          reportType: emailReportType,
          recipients: emailRecipients.split(",").map((e) => e.trim()),
          subject: emailSubject,
          message: emailMessage || undefined,
          agentId,
          brokerageId,
          dateFrom: monthStart,
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

        {/* Summary Tab */}
        <TabsContent value="summary" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-4">
            {initialFinancialData && (
              <>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">YTD Revenue</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      ${(initialFinancialData.totalCommission ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {initialFinancialData.commission_count ?? 0} transactions
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Total Expenses</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      ${(initialFinancialData.totalExpenses ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {initialFinancialData.expense_count ?? 0} entries
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Net Profit</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-green-600">
                      ${(
                        (initialFinancialData.totalCommission ?? 0) - (initialFinancialData.totalExpenses ?? 0)
                      ).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">YTD margin</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Profit Margin</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {initialFinancialData.profitMarginPercent?.toFixed(1) ?? "0"}%
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">of gross revenue</p>
                  </CardContent>
                </Card>
              </>
            )}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Monthly Breakdown</CardTitle>
              <CardDescription>Revenue, expenses, and net profit by month</CardDescription>
            </CardHeader>
            <CardContent>
              {initialFinancialData?.monthlyData ? (
                <div className="space-y-3">
                  {initialFinancialData.monthlyData.map((month: any, idx: number) => (
                    <div key={idx} className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <div className="font-medium">{month.month}</div>
                        <div className="text-sm text-muted-foreground">
                          {month.transactionCount} transactions
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-medium">
                          ${month.revenue.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                        </div>
                        <div className={`text-sm ${month.netProfit >= 0 ? "text-green-600" : "text-red-600"}`}>
                          Net: ${month.netProfit.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground">No data available</p>
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
                        <div className="font-medium capitalize">{source.source}</div>
                        <div className="text-sm text-muted-foreground">
                          {source.leadCount} leads • {source.conversionRate}% conversion
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-medium">
                          ${source.totalRevenue.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          ${source.avgDeal.toLocaleString("en-US", { maximumFractionDigits: 0 })} avg deal
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
                  {initialCampaignData.campaigns.map((campaign: any) => (
                    <div key={campaign.id} className="flex items-center justify-between p-4 border rounded-lg">
                      <div className="flex-1">
                        <div className="font-medium">{campaign.name}</div>
                        <div className="text-sm text-muted-foreground flex items-center gap-4 mt-1">
                          <span>Budget: ${campaign.budget?.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                          <span>Spent: ${campaign.budgetSpent?.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                          <span>{campaign.leadsGenerated} leads</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className={`font-bold ${campaign.roi >= 0 ? "text-green-600" : "text-red-600"}`}>
                          {campaign.roi?.toFixed(1)}% ROI
                        </div>
                        <div className="text-sm text-muted-foreground">
                          ${campaign.revenueGenerated?.toLocaleString("en-US", { maximumFractionDigits: 0 })} revenue
                        </div>
                      </div>
                    </div>
                  ))}
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
                          <div className="text-2xl font-bold">{initialReputationData.reviewCount ?? 0}</div>
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
