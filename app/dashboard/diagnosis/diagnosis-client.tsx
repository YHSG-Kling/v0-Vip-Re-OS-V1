"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Loader2,
  Stethoscope,
  AlertTriangle,
  TrendingUp,
  Users,
  Clock,
  Zap,
  DollarSign,
  ArrowRight,
  Brain,
  Copy,
  CheckCircle,
  XCircle,
  AlertCircle,
  Lightbulb,
  Target,
  RefreshCw,
} from "lucide-react"
import Link from "next/link"

// Real action imports
import { loadValueDrivenDashboard, calculateTrustCapital } from "@/app/actions/analytics"
import {
  findHiddenOpportunities,
  mineSphereOfInfluence,
  getTopConversionCandidates,
  getAgentCoachingInsights,
} from "@/app/actions/ai-predictions"
import { getWorkflowStats } from "@/app/actions/workflow-monitoring"
import { generateSmartResponse } from "@/app/actions/ai-communication-hub"

interface DiagnosisClientProps {
  agentId: string
  brokerageId: string
  userId: string
}

interface DiagnosisData {
  valueDashboard: any
  hiddenOpportunities: any[]
  sphereMining: any
  coachingInsights: any
  topConversionCandidates: any[]
  workflowStats: any
  trustCapital: any
}

export function DiagnosisClient({ agentId, brokerageId, userId }: DiagnosisClientProps) {
  const [diagnosisData, setDiagnosisData] = useState<DiagnosisData | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingStep, setLoadingStep] = useState("")
  const [aiSummary, setAiSummary] = useState<string | null>(null)
  const [generatingSummary, setGeneratingSummary] = useState(false)
  const [copied, setCopied] = useState(false)

  const runFullDiagnosis = async () => {
    setLoading(true)
    setDiagnosisData(null)
    setAiSummary(null)

    try {
      setLoadingStep("Scanning lead pipeline...")
      const [valueDashboard, topConversionCandidates] = await Promise.all([
        loadValueDrivenDashboard({ agentId, brokerageId }).catch(() => null),
        getTopConversionCandidates({ agentId, limit: 10 }).catch(() => []),
      ])

      setLoadingStep("Analyzing relationships...")
      const [hiddenOpportunities, sphereMining, trustCapital] = await Promise.all([
        findHiddenOpportunities({ agentId }).catch(() => []),
        mineSphereOfInfluence({ agentId }).catch(() => null),
        calculateTrustCapital({ agentId, brokerageId }).catch(() => null),
      ])

      setLoadingStep("Checking operations...")
      const [coachingInsights, workflowStats] = await Promise.all([
        getAgentCoachingInsights({ agentId }).catch(() => null),
        getWorkflowStats().catch(() => null),
      ])

      setDiagnosisData({
        valueDashboard,
        hiddenOpportunities: hiddenOpportunities || [],
        sphereMining,
        coachingInsights,
        topConversionCandidates: topConversionCandidates || [],
        workflowStats,
        trustCapital,
      })
    } catch (error) {
      console.error("Error running diagnosis:", error)
    } finally {
      setLoading(false)
      setLoadingStep("")
    }
  }

  const generateCorrectionPlan = async () => {
    if (!diagnosisData) return

    setGeneratingSummary(true)
    try {
      const context = `
Business Diagnosis Data:
- Top Conversion Candidates: ${diagnosisData.topConversionCandidates?.length || 0} leads
- Hidden Opportunities Found: ${diagnosisData.hiddenOpportunities?.length || 0}
- Sphere Mining Results: ${JSON.stringify(diagnosisData.sphereMining || {})}
- Coaching Insights: ${JSON.stringify(diagnosisData.coachingInsights || {})}
- Workflow Stats: ${JSON.stringify(diagnosisData.workflowStats || {})}
- Value Dashboard: ${JSON.stringify(diagnosisData.valueDashboard || {})}
      `

      const result = await generateSmartResponse({
        agentId,
        contactId: userId,
        messageContext: context,
        systemPrompt: `You are a real estate business strategist analyzing an agent's complete business health.
Based on this business diagnosis data, create a specific 30-day correction plan.

Format your response as:

**TOP 3 PROBLEMS**
1. [Problem with specific numbers]
2. [Problem with specific numbers]
3. [Problem with specific numbers]

**30-DAY CORRECTION PLAN**
Week 1: [Specific actions]
Week 2: [Specific actions]
Week 3: [Specific actions]
Week 4: [Specific actions]

**THIS WEEK'S #1 ACTION**
[Single most important action to take immediately]

Be direct, specific, and prioritized. Use the actual numbers from the data.`,
      })

      if (result.success && result.response) {
        setAiSummary(result.response)
      }
    } catch (error) {
      console.error("Error generating correction plan:", error)
    } finally {
      setGeneratingSummary(false)
    }
  }

  const copyToClipboard = () => {
    if (aiSummary) {
      navigator.clipboard.writeText(aiSummary)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  // Calculate derived metrics
  const inactiveLeads =
    diagnosisData?.topConversionCandidates?.filter((c: any) => {
      const lastActivity = new Date(c.last_activity_date || c.updated_at)
      const daysSince = (Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24)
      return daysSince > 14
    }).length || 0

  const highScoreNoFollowup =
    diagnosisData?.topConversionCandidates?.filter((c: any) => {
      const score = c.conversion_score || c.ai_score || 0
      const lastActivity = new Date(c.last_activity_date || c.updated_at)
      const daysSince = (Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24)
      return score > 70 && daysSince > 7
    }).length || 0

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-indigo-100">
              <Stethoscope className="h-6 w-6 text-indigo-600" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Business Diagnosis Center</h1>
              <p className="text-muted-foreground">
                Because the OS sees your entire business, it can show you exactly what to fix.
              </p>
            </div>
          </div>
        </div>

        <Button size="lg" onClick={runFullDiagnosis} disabled={loading} className="gap-2">
          {loading ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" />
              {loadingStep}
            </>
          ) : (
            <>
              <RefreshCw className="h-5 w-5" />
              Run Full Diagnosis
            </>
          )}
        </Button>
      </div>

      {/* Loading State */}
      {loading && (
        <Card className="border-indigo-200 bg-indigo-50/50">
          <CardContent className="py-8">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-12 w-12 animate-spin text-indigo-600" />
              <div className="text-center">
                <p className="text-lg font-medium text-indigo-900">{loadingStep}</p>
                <p className="text-sm text-indigo-600">Analyzing your complete business health...</p>
              </div>
              <Progress value={33} className="w-64" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* No Data State */}
      {!loading && !diagnosisData && (
        <Card className="border-dashed">
          <CardContent className="py-16">
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="p-4 rounded-full bg-muted">
                <Stethoscope className="h-12 w-12 text-muted-foreground" />
              </div>
              <div>
                <h3 className="text-xl font-semibold">Ready to Diagnose Your Business</h3>
                <p className="text-muted-foreground max-w-md mx-auto mt-2">
                  Click "Run Full Diagnosis" to scan your lead pipeline, relationships, operations, and finances.
                  You'll get specific insights on what to fix and how.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Diagnosis Results */}
      {diagnosisData && !loading && (
        <div className="space-y-6">
          {/* Section A: Lead Leakage */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Target className="h-5 w-5 text-amber-600" />
                <CardTitle>Lead Leakage Analysis</CardTitle>
              </div>
              <CardDescription>Top leads most likely to convert RIGHT NOW</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Top Conversion Candidates */}
              {diagnosisData.topConversionCandidates.length > 0 ? (
                <div className="space-y-3">
                  {diagnosisData.topConversionCandidates.slice(0, 5).map((candidate: any, idx: number) => (
                    <div
                      key={candidate.id || idx}
                      className="flex items-center justify-between p-3 rounded-lg border bg-card"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-amber-100 text-amber-700 font-semibold text-sm">
                          {idx + 1}
                        </div>
                        <div>
                          <p className="font-medium">
                            {candidate.contact_name || candidate.name || `Lead #${candidate.id?.slice(0, 8)}`}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            Score: {candidate.conversion_score || candidate.ai_score || "N/A"}% •{" "}
                            {candidate.suggested_action || "Follow up recommended"}
                          </p>
                        </div>
                      </div>
                      <Link href={`/crm?contactId=${candidate.contact_id || candidate.id}`}>
                        <Button variant="outline" size="sm" className="gap-1">
                          Open Contact
                          <ArrowRight className="h-3 w-3" />
                        </Button>
                      </Link>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-center py-4">No conversion candidates found</p>
              )}

              {/* Lead Leakage Signals */}
              <div className="grid md:grid-cols-2 gap-4 pt-4 border-t">
                <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-50 border border-amber-200">
                  <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
                  <div>
                    <p className="font-medium text-amber-900">Inactive Leads ({">"}14 days)</p>
                    <p className="text-2xl font-bold text-amber-700">{inactiveLeads}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-red-50 border border-red-200">
                  <XCircle className="h-5 w-5 text-red-600 mt-0.5" />
                  <div>
                    <p className="font-medium text-red-900">High Score, No Follow-up</p>
                    <p className="text-2xl font-bold text-red-700">{highScoreNoFollowup}</p>
                  </div>
                </div>
              </div>

              {(inactiveLeads > 0 || highScoreNoFollowup > 0) && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200">
                  <Lightbulb className="h-5 w-5 text-amber-600" />
                  <p className="text-sm text-amber-800">
                    You have {inactiveLeads + highScoreNoFollowup} high-probability leads without recent engagement.
                    Each day without contact decreases conversion likelihood.
                  </p>
                </div>
              )}

              <Link href="/leads">
                <Button variant="outline" className="w-full gap-2">
                  <Target className="h-4 w-4" />
                  Fix Lead Leakage
                </Button>
              </Link>
            </CardContent>
          </Card>

          {/* Section B: Hidden Opportunities */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Lightbulb className="h-5 w-5 text-emerald-600" />
                <CardTitle>Hidden Pipeline Opportunities</CardTitle>
              </div>
              <CardDescription>AI found these using your existing data</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {diagnosisData.hiddenOpportunities.length > 0 ? (
                <div className="space-y-3">
                  {diagnosisData.hiddenOpportunities.slice(0, 5).map((opp: any, idx: number) => (
                    <div key={opp.id || idx} className="p-4 rounded-lg border bg-emerald-50/50 border-emerald-200">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge
                              variant="outline"
                              className={
                                opp.type === "sphere"
                                  ? "bg-blue-100 text-blue-700 border-blue-200"
                                  : opp.type === "past_client"
                                    ? "bg-purple-100 text-purple-700 border-purple-200"
                                    : opp.type === "referral"
                                      ? "bg-amber-100 text-amber-700 border-amber-200"
                                      : "bg-gray-100 text-gray-700 border-gray-200"
                              }
                            >
                              {opp.type || "opportunity"}
                            </Badge>
                            {opp.estimated_value && (
                              <span className="text-sm font-medium text-emerald-700">
                                ${opp.estimated_value.toLocaleString()} potential
                              </span>
                            )}
                          </div>
                          <p className="font-medium">{opp.contact_name || opp.description || "Hidden Opportunity"}</p>
                          <p className="text-sm text-muted-foreground mt-1">
                            {opp.reason || opp.why || "AI detected potential based on your data"}
                          </p>
                        </div>
                        <Link
                          href={
                            opp.type === "referral"
                              ? "/referrals"
                              : opp.type === "past_client"
                                ? "/past-clients"
                                : `/crm?contactId=${opp.contact_id || opp.id}`
                          }
                        >
                          <Button size="sm" className="gap-1">
                            Act on This
                            <ArrowRight className="h-3 w-3" />
                          </Button>
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-center py-4">No hidden opportunities detected</p>
              )}

              <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-50 border border-emerald-200">
                <Brain className="h-5 w-5 text-emerald-600" />
                <p className="text-sm text-emerald-800">
                  Your sphere contains {diagnosisData.hiddenOpportunities.length} hidden opportunities worth
                  investigating.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Section C: Relationship Churn */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5 text-blue-600" />
                <CardTitle>Sphere Intelligence</CardTitle>
              </div>
              <CardDescription>Relationship health across your network</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {diagnosisData.sphereMining ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="p-3 rounded-lg bg-muted text-center">
                      <p className="text-2xl font-bold">{diagnosisData.sphereMining.total_analyzed || 0}</p>
                      <p className="text-xs text-muted-foreground">Contacts Analyzed</p>
                    </div>
                    <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-center">
                      <p className="text-2xl font-bold text-emerald-700">
                        {diagnosisData.sphereMining.high_potential || 0}
                      </p>
                      <p className="text-xs text-emerald-600">High Potential</p>
                    </div>
                    <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-center">
                      <p className="text-2xl font-bold text-amber-700">
                        {diagnosisData.sphereMining.cooling_relationships || 0}
                      </p>
                      <p className="text-xs text-amber-600">Cooling</p>
                    </div>
                    <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-center">
                      <p className="text-2xl font-bold text-red-700">{diagnosisData.sphereMining.at_risk || 0}</p>
                      <p className="text-xs text-red-600">At Risk</p>
                    </div>
                  </div>

                  {/* Top At-Risk Contacts */}
                  {diagnosisData.sphereMining.at_risk_contacts &&
                    diagnosisData.sphereMining.at_risk_contacts.length > 0 && (
                      <div className="space-y-2 pt-4 border-t">
                        <p className="text-sm font-medium text-red-700">Top At-Risk Contacts</p>
                        {diagnosisData.sphereMining.at_risk_contacts.slice(0, 3).map((contact: any, idx: number) => (
                          <div
                            key={contact.id || idx}
                            className="flex items-center justify-between p-2 rounded-lg bg-red-50 border border-red-100"
                          >
                            <div>
                              <p className="font-medium text-sm">{contact.name || "Contact"}</p>
                              <p className="text-xs text-red-600">
                                Last contact: {contact.last_contact || "Unknown"} • {contact.churn_signal || "No recent engagement"}
                              </p>
                            </div>
                            <Link href={`/crm?contactId=${contact.id}`}>
                              <Button variant="outline" size="sm" className="text-red-700 border-red-200">
                                Re-engage
                              </Button>
                            </Link>
                          </div>
                        ))}
                      </div>
                    )}

                  <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-50 border border-blue-200">
                    <AlertCircle className="h-5 w-5 text-blue-600" />
                    <p className="text-sm text-blue-800">
                      Your sphere has {diagnosisData.sphereMining.at_risk || 0} contacts who may be moving but haven't
                      heard from you.
                    </p>
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground text-center py-4">No sphere data available</p>
              )}
            </CardContent>
          </Card>

          {/* Section D: Follow-up Drag */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-purple-600" />
                <CardTitle>Follow-up Performance</CardTitle>
              </div>
              <CardDescription>Response time and coaching insights</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {diagnosisData.coachingInsights ? (
                <>
                  <div className="grid md:grid-cols-2 gap-4">
                    {diagnosisData.coachingInsights.avg_response_time && (
                      <div className="p-4 rounded-lg bg-purple-50 border border-purple-200">
                        <p className="text-sm text-purple-600">Avg Response Time</p>
                        <p className="text-2xl font-bold text-purple-700">
                          {diagnosisData.coachingInsights.avg_response_time}
                        </p>
                      </div>
                    )}
                    {diagnosisData.coachingInsights.follow_up_score && (
                      <div className="p-4 rounded-lg bg-purple-50 border border-purple-200">
                        <p className="text-sm text-purple-600">Follow-up Score</p>
                        <p className="text-2xl font-bold text-purple-700">
                          {diagnosisData.coachingInsights.follow_up_score}%
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Coaching Insights */}
                  {diagnosisData.coachingInsights.insights && diagnosisData.coachingInsights.insights.length > 0 && (
                    <div className="space-y-2 pt-4 border-t">
                      <p className="text-sm font-medium">AI Coaching Insights</p>
                      {diagnosisData.coachingInsights.insights.slice(0, 3).map((insight: any, idx: number) => (
                        <div key={idx} className="p-3 rounded-lg bg-muted">
                          <p className="font-medium text-sm">{insight.issue || insight.title}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {insight.recommendation || insight.action}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Link href="/dashboard/coaching" className="flex-1">
                      <Button variant="outline" className="w-full gap-2">
                        <TrendingUp className="h-4 w-4" />
                        Improve Follow-up
                      </Button>
                    </Link>
                    <Link href="/dashboard/communications/inbox" className="flex-1">
                      <Button variant="outline" className="w-full gap-2">
                        Open Communications
                      </Button>
                    </Link>
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground text-center py-4">No coaching insights available</p>
              )}
            </CardContent>
          </Card>

          {/* Section E: Operational Drag */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-orange-600" />
                <CardTitle>Automation & Operations Health</CardTitle>
              </div>
              <CardDescription>System performance and workflow status</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {diagnosisData.workflowStats ? (
                <>
                  <div className="grid grid-cols-3 gap-4">
                    <div
                      className={`p-4 rounded-lg text-center ${diagnosisData.workflowStats.failed > 0 ? "bg-red-50 border border-red-200" : "bg-muted"}`}
                    >
                      <p className="text-2xl font-bold text-red-700">{diagnosisData.workflowStats.failed || 0}</p>
                      <p className="text-xs text-red-600">Failed</p>
                    </div>
                    <div
                      className={`p-4 rounded-lg text-center ${diagnosisData.workflowStats.paused > 0 ? "bg-amber-50 border border-amber-200" : "bg-muted"}`}
                    >
                      <p className="text-2xl font-bold text-amber-700">{diagnosisData.workflowStats.paused || 0}</p>
                      <p className="text-xs text-amber-600">Paused</p>
                    </div>
                    <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 text-center">
                      <p className="text-2xl font-bold text-emerald-700">
                        {diagnosisData.workflowStats.success_rate || 0}%
                      </p>
                      <p className="text-xs text-emerald-600">Success Rate</p>
                    </div>
                  </div>

                  {(diagnosisData.workflowStats.failed > 0 || diagnosisData.workflowStats.paused > 0) && (
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-orange-50 border border-orange-200">
                      <AlertTriangle className="h-5 w-5 text-orange-600" />
                      <p className="text-sm text-orange-800">
                        {diagnosisData.workflowStats.failed > 0
                          ? `${diagnosisData.workflowStats.failed} failed automations need attention.`
                          : `${diagnosisData.workflowStats.paused} workflows are paused.`}
                      </p>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Link href="/workflows" className="flex-1">
                      <Button variant="outline" className="w-full gap-2">
                        <Zap className="h-4 w-4" />
                        Fix Automations
                      </Button>
                    </Link>
                    <Link href="/dashboard/system" className="flex-1">
                      <Button variant="outline" className="w-full gap-2">
                        Check System Health
                      </Button>
                    </Link>
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground text-center py-4">No workflow stats available</p>
              )}
            </CardContent>
          </Card>

          {/* Section F: Financial Pressure */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-green-600" />
                <CardTitle>Financial Health</CardTitle>
              </div>
              <CardDescription>Pipeline value and financial metrics</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {diagnosisData.valueDashboard ? (
                <>
                  <div className="grid md:grid-cols-3 gap-4">
                    <div className="p-4 rounded-lg bg-green-50 border border-green-200 text-center">
                      <p className="text-sm text-green-600">Pipeline Value</p>
                      <p className="text-2xl font-bold text-green-700">
                        ${(diagnosisData.valueDashboard.pipeline_value || 0).toLocaleString()}
                      </p>
                    </div>
                    <div className="p-4 rounded-lg bg-muted text-center">
                      <p className="text-sm text-muted-foreground">Pending Commissions</p>
                      <p className="text-2xl font-bold">
                        ${(diagnosisData.valueDashboard.pending_commissions || 0).toLocaleString()}
                      </p>
                    </div>
                    <div className="p-4 rounded-lg bg-muted text-center">
                      <p className="text-sm text-muted-foreground">Trust Capital</p>
                      <p className="text-2xl font-bold">{diagnosisData.trustCapital?.score || "N/A"}</p>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Link href="/dashboard/financials/agent" className="flex-1">
                      <Button variant="outline" className="w-full gap-2">
                        <DollarSign className="h-4 w-4" />
                        Open Financials
                      </Button>
                    </Link>
                    <Link href="/dashboard/reports" className="flex-1">
                      <Button variant="outline" className="w-full gap-2">
                        View Reports
                      </Button>
                    </Link>
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground text-center py-4">No financial data available</p>
              )}
            </CardContent>
          </Card>

          {/* Master AI Corrective Summary */}
          <Card className="border-indigo-300 bg-indigo-50/50">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Brain className="h-5 w-5 text-indigo-600" />
                <CardTitle className="text-indigo-900">Business Correction Plan</CardTitle>
              </div>
              <CardDescription className="text-indigo-700">
                AI-generated 30-day action plan based on your diagnosis
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!aiSummary && (
                <Button
                  size="lg"
                  onClick={generateCorrectionPlan}
                  disabled={generatingSummary}
                  className="w-full gap-2 bg-indigo-600 hover:bg-indigo-700"
                >
                  {generatingSummary ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin" />
                      Generating Correction Plan...
                    </>
                  ) : (
                    <>
                      <Brain className="h-5 w-5" />
                      Generate AI Correction Plan
                    </>
                  )}
                </Button>
              )}

              {aiSummary && (
                <div className="space-y-4">
                  <div className="flex justify-end">
                    <Button variant="outline" size="sm" onClick={copyToClipboard} className="gap-2">
                      {copied ? <CheckCircle className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                      {copied ? "Copied!" : "Copy Plan"}
                    </Button>
                  </div>

                  <div className="p-4 rounded-lg bg-white border border-indigo-200 prose prose-sm max-w-none">
                    <div className="whitespace-pre-wrap text-sm">{aiSummary}</div>
                  </div>

                  <div className="flex gap-2">
                    <Link href="/crm" className="flex-1">
                      <Button variant="outline" className="w-full">
                        Open Contacts
                      </Button>
                    </Link>
                    <Link href="/leads" className="flex-1">
                      <Button variant="outline" className="w-full">
                        Open Leads
                      </Button>
                    </Link>
                    <Link href="/dashboard/coaching" className="flex-1">
                      <Button variant="outline" className="w-full">
                        Open Coaching
                      </Button>
                    </Link>
                  </div>

                  {/* Cross-links */}
                  <div className="flex gap-4 pt-2 border-t text-sm">
                    <Link href="/dashboard/reports" className="text-muted-foreground hover:text-foreground transition-colors">
                      View Full Report →
                    </Link>
                    <Link href="/crm" className="text-muted-foreground hover:text-foreground transition-colors">
                      Open CRM →
                    </Link>
                  </div>

                  <Button variant="ghost" onClick={generateCorrectionPlan} disabled={generatingSummary} className="w-full">
                    Regenerate Plan
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
