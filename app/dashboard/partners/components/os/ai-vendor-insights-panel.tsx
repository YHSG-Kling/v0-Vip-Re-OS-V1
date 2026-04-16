"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sparkles, AlertTriangle, TrendingUp, RefreshCw, Lightbulb } from "lucide-react"
import { getVendorRecommendations, analyzeVendorPerformance } from "@/app/actions/ai-vendor-management"

interface AiVendorInsightsPanelProps {
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
      // Get AI recommendations
      const result = await getVendorRecommendations(brokerageId as any)

      const aiInsights: Insight[] = []

      if (result.success && (result as any).recommendations) {
        ((result as any).recommendations as any[]).forEach((rec: any, idx: number) => {
          aiInsights.push({
            id: `rec-${idx}`,
            type: rec.priority === "high" ? "warning" : "recommendation",
            title: rec.title || "Vendor Recommendation",
            description: rec.description || rec.message,
            vendorId: rec.vendorId,
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
