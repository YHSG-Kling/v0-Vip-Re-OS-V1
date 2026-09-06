"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sparkles, AlertTriangle, TrendingUp, RefreshCw, Lightbulb } from "lucide-react"
// `getVendorRecommendations` is NOT imported here any more — it is a
// per-JOB matcher and its `serviceType` is REQUIRED, which this panel has not
// got. It survives at app/actions/ai-vendor-management.ts:77 and is consumed by
// the booking flow; the same-named bench read used by the marketing panel is a
// DIFFERENT function at app/actions/marketing-package-automation.ts:313.
// This panel asks the portfolio-wide question, which is what
// analyzeVendorPerformance answers — see loadInsights below.
import { analyzeVendorPerformance } from "@/app/actions/ai-vendor-management"

interface AiVendorInsightsPanelProps {
  /**
   * Display/refetch key ONLY — it is NOT sent to the server. The action derives
   * tenant and actor from the SESSION (CLAUDE.md §4); passing this one back
   * would be the body-supplied-identity shape the action was just fixed for.
   */
  brokerageId: string
}

interface Insight {
  id: string
  type: "recommendation" | "warning" | "opportunity"
  title: string
  description: string
  vendorId?: string
  vendorName?: string
}

export function AiVendorInsightsPanel({ brokerageId }: AiVendorInsightsPanelProps) {
  const [insights, setInsights] = useState<Insight[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  async function loadInsights() {
    setLoading(true)
    try {
      // 🚨 WAS: `getVendorRecommendations(brokerageId as any)` — a brokerage id
      // passed as the WHOLE params object, cast through `any` so the compiler
      // could not object. `params.agentId` was therefore `undefined` and the
      // action's own `isValidUUID` gate refused EVERY call, so this panel has
      // only ever rendered the "Expand Vendor Network" placeholder below. The
      // `as any` is what hid it. No argument is passed now: the action reads
      // tenant and actor from the session.
      const result = await analyzeVendorPerformance()

      const aiInsights: Insight[] = []

      if (result.success && (result as any).analysis) {
        const analysis = (result as any).analysis

        // Red flags first — a declining or unreliable vendor is the thing a
        // partners desk needs to see before any upside suggestion.
        ;((analysis.redFlags ?? []) as any[]).forEach((flag: any, idx: number) => {
          aiInsights.push({
            id: `flag-${idx}`,
            type: "warning",
            title: flag.issue || "Vendor Issue",
            description: flag.suggestedAction || flag.issue,
            vendorName: flag.vendorName,
          })
        })

        ;((analysis.recommendations ?? []) as any[]).forEach((rec: any, idx: number) => {
          aiInsights.push({
            id: `rec-${idx}`,
            // "replace" and "decrease_usage" are corrective, not upside.
            type: rec.type === "replace" || rec.type === "decrease_usage"
              ? "warning"
              : rec.type === "increase_usage"
                ? "opportunity"
                : "recommendation",
            title: rec.action || "Vendor Recommendation",
            description: rec.reasoning || rec.action,
            vendorName: rec.vendorName,
          })
        })
      }

      // If no AI insights, add default suggestions
      if (aiInsights.length === 0) {
        aiInsights.push({
          id: "default-1",
          type: "opportunity",
          title: "Expand Vendor Network",
          description: "Consider adding more vendors in high-demand categories to improve service coverage.",
        })
      }

      setInsights(aiInsights.slice(0, 5))
    } catch (error) {
      console.error("Error loading AI insights:", error)
      setInsights([{
        id: "error",
        type: "recommendation",
        title: "AI Analysis Available",
        description: "Click refresh to generate vendor performance insights.",
      }])
    }
    setLoading(false)
  }

  useEffect(() => {
    loadInsights()
  }, [brokerageId])

  async function handleRefresh() {
    setRefreshing(true)
    await loadInsights()
    setRefreshing(false)
  }

  const getInsightIcon = (type: string) => {
    switch (type) {
      case "warning":
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />
      case "opportunity":
        return <TrendingUp className="h-4 w-4 text-green-500" />
      default:
        return <Lightbulb className="h-4 w-4 text-blue-500" />
    }
  }

  const getInsightBadge = (type: string) => {
    switch (type) {
      case "warning":
        return <Badge className="bg-yellow-100 text-yellow-700 dark:bg-yellow-900/20">Action Needed</Badge>
      case "opportunity":
        return <Badge className="bg-green-100 text-green-700 dark:bg-green-900/20">Opportunity</Badge>
      default:
        return <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/20">Suggestion</Badge>
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="h-5 w-5 text-primary" />
            AI Insights
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Sparkles className="h-5 w-5 text-primary" />
              AI Insights
            </CardTitle>
            <CardDescription>AI-powered vendor recommendations</CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {insights.map(insight => (
          <div
            key={insight.id}
            className="flex items-start gap-3 rounded-lg border p-3"
          >
            {getInsightIcon(insight.type)}
            <div className="flex-1 space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{insight.title}</p>
                {getInsightBadge(insight.type)}
              </div>
              <p className="text-xs text-muted-foreground">{insight.description}</p>
              {insight.vendorName && (
                <Badge variant="outline" className="text-xs">
                  {insight.vendorName}
                </Badge>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
