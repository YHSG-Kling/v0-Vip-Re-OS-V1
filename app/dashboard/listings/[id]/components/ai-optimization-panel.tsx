"use client"

/**
 * AiOptimizationPanel — surfaces AI listing optimization recommendations from
 * the ai_listing_optimizations table (written per-category by
 * app/actions/marketing-package-automation.ts: pricing, photos, description,
 * marketing channels, timing).
 *
 * The lifecycle page loads the rows keyed on the listing's transaction_id and
 * passes them in. The panel also OWNS the generate control — the table had a
 * reader and no writer anywhere in the product, so the card could only ever
 * render nothing.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sparkles, Loader2 } from "lucide-react"
import { generateListingOptimizations } from "@/app/actions/marketing-package-automation"

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

export function AiOptimizationPanel({
  optimizations,
  transactionId,
}: {
  optimizations: AiListingOptimizationRow[]
  /** Null when the listing has no transaction yet — recommendations key on it. */
  transactionId?: string | null
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [healthScore, setHealthScore] = useState<number | null>(null)

  // Without a transaction there is nothing to key recommendations to, and with
  // no rows and no way to generate them the card is noise — stay hidden.
  if (optimizations.length === 0 && !transactionId) return null

  const handleGenerate = () => {
    if (!transactionId) return
    setError(null)
    startTransition(async () => {
      const result = await generateListingOptimizations(transactionId)
      if (!result.success) {
        setError(result.error ?? "Could not generate recommendations")
        return
      }
      const score = (result.data as { overall_health_score?: number } | undefined)?.overall_health_score
      setHealthScore(typeof score === "number" ? score : null)
      // The rows are written server-side; re-render the page to read them back.
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-violet-600" />
            <div>
              <CardTitle className="text-base">AI Optimization</CardTitle>
              <CardDescription>Recommendations to improve this listing&apos;s performance</CardDescription>
            </div>
          </div>
          {transactionId && (
            <Button size="sm" variant="outline" className="shrink-0" disabled={isPending} onClick={handleGenerate}>
              {isPending ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  Analyzing…
                </>
              ) : optimizations.length === 0 ? (
                "Generate"
              ) : (
                "Regenerate"
              )}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {healthScore !== null && (
          <p className="text-sm text-muted-foreground">
            Overall listing health score: <span className="font-medium text-foreground">{healthScore}/100</span>
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {optimizations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recommendations yet — generate a set to see pricing, photo, description, channel and
            timing suggestions for this listing.
          </p>
        ) : (
          optimizations.map((opt) => (
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
          ))
        )}
      </CardContent>
    </Card>
  )
}
