"use client"

/**
 * AiInsightsFeedCard — surfaces the latest rows from the ai_insights table
 * (written by app/actions/ai-predictions.ts: risk flags, hidden opportunities,
 * learned preferences, churn/equity alerts).
 *
 * Presentational — the agent dashboard page loads the rows alongside its
 * sibling queries and passes them in. Writers store confidence inside the
 * estimated_impact jsonb payload (confidence / confidenceScore / probability),
 * so we extract it from there when present.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Lightbulb } from "lucide-react"

export interface AiInsightRow {
  id: string
  insight_type: string
  insight_title: string
  insight_description: string | null
  priority: string | null
  estimated_impact: Record<string, any> | null
  created_at: string
}

const TYPE_BADGE: Record<string, string> = {
  risk: "bg-red-100 text-red-700 border-red-200",
  opportunity: "bg-emerald-100 text-emerald-700 border-emerald-200",
  learned_preferences: "bg-violet-100 text-violet-700 border-violet-200",
}

function extractConfidence(impact: Record<string, any> | null): number | null {
  const raw = impact?.confidence ?? impact?.confidenceScore ?? impact?.probability
  const num = typeof raw === "string" ? parseFloat(raw) : raw
  if (typeof num !== "number" || isNaN(num)) return null
  // Writers store 0-1 fractions; tolerate 0-100 values too
  return num <= 1 ? Math.round(num * 100) : Math.round(num)
}

export function AiInsightsFeedCard({ insights }: { insights: AiInsightRow[] }) {
  if (insights.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-amber-500" />
          AI Insights
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {insights.map((insight) => {
          const confidence = extractConfidence(insight.estimated_impact)
          return (
            <div key={insight.id} className="flex items-start gap-3 border-b last:border-b-0 pb-3 last:pb-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge
                    variant="outline"
                    className={`text-[10px] capitalize ${TYPE_BADGE[insight.insight_type] ?? "bg-blue-100 text-blue-700 border-blue-200"}`}
                  >
                    {insight.insight_type.replace(/_/g, " ")}
                  </Badge>
                  <p className="text-sm font-medium truncate">{insight.insight_title}</p>
                </div>
                {insight.insight_description && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {insight.insight_description}
                  </p>
                )}
              </div>
              <div className="shrink-0 text-right">
                {confidence !== null && (
                  <p className="text-xs font-semibold text-foreground">{confidence}%</p>
                )}
                <p className="text-[10px] text-muted-foreground">
                  {new Date(insight.created_at).toLocaleDateString([], { month: "short", day: "numeric" })}
                </p>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
