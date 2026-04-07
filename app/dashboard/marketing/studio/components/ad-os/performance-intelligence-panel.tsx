"use client"

// ============================================================
// PERFORMANCE INTELLIGENCE PANEL
// Shows recent content_performance_predictions rows.
// Agents can see prediction score, confidence, recommended
// publish window, and rationale per content piece.
// ============================================================

import { useState, useTransition } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, BarChart3, RefreshCw, Clock, AlertCircle, TrendingUp, TrendingDown } from "lucide-react"
import { loadRecentPredictions } from "./ad-os-actions"
import { useToast } from "@/hooks/use-toast"

// ─── Types ────────────────────────────────────────────────────────────────────

interface Prediction {
  id: string
  content_type: string
  predicted_score: number
  confidence: string | null
  rationale: string | null
  recommended_publish_window: string | null
  created_at: string
}

interface Props {
  brokerageId: string
  initialPredictions?: Prediction[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function scoreColor(score: number) {
  if (score >= 75) return "text-emerald-700"
  if (score >= 50) return "text-amber-600"
  return "text-destructive"
}

function scoreBadge(score: number) {
  if (score >= 75) return "bg-emerald-100 text-emerald-800 border-emerald-200"
  if (score >= 50) return "bg-amber-100 text-amber-800 border-amber-200"
  return "bg-red-100 text-red-800 border-red-200"
}

function confidenceLabel(confidence: string | null) {
  if (!confidence) return null
  return confidence.charAt(0).toUpperCase() + confidence.slice(1)
}

function formatContentType(ct: string) {
  return ct.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PerformanceIntelligencePanel({ brokerageId, initialPredictions = [] }: Props) {
  const [predictions, setPredictions] = useState<Prediction[]>(initialPredictions)
  const [isPending, startTransition] = useTransition()
  const [hasLoaded, setHasLoaded] = useState(initialPredictions.length > 0)
  const { toast } = useToast()

  function handleLoad() {
    startTransition(async () => {
      const res = await loadRecentPredictions(brokerageId)
      if (res.success) {
        setPredictions(res.predictions as Prediction[])
        setHasLoaded(true)
        if (res.predictions.length === 0) {
          toast({ title: "No predictions found yet — run a Pre-Launch Check first." })
        }
      } else {
        toast({
          title: "Could not load predictions",
          description: res.error,
          variant: "destructive",
        })
      }
    })
  }

  const avgScore =
    predictions.length > 0
      ? Math.round(predictions.reduce((s, p) => s + (p.predicted_score ?? 0), 0) / predictions.length)
      : null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-indigo-600" />
              Performance Intelligence
            </CardTitle>
            <CardDescription>
              Recent AI predictions for your content — score, confidence, and best publish window.
            </CardDescription>
          </div>
          {avgScore !== null && (
            <div className="text-right shrink-0">
              <p className="text-xs text-muted-foreground">Avg Score</p>
              <p className={`text-2xl font-bold ${scoreColor(avgScore)}`}>{avgScore}</p>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!hasLoaded ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <BarChart3 className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground max-w-xs">
              Load your recent content predictions to see engagement scores, confidence ratings, and optimal
              publish windows.
            </p>
            <Button onClick={handleLoad} disabled={isPending}>
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Loading...
                </>
              ) : (
                <>
                  <BarChart3 className="h-4 w-4 mr-2" />
                  Load Predictions
                </>
              )}
            </Button>
          </div>
        ) : predictions.length === 0 ? (
          <div className="flex items-start gap-2 text-sm text-muted-foreground py-4">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            No predictions yet. Run a Pre-Launch Check on your next campaign to generate one.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {predictions.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-border p-4 space-y-3"
              >
                {/* Header row */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{formatContentType(p.content_type)}</span>
                    {p.confidence && (
                      <Badge variant="outline" className="text-xs">
                        {confidenceLabel(p.confidence)} confidence
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {(p.predicted_score ?? 0) >= 60 ? (
                      <TrendingUp className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <TrendingDown className="h-3.5 w-3.5 text-red-500" />
                    )}
                    <Badge className={`text-xs border ${scoreBadge(p.predicted_score ?? 0)}`}>
                      {p.predicted_score ?? "—"} / 100
                    </Badge>
                  </div>
                </div>

                {/* Publish window */}
                {p.recommended_publish_window && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3 shrink-0" />
                    Best window: {p.recommended_publish_window}
                  </div>
                )}

                {/* Rationale */}
                {p.rationale && (
                  <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">
                    {p.rationale}
                  </p>
                )}

                <p className="text-xs text-muted-foreground/60">
                  {new Date(p.created_at).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </p>
              </div>
            ))}

            {/* Refresh */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLoad}
              disabled={isPending}
              className="self-start h-7 text-xs gap-1.5"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
