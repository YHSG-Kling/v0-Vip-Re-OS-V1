"use client"

import { useState, useEffect, useCallback } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  BarChart3,
  TrendingUp,
  Users,
  DollarSign,
  Share2,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Copy,
  Download,
  Sparkles,
  FileText,
  Target,
  Clock,
  RefreshCw,
  Building2,
  UserCheck,
} from "lucide-react"
import Link from "next/link"

// Action imports
import {
  loadValueDrivenDashboard,
  calculateTrustCapital,
  aggregateValueDelivered,
} from "@/app/actions/analytics"
import {
  aiGenerateProfitLossReport,
  getCommissionRecords,
  getExpenses,
} from "@/app/actions/ai-financial-management"
import {
  getTopConversionCandidates,
} from "@/app/actions/ai-predictions"
import {
  getContentPerformanceStats,
  getHashtagPerformance,
} from "@/app/actions/ai-content-generation.tsx"
import { getSocialQueue } from "@/app/actions/social-media-automation"
import { getReferralROI } from "@/app/actions/referral-management"
import { getWorkflowStats } from "@/app/actions/workflow-monitoring"
import { generateSmartResponse } from "@/app/actions/ai-communication-hub"

interface ReportsClientProps {
  agentId: string
  brokerageId?: string
  role: string
  userId: string
  monthStart: string
}

type Period = "month" | "quarter" | "year"

export function ReportsClient({
  agentId,
  brokerageId,
  role,
  userId,
  monthStart,
}: ReportsClientProps) {
  const [activeTab, setActiveTab] = useState("agent")
  const [period, setPeriod] = useState<Period>("month")
  const [generating, setGenerating] = useState(false)
  const [generatingPL, setGeneratingPL] = useState(false)

  // Data states
  const [valueData, setValueData] = useState<any>(null)
  const [commissions, setCommissions] = useState<any[]>([])
  const [expenses, setExpenses] = useState<any[]>([])
  const [conversionCandidates, setConversionCandidates] = useState<any[]>([])
  const [referralRoi, setReferralRoi] = useState<any>(null)
  const [trustCapital, setTrustCapital] = useState<number | null>(null)
  const [plReport, setPlReport] = useState<any>(null)

  // Social data
  const [contentStats, setContentStats] = useState<any>(null)
  const [hashtagPerformance, setHashtagPerformance] = useState<any>(null)
  const [socialQueue, setSocialQueue] = useState<any[]>([])

  // Team/Brokerage data
  const [workflowStats, setWorkflowStats] = useState<any>(null)

  // AI Summary states
  const [aiSummary, setAiSummary] = useState<string | null>(null)
  const [socialSummary, setSocialSummary] = useState<string | null>(null)
  const [pipelineSummary, setPipelineSummary] = useState<string | null>(null)
  const [teamSummary, setTeamSummary] = useState<string | null>(null)
  const [brokerageSummary, setBrokerageSummary] = useState<string | null>(null)

  const [loading, setLoading] = useState(true)

  const today = new Date().toISOString().split("T")[0]

  const getPeriodStart = useCallback(() => {
    const now = new Date()
    if (period === "month") {
      return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0]
    } else if (period === "quarter") {
      const quarter = Math.floor(now.getMonth() / 3)
      return new Date(now.getFullYear(), quarter * 3, 1).toISOString().split("T")[0]
    } else {
      return new Date(now.getFullYear(), 0, 1).toISOString().split("T")[0]
    }
  }, [period])

  // Load Agent Report data
  const loadAgentData = useCallback(async () => {
    setLoading(true)
    try {
      const [valueResult, commissionsResult, expensesResult, candidatesResult, referralResult, trustResult] =
        await Promise.all([
          loadValueDrivenDashboard(agentId, period).catch(() => null),
          getCommissionRecords({ status: "pending" }).catch(() => []),
          getExpenses({ startDate: getPeriodStart() }).catch(() => []),
          getTopConversionCandidates(5).catch(() => []),
          getReferralROI().catch(() => null),
          calculateTrustCapital(agentId).catch(() => null),
        ])

      setValueData(valueResult)
      setCommissions(commissionsResult || [])
      setExpenses(expensesResult || [])
      setConversionCandidates(candidatesResult || [])
      setReferralRoi(referralResult)
      setTrustCapital(trustResult)
    } catch (error) {
      console.error("Error loading agent data:", error)
    } finally {
      setLoading(false)
    }
  }, [agentId, period, getPeriodStart])

  // Load Social Report data
  const loadSocialData = useCallback(async () => {
    setLoading(true)
    try {
      const [contentResult, hashtagResult, queueResult] = await Promise.all([
        getContentPerformanceStats(agentId, { start: getPeriodStart(), end: today }).catch(() => null),
        getHashtagPerformance(agentId).catch(() => null),
        getSocialQueue({ brokerage_id: brokerageId }).catch(() => []),
      ])

      setContentStats(contentResult)
      setHashtagPerformance(hashtagResult)
      setSocialQueue(queueResult || [])
    } catch (error) {
      console.error("Error loading social data:", error)
    } finally {
      setLoading(false)
    }
  }, [agentId, brokerageId, getPeriodStart, today])

  // Load Pipeline data
  const loadPipelineData = useCallback(async () => {
    setLoading(true)
    try {
      const [candidatesResult, valueResult] = await Promise.all([
        getTopConversionCandidates(10).catch(() => []),
        loadValueDrivenDashboard(agentId, period).catch(() => null),
      ])

      setConversionCandidates(candidatesResult || [])
      setValueData(valueResult)
    } catch (error) {
      console.error("Error loading pipeline data:", error)
    } finally {
      setLoading(false)
    }
  }, [agentId, period])

  // Load Team/Brokerage data
  const loadTeamData = useCallback(async () => {
    setLoading(true)
    try {
      const [workflowResult] = await Promise.all([getWorkflowStats().catch(() => null)])
      setWorkflowStats(workflowResult)
    } catch (error) {
      console.error("Error loading team data:", error)
    } finally {
      setLoading(false)
    }
  }, [])

  // Tab change handler
  useEffect(() => {
    if (activeTab === "agent") {
      loadAgentData()
    } else if (activeTab === "social") {
      loadSocialData()
    } else if (activeTab === "pipeline") {
      loadPipelineData()
    } else if (activeTab === "team" || activeTab === "brokerage") {
      loadTeamData()
    }
  }, [activeTab, period, loadAgentData, loadSocialData, loadPipelineData, loadTeamData])

  // Generate P&L Report
  const handleGeneratePL = async () => {
    setGeneratingPL(true)
    try {
      const result = await aiGenerateProfitLossReport({
        agentId,
        startDate: getPeriodStart(),
        endDate: today,
        includeProjections: true,
      })
      setPlReport(result)
    } catch (error) {
      console.error("Error generating P&L:", error)
    } finally {
      setGeneratingPL(false)
    }
  }

  // Generate AI Summary
  const handleGenerateAiSummary = async (tab: string) => {
    setGenerating(true)
    try {
      let context = ""
      let systemPrompt = ""

      if (tab === "agent") {
        context = JSON.stringify({
          valueData,
          pendingCommissions: commissions.reduce((sum, c) => sum + (c.amount || 0), 0),
          totalExpenses: expenses.reduce((sum, e) => sum + (e.amount || 0), 0),
          referralRoi,
          trustCapital,
          conversionCandidates: conversionCandidates.length,
        })
        systemPrompt = `You are an AI business analyst for a real estate agent. Analyze this performance data and provide:
1. "What's Working" - 2-3 specific wins based on the data
2. "What to Correct" - 2-3 areas needing improvement
3. "Priority Action This Week" - 1 specific, actionable item

Be specific and reference actual numbers from the data. Format with clear headers.`
      } else if (tab === "social") {
        context = JSON.stringify({
          contentStats,
          hashtagPerformance,
          queuedPosts: socialQueue.length,
        })
        systemPrompt = `You are a social media strategist for a real estate agent. Analyze this content performance data and provide:
1. "What's Working" - 2-3 content wins
2. "What to Correct" - 2-3 content improvements
3. "What to Post Next Week" - 3 specific post ideas based on performance data

Be specific about content types and engagement metrics.`
      } else if (tab === "pipeline") {
        context = JSON.stringify({
          valueData,
          topCandidates: conversionCandidates,
        })
        systemPrompt = `You are a real estate pipeline analyst. Analyze this pipeline data and provide:
1. "What's Working" - 2-3 pipeline strengths
2. "What to Correct" - 2-3 pipeline issues
3. "Priority Pipeline Actions This Week" - Top 3 specific actions to take

Reference specific leads and conversion probabilities where available.`
      } else if (tab === "team") {
        context = JSON.stringify({ workflowStats })
        systemPrompt = `You are a team performance analyst for a real estate brokerage. Provide:
1. "Team Wins" - 2-3 team performance highlights
2. "Coaching Opportunities" - 2-3 areas for team improvement
3. "Priority Team Action" - 1 specific management action

Focus on actionable team-level insights.`
      } else if (tab === "brokerage") {
        context = JSON.stringify({ workflowStats })
        systemPrompt = `You are a brokerage operations analyst. Provide:
1. "Operational Wins" - 2-3 brokerage-wide wins
2. "Operational Bottlenecks" - 2-3 areas causing friction
3. "Priority Brokerage Action" - 1 specific operational improvement

Focus on scalable, brokerage-level insights.`
      }

      const result = await generateSmartResponse({
        agentId,
        contactId: userId,
        message: `Please analyze my ${tab} performance data: ${context}`,
        conversationHistory: [],
        systemPrompt,
      })

      const summaryText = result.response || result.message || "Unable to generate summary"

      if (tab === "agent") setAiSummary(summaryText)
      else if (tab === "social") setSocialSummary(summaryText)
      else if (tab === "pipeline") setPipelineSummary(summaryText)
      else if (tab === "team") setTeamSummary(summaryText)
      else if (tab === "brokerage") setBrokerageSummary(summaryText)
    } catch (error) {
      console.error("Error generating AI summary:", error)
    } finally {
      setGenerating(false)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const canAccessTeam = ["team_lead", "broker", "admin"].includes(role)
  const canAccessBrokerage = ["broker", "admin"].includes(role)

  // Calculate totals
  const pendingCommissionTotal = commissions.reduce((sum, c) => sum + (c.amount || 0), 0)
  const expensesTotal = expenses.reduce((sum, e) => sum + (e.amount || 0), 0)
  const netPipelineValue = pendingCommissionTotal - expensesTotal

  return (
    <div className="container mx-auto p-6 max-w-7xl space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Report Operations Center</h1>
          <p className="text-muted-foreground">
            Because the OS sees the whole business, your reports see what others can't.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="month">Month</SelectItem>
              <SelectItem value="quarter">Quarter</SelectItem>
              <SelectItem value="year">Year</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <TabsList className="grid w-full grid-cols-3 md:grid-cols-5 lg:w-auto lg:grid-cols-none lg:flex">
          <TabsTrigger value="agent" className="gap-2">
            <UserCheck className="h-4 w-4" />
            Agent
          </TabsTrigger>
          <TabsTrigger value="social" className="gap-2">
            <Share2 className="h-4 w-4" />
            Social & Marketing
          </TabsTrigger>
          <TabsTrigger value="pipeline" className="gap-2">
            <Target className="h-4 w-4" />
            Pipeline
          </TabsTrigger>
          {canAccessTeam && (
            <TabsTrigger value="team" className="gap-2">
              <Users className="h-4 w-4" />
              Team
            </TabsTrigger>
          )}
          {canAccessBrokerage && (
            <TabsTrigger value="brokerage" className="gap-2">
              <Building2 className="h-4 w-4" />
              Brokerage
            </TabsTrigger>
          )}
        </TabsList>

        {/* AGENT TAB */}
        <TabsContent value="agent" className="space-y-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Pipeline Performance */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="h-5 w-5" />
                    Pipeline Performance
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="p-4 rounded-lg border bg-card">
                      <p className="text-sm text-muted-foreground">Active Contacts</p>
                      <p className="text-2xl font-bold">{valueData?.activeContacts || 0}</p>
                    </div>
                    <div className="p-4 rounded-lg border bg-card">
                      <p className="text-sm text-muted-foreground">Value Delivered</p>
                      <p className="text-2xl font-bold">{valueData?.valueDeliveredScore || 0}</p>
                    </div>
                    <div className="p-4 rounded-lg border bg-card">
                      <p className="text-sm text-muted-foreground">Trust Capital</p>
                      <p className="text-2xl font-bold">{trustCapital?.toFixed(1) || 0}</p>
                    </div>
                    <div className="p-4 rounded-lg border bg-card">
                      <p className="text-sm text-muted-foreground">Conversion Candidates</p>
                      <p className="text-2xl font-bold">{conversionCandidates.length}</p>
                    </div>
                  </div>

                  {conversionCandidates.length > 0 && (
                    <div className="mt-4">
                      <h4 className="text-sm font-medium mb-2">Top Conversion Candidates</h4>
                      <div className="space-y-2">
                        {conversionCandidates.slice(0, 3).map((candidate: any, i: number) => (
                          <div key={i} className="flex items-center justify-between p-2 border rounded">
                            <span className="text-sm font-medium">
                              {candidate.contact?.first_name} {candidate.contact?.last_name}
                            </span>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline">{Math.round(candidate.probability * 100)}%</Badge>
                              <Link href="/crm">
                                <Button variant="ghost" size="sm">
                                  View
                                </Button>
                              </Link>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Financial Health */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <DollarSign className="h-5 w-5" />
                    Financial Health
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                    <div className="p-4 rounded-lg border bg-card">
                      <p className="text-sm text-muted-foreground">Pending Commissions</p>
                      <p className="text-2xl font-bold text-green-600">
                        ${pendingCommissionTotal.toLocaleString()}
                      </p>
                    </div>
                    <div className="p-4 rounded-lg border bg-card">
                      <p className="text-sm text-muted-foreground">Period Expenses</p>
                      <p className="text-2xl font-bold text-red-600">
                        ${expensesTotal.toLocaleString()}
                      </p>
                    </div>
                    <div className="p-4 rounded-lg border bg-card">
                      <p className="text-sm text-muted-foreground">Net Pipeline Value</p>
                      <p className={`text-2xl font-bold ${netPipelineValue >= 0 ? "text-green-600" : "text-red-600"}`}>
                        ${netPipelineValue.toLocaleString()}
                      </p>
                    </div>
                    <div className="p-4 rounded-lg border bg-card flex flex-col justify-center">
                      <Button onClick={handleGeneratePL} disabled={generatingPL} className="w-full">
                        {generatingPL ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Generating...
                          </>
                        ) : (
                          <>
                            <FileText className="h-4 w-4 mr-2" />
                            Generate Full P&L
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {plReport && (
                    <div className="mt-4 p-4 border rounded-lg bg-muted/50">
                      <h4 className="font-medium mb-2">P&L Report Summary</h4>
                      <pre className="text-sm whitespace-pre-wrap">{JSON.stringify(plReport, null, 2)}</pre>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Referral Performance */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <TrendingUp className="h-5 w-5" />
                    Referral Performance
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="p-4 rounded-lg border bg-card">
                      <p className="text-sm text-muted-foreground">Total Referrals</p>
                      <p className="text-2xl font-bold">{referralRoi?.totalReferrals || 0}</p>
                    </div>
                    <div className="p-4 rounded-lg border bg-card">
                      <p className="text-sm text-muted-foreground">Converted</p>
                      <p className="text-2xl font-bold">{referralRoi?.closed || 0}</p>
                    </div>
                    <div className="p-4 rounded-lg border bg-card">
                      <p className="text-sm text-muted-foreground">Total Value</p>
                      <p className="text-2xl font-bold text-green-600">
                        ${(referralRoi?.totalValue || 0).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* AI Business Summary */}
              <Card className="border-primary/20">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-primary" />
                    AI Business Summary
                  </CardTitle>
                  <CardDescription>
                    Get AI-powered insights on your business performance
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {!aiSummary ? (
                    <Button
                      onClick={() => handleGenerateAiSummary("agent")}
                      disabled={generating}
                      className="w-full"
                      size="lg"
                    >
                      {generating ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          AI is analyzing your business data...
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-4 w-4 mr-2" />
                          Generate AI Report Summary
                        </>
                      )}
                    </Button>
                  ) : (
                    <div className="space-y-4">
                      <div className="prose prose-sm max-w-none whitespace-pre-wrap">{aiSummary}</div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => copyToClipboard(aiSummary)}>
                          <Copy className="h-4 w-4 mr-2" />
                          Copy
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => window.print()}>
                          <Download className="h-4 w-4 mr-2" />
                          Export PDF
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setAiSummary(null)}>
                          Regenerate
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* SOCIAL & MARKETING TAB */}
        <TabsContent value="social" className="space-y-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Content Performance */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Share2 className="h-5 w-5" />
                    Content Performance
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="p-4 rounded-lg border bg-card">
                      <p className="text-sm text-muted-foreground">Posts Published</p>
                      <p className="text-2xl font-bold">{contentStats?.postsPublished || 0}</p>
                    </div>
                    <div className="p-4 rounded-lg border bg-card">
                      <p className="text-sm text-muted-foreground">Scheduled</p>
                      <p className="text-2xl font-bold">{socialQueue.filter((p) => p.status === "scheduled").length}</p>
                    </div>
                    <div className="p-4 rounded-lg border bg-card">
                      <p className="text-sm text-muted-foreground">Avg Engagement</p>
                      <p className="text-2xl font-bold">{contentStats?.avgEngagementRate?.toFixed(1) || 0}%</p>
                    </div>
                    <div className="p-4 rounded-lg border bg-card">
                      <p className="text-sm text-muted-foreground">Best Platform</p>
                      <p className="text-2xl font-bold capitalize">{contentStats?.bestPlatform || "N/A"}</p>
                    </div>
                  </div>

                  {contentStats?.topPost && (
                    <div className="mt-4 p-4 border rounded-lg bg-muted/50">
                      <h4 className="font-medium mb-1">Top Performing Post</h4>
                      <p className="text-sm text-muted-foreground">{contentStats.topPost.content}</p>
                      <Badge variant="outline" className="mt-2">
                        {contentStats.topPost.engagement} engagements
                      </Badge>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Hashtag Intelligence */}
              <Card>
                <CardHeader>
                  <CardTitle>Hashtag Intelligence</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid md:grid-cols-2 gap-6">
                    <div>
                      <h4 className="text-sm font-medium mb-2 text-green-600">Top Performing</h4>
                      <div className="flex flex-wrap gap-2">
                        {(hashtagPerformance?.top || []).slice(0, 5).map((tag: any, i: number) => (
                          <Badge key={i} variant="outline" className="bg-green-50">
                            #{tag.hashtag} ({tag.engagement})
                          </Badge>
                        ))}
                        {(!hashtagPerformance?.top || hashtagPerformance.top.length === 0) && (
                          <p className="text-sm text-muted-foreground">No data yet</p>
                        )}
                      </div>
                    </div>
                    <div>
                      <h4 className="text-sm font-medium mb-2 text-red-600">Declining (Consider Removing)</h4>
                      <div className="flex flex-wrap gap-2">
                        {(hashtagPerformance?.declining || []).slice(0, 5).map((tag: any, i: number) => (
                          <Badge key={i} variant="outline" className="bg-red-50">
                            #{tag.hashtag}
                          </Badge>
                        ))}
                        {(!hashtagPerformance?.declining || hashtagPerformance.declining.length === 0) && (
                          <p className="text-sm text-muted-foreground">None identified</p>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* AI Social Summary */}
              <Card className="border-primary/20">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-primary" />
                    AI Social Strategy
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {!socialSummary ? (
                    <Button
                      onClick={() => handleGenerateAiSummary("social")}
                      disabled={generating}
                      className="w-full"
                      size="lg"
                    >
                      {generating ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          AI is analyzing your content...
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-4 w-4 mr-2" />
                          What Should I Post Next Week?
                        </>
                      )}
                    </Button>
                  ) : (
                    <div className="space-y-4">
                      <div className="prose prose-sm max-w-none whitespace-pre-wrap">{socialSummary}</div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => copyToClipboard(socialSummary)}>
                          <Copy className="h-4 w-4 mr-2" />
                          Copy
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setSocialSummary(null)}>
                          Regenerate
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* PIPELINE TAB */}
        <TabsContent value="pipeline" className="space-y-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Lead Conversion Funnel */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Target className="h-5 w-5" />
                    Lead Conversion Funnel
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {[
                      { label: "Leads", value: valueData?.leads || 0, color: "bg-blue-500" },
                      { label: "Contacts", value: valueData?.activeContacts || 0, color: "bg-indigo-500" },
                      { label: "Active/Touring", value: valueData?.activeDeals || 0, color: "bg-purple-500" },
                      { label: "Under Contract", value: valueData?.underContract || 0, color: "bg-pink-500" },
                      { label: "Closed", value: valueData?.closedDeals || 0, color: "bg-green-500" },
                    ].map((stage, i) => (
                      <div key={i} className="space-y-1">
                        <div className="flex justify-between text-sm">
                          <span>{stage.label}</span>
                          <span className="font-medium">{stage.value}</span>
                        </div>
                        <Progress value={(stage.value / Math.max(valueData?.leads || 1, 1)) * 100} className="h-2" />
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Top Conversion Candidates */}
              <Card>
                <CardHeader>
                  <CardTitle>Top Conversion Candidates</CardTitle>
                  <CardDescription>Leads most likely to convert based on AI analysis</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {conversionCandidates.length > 0 ? (
                      conversionCandidates.map((candidate: any, i: number) => (
                        <div key={i} className="flex items-center justify-between p-3 border rounded-lg">
                          <div>
                            <p className="font-medium">
                              {candidate.contact?.first_name} {candidate.contact?.last_name}
                            </p>
                            <p className="text-sm text-muted-foreground">{candidate.suggestedAction}</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="text-right">
                              <p className="text-lg font-bold text-green-600">
                                {Math.round(candidate.probability * 100)}%
                              </p>
                              <p className="text-xs text-muted-foreground">conversion</p>
                            </div>
                            <Link href="/crm">
                              <Button variant="outline" size="sm">
                                Open Contact
                              </Button>
                            </Link>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-muted-foreground text-center py-4">No conversion candidates found</p>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* AI Pipeline Summary */}
              <Card className="border-primary/20">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-primary" />
                    AI Pipeline Analysis
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {!pipelineSummary ? (
                    <Button
                      onClick={() => handleGenerateAiSummary("pipeline")}
                      disabled={generating}
                      className="w-full"
                      size="lg"
                    >
                      {generating ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          AI is analyzing your pipeline...
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-4 w-4 mr-2" />
                          What Pipeline Actions Should I Take?
                        </>
                      )}
                    </Button>
                  ) : (
                    <div className="space-y-4">
                      <div className="prose prose-sm max-w-none whitespace-pre-wrap">{pipelineSummary}</div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => copyToClipboard(pipelineSummary)}>
                          <Copy className="h-4 w-4 mr-2" />
                          Copy
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setPipelineSummary(null)}>
                          Regenerate
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* TEAM TAB */}
        {canAccessTeam && (
          <TabsContent value="team" className="space-y-6">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Users className="h-5 w-5" />
                      Team Performance Overview
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="p-4 rounded-lg border bg-card">
                        <p className="text-sm text-muted-foreground">Active Workflows</p>
                        <p className="text-2xl font-bold">{workflowStats?.running || 0}</p>
                      </div>
                      <div className="p-4 rounded-lg border bg-card">
                        <p className="text-sm text-muted-foreground">Completed Today</p>
                        <p className="text-2xl font-bold text-green-600">{workflowStats?.completed || 0}</p>
                      </div>
                      <div className="p-4 rounded-lg border bg-card">
                        <p className="text-sm text-muted-foreground">Failed</p>
                        <p className="text-2xl font-bold text-red-600">{workflowStats?.failed || 0}</p>
                      </div>
                      <div className="p-4 rounded-lg border bg-card">
                        <p className="text-sm text-muted-foreground">Pending Approval</p>
                        <p className="text-2xl font-bold text-amber-600">{workflowStats?.paused || 0}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* AI Team Summary */}
                <Card className="border-primary/20">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Sparkles className="h-5 w-5 text-primary" />
                      AI Team Insights
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {!teamSummary ? (
                      <Button
                        onClick={() => handleGenerateAiSummary("team")}
                        disabled={generating}
                        className="w-full"
                        size="lg"
                      >
                        {generating ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            AI is analyzing team performance...
                          </>
                        ) : (
                          <>
                            <Sparkles className="h-4 w-4 mr-2" />
                            Generate Team Summary
                          </>
                        )}
                      </Button>
                    ) : (
                      <div className="space-y-4">
                        <div className="prose prose-sm max-w-none whitespace-pre-wrap">{teamSummary}</div>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" onClick={() => copyToClipboard(teamSummary)}>
                            <Copy className="h-4 w-4 mr-2" />
                            Copy
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setTeamSummary(null)}>
                            Regenerate
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            )}
          </TabsContent>
        )}

        {/* BROKERAGE TAB */}
        {canAccessBrokerage && (
          <TabsContent value="brokerage" className="space-y-6">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Building2 className="h-5 w-5" />
                      Brokerage Operations
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="p-4 rounded-lg border bg-card">
                        <p className="text-sm text-muted-foreground">Total Workflows</p>
                        <p className="text-2xl font-bold">{workflowStats?.total || 0}</p>
                      </div>
                      <div className="p-4 rounded-lg border bg-card">
                        <p className="text-sm text-muted-foreground">Success Rate</p>
                        <p className="text-2xl font-bold text-green-600">
                          {workflowStats?.total
                            ? Math.round(((workflowStats.completed || 0) / workflowStats.total) * 100)
                            : 0}
                          %
                        </p>
                      </div>
                      <div className="p-4 rounded-lg border bg-card">
                        <p className="text-sm text-muted-foreground">Bottlenecks</p>
                        <p className="text-2xl font-bold text-amber-600">{workflowStats?.paused || 0}</p>
                      </div>
                      <div className="p-4 rounded-lg border bg-card">
                        <p className="text-sm text-muted-foreground">Errors</p>
                        <p className="text-2xl font-bold text-red-600">{workflowStats?.failed || 0}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* AI Brokerage Summary */}
                <Card className="border-primary/20">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Sparkles className="h-5 w-5 text-primary" />
                      AI Brokerage Analysis
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {!brokerageSummary ? (
                      <Button
                        onClick={() => handleGenerateAiSummary("brokerage")}
                        disabled={generating}
                        className="w-full"
                        size="lg"
                      >
                        {generating ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            AI is analyzing brokerage operations...
                          </>
                        ) : (
                          <>
                            <Sparkles className="h-4 w-4 mr-2" />
                            Generate Brokerage Summary
                          </>
                        )}
                      </Button>
                    ) : (
                      <div className="space-y-4">
                        <div className="prose prose-sm max-w-none whitespace-pre-wrap">{brokerageSummary}</div>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" onClick={() => copyToClipboard(brokerageSummary)}>
                            <Copy className="h-4 w-4 mr-2" />
                            Copy
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setBrokerageSummary(null)}>
                            Regenerate
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            )}
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
