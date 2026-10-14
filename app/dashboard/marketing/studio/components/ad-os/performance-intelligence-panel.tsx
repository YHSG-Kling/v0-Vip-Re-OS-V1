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
import { Loader2, BarChart3, RefreshCw, Clock, AlertCircle, TrendingUp, TrendingDown, Target } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { loadRecentPredictions } from "./ad-os-actions"
import { logActualPerformanceAction } from "@/app/actions/content-prediction"
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

const EMPTY_ACTUALS = { likes: "", comments: "", shares: "", impressions: "", clicks: "" }

export function PerformanceIntelligencePanel({ brokerageId, initialPredictions = [] }: Props) {
  const [predictions, setPredictions] = useState<Prediction[]>(initialPredictions)
  const [isPending, startTransition] = useTransition()
  const [hasLoaded, setHasLoaded] = useState(initialPredictions.length > 0)
  // ── THE OUTCOME HALF ────────────────────────────────────────────────────────
  // A prediction nobody grades can never be shown to be right or wrong. These
  // numbers write prediction_accuracy_log — the ledger the platform's
  // prediction-accuracy rail (and the earned-autonomy gate behind it) reads to
  // decide whether the content predictor has earned trust. Entered by hand
  // because the platform does not receive per-post metrics from every network.
  const [loggingId, setLoggingId] = useState<string | null>(null)
  const [actuals, setActuals] = useState(EMPTY_ACTUALS)
  const [loggedIds, setLoggedIds] = useState<string[]>([])
  const { toast } = useToast()

  function handleLogActuals(predictionId: string) {
    const num = (v: string) => (v.trim() === "" ? undefined : Number(v))
    const impressions = num(actuals.impressions)
    if (impressions === undefined || !Number.isFinite(impressions) || impressions < 1) {
      toast({
        title: "Impressions are required",
        description: "Engagement and click rates are computed against reach — without it there is nothing to divide by.",
        variant: "destructive",
      })
      return
    }
    startTransition(async () => {
      const res = await logActualPerformanceAction({
        predictionId,
        likes: num(actuals.likes),
        comments: num(actuals.comments),
        shares: num(actuals.shares),
        impressions,
        clicks: num(actuals.clicks),
      })
      if (!res.success) {
        toast({ title: "Could not log the result", description: res.error, variant: "destructive" })
        return
      }
      setLoggedIds((prev) => [...prev, predictionId])
      setLoggingId(null)
      setActuals(EMPTY_ACTUALS)
      toast({ title: "Logged — this prediction is now graded against reality." })
    })
  }

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

                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-xs text-muted-foreground/60">
                    {new Date(p.created_at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                  {loggedIds.includes(p.id) ? (
                    <span className="text-xs text-emerald-700">Actual result logged</span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => {
                        setLoggingId(loggingId === p.id ? null : p.id)
                        setActuals(EMPTY_ACTUALS)
                      }}
                    >
                      <Target className="h-3 w-3" />
                      Log actual result
                    </Button>
                  )}
                </div>

                {loggingId === p.id && !loggedIds.includes(p.id) && (
                  <div className="rounded-md border bg-muted/40 p-3 space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Enter what this piece actually did once the numbers settled. The delta between the
                      predicted score and the real one is what the platform&apos;s accuracy rail is measured on.
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                      {([
                        ["impressions", "Impressions *"],
                        ["likes", "Likes"],
                        ["comments", "Comments"],
                        ["shares", "Shares"],
                        ["clicks", "Clicks"],
                      ] as const).map(([key, label]) => (
                        <div key={key} className="space-y-1">
                          <Label className="text-[11px]">{label}</Label>
                          <Input
                            type="number"
                            min={0}
                            inputMode="numeric"
                            className="h-8 text-sm"
                            value={actuals[key]}
                            onChange={(e) => setActuals((prev) => ({ ...prev, [key]: e.target.value }))}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" className="h-7 text-xs" disabled={isPending} onClick={() => handleLogActuals(p.id)}>
                        {isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                        Save result
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        disabled={isPending}
                        onClick={() => setLoggingId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
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
