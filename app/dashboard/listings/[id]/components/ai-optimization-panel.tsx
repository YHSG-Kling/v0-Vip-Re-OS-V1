/**
 * AiOptimizationPanel — surfaces AI listing optimization recommendations from
 * the ai_listing_optimizations table (written per-category by
 * app/actions/marketing-package-automation.ts: pricing, photos, description,
 * marketing channels, timing).
 *
 * Presentational server component — the lifecycle page loads the rows keyed
 * on the listing's transaction_id and passes them in.
 */

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Sparkles } from "lucide-react"

export interface AiListingOptimizationRow {
  id: string
  optimization_category: string | null
  recommendation: string | null
  reasoning: string | null
  priority: string | null
  estimated_impact: string | null
  status: string | null
  generated_at: string | null
}

const PRIORITY_BADGE: Record<string, string> = {
  high: "bg-red-100 text-red-700 border-red-200",
  medium: "bg-amber-100 text-amber-700 border-amber-200",
  low: "bg-green-100 text-green-700 border-green-200",
}

export function AiOptimizationPanel({ optimizations }: { optimizations: AiListingOptimizationRow[] }) {
  if (optimizations.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-violet-600" />
          <div>
            <CardTitle className="text-base">AI Optimization</CardTitle>
            <CardDescription>Recommendations to improve this listing&apos;s performance</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {optimizations.map((opt) => (
          <div key={opt.id} className="rounded-lg border p-3">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <Badge variant="secondary" className="text-xs capitalize">
                {opt.optimization_category?.replace(/_/g, " ") ?? "General"}
              </Badge>
              {opt.priority && (
                <Badge
                  variant="outline"
                  className={`text-[10px] capitalize ${PRIORITY_BADGE[opt.priority.toLowerCase()] ?? ""}`}
                >
                  {opt.priority}
                </Badge>
              )}
              {opt.status && opt.status !== "pending" && (
                <Badge variant="outline" className="text-[10px] capitalize">
                  {opt.status}
                </Badge>
              )}
            </div>
            {opt.recommendation && <p className="text-sm font-medium">{opt.recommendation}</p>}
            {opt.reasoning && (
              <p className="text-xs text-muted-foreground mt-1">{opt.reasoning}</p>
            )}
            {opt.estimated_impact && (
              <p className="text-xs text-violet-700 mt-1">Impact: {opt.estimated_impact}</p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
