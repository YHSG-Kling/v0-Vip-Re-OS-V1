"use client"

// ============================================================
// PANEL A – Pre-Launch Intelligence
// Predicts performance + evaluates readiness before publishing.
// ============================================================

import { useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2, Zap, TrendingUp, AlertTriangle, CheckCircle, XCircle, Clock } from "lucide-react"
import { runPrelaunchCheck } from "./ad-os-actions"
import type { ContentType } from "@/lib/content/performance-predictor"

interface Props {
  agentId: string
}

const CONTENT_TYPES: { value: ContentType; label: string }[] = [
  { value: "social_post", label: "Social Post" },
  { value: "newsletter", label: "Email / Newsletter" },
  { value: "ad_creative", label: "Ad Creative" },
  { value: "blog_post", label: "Blog Post" },
  { value: "listing_description", label: "Listing Description" },
  { value: "video_script", label: "Video Script" },
]

const PLATFORMS = [
  { value: "facebook", label: "Facebook" },
  { value: "instagram", label: "Instagram" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "google_ads", label: "Google Ads" },
  { value: "email", label: "Email" },
  { value: "sms", label: "SMS" },
]

type ReadinessStatus = "ready" | "blocked" | "needs_review"

function ReadinessBadge({ status }: { status: ReadinessStatus }) {
  if (status === "ready") {
    return (
      <Badge className="bg-green-100 text-green-800 border-green-200 flex items-center gap-1">
        <CheckCircle className="h-3 w-3" />
        Ready to Launch
      </Badge>
    )
  }
  if (status === "blocked") {
    return (
      <Badge className="bg-red-100 text-red-800 border-red-200 flex items-center gap-1">
        <XCircle className="h-3 w-3" />
        Blocked
      </Badge>
    )
  }
  return (
    <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200 flex items-center gap-1">
      <AlertTriangle className="h-3 w-3" />
      Needs Review
    </Badge>
  )
}

function ScoreRing({ score }: { score: number }) {
  const color =
    score >= 70 ? "text-green-600" : score >= 45 ? "text-yellow-600" : "text-red-600"
  const bg =
    score >= 70 ? "bg-green-50" : score >= 45 ? "bg-yellow-50" : "bg-red-50"
  return (
    <div className={`flex flex-col items-center justify-center rounded-full w-24 h-24 ${bg} border-2 ${score >= 70 ? "border-green-200" : score >= 45 ? "border-yellow-200" : "border-red-200"}`}>
      <span className={`text-3xl font-bold ${color}`}>{score}</span>
      <span className="text-xs text-muted-foreground">/100</span>
    </div>
  )
}

export function PrelaunchPredictionPanel({ agentId }: Props) {
  const [contentText, setContentText] = useState("")
  const [contentType, setContentType] = useState<ContentType>("social_post")
  const [platform, setPlatform] = useState("facebook")
  const [isRunning, setIsRunning] = useState(false)
  const [result, setResult] = useState<{
    prediction: {
      predicted_score: number
      predicted_ctr: number
      predicted_engagement_rate: number
      recommended_publish_window: { day: string; hour: number; timezone: string }
      rationale: string
      confidence: "low" | "medium" | "high"
    } | null
    readiness: {
      readiness_status: "ready" | "blocked"
      blocking_reasons?: string[]
      ready_for_channels?: string[]
    } | null
    predictionError: string | null
    readinessError: string | null
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleRun() {
    if (!contentText.trim()) return
    setIsRunning(true)
    setResult(null)
    setError(null)

    try {
      const res = await runPrelaunchCheck({
        contentText: contentText.trim(),
        contentType,
        platform,
      })
      if (!res.success) {
        setError(res.error ?? "Check failed")
      } else {
        setResult(res as any)
      }
    } catch (err) {
      setError("Unexpected error — please try again")
    } finally {
      setIsRunning(false)
    }
  }

  const readinessStatus: ReadinessStatus =
    result?.readiness?.readiness_status === "ready"
      ? "ready"
      : result?.readiness?.blocking_reasons?.length
      ? "blocked"
      : "needs_review"

  return (
    <Card className="border-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-violet-600" />
          Pre-Launch Intelligence
        </CardTitle>
        <CardDescription>
          Predict performance and check readiness before publishing any campaign content.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Inputs */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Content Type</Label>
            <Select value={contentType} onValueChange={(v) => setContentType(v as ContentType)}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTENT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Platform</Label>
            <Select value={platform} onValueChange={setPlatform}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORMS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Content to Analyze</Label>
          <Textarea
            placeholder="Paste your campaign content here..."
            value={contentText}
            onChange={(e) => setContentText(e.target.value)}
            className="min-h-[90px] text-sm resize-none"
          />
        </div>

        <Button
          onClick={handleRun}
          disabled={isRunning || !contentText.trim()}
          className="w-full bg-violet-600 hover:bg-violet-700"
        >
          {isRunning ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Analyzing...
            </>
          ) : (
            <>
              <TrendingUp className="mr-2 h-4 w-4" />
              Predict Performance Before Launch
            </>
          )}
        </Button>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-md p-2">{error}</p>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-4 border-t pt-4">
            {/* Readiness badge */}
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Content Readiness</span>
              <ReadinessBadge status={readinessStatus} />
            </div>

            {result.readiness?.blocking_reasons && result.readiness.blocking_reasons.length > 0 && (
              <div className="rounded-md bg-red-50 p-2 space-y-1">
                {result.readiness.blocking_reasons.map((r, i) => (
                  <p key={i} className="text-xs text-red-700">
                    {r}
                  </p>
                ))}
              </div>
            )}

            {/* Performance score */}
            {result.prediction && (
              <div className="flex items-start gap-4">
                <ScoreRing score={result.prediction.predicted_score} />
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="text-xs">
                      Confidence: {result.prediction.confidence}
                    </Badge>
                    <Badge variant="outline" className="flex items-center gap-1 text-xs">
                      <Clock className="h-3 w-3" />
                      Best: {result.prediction.recommended_publish_window.day}{" "}
                      {result.prediction.recommended_publish_window.hour}:00
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded bg-muted/50 p-1.5">
                      <p className="text-muted-foreground">Est. CTR</p>
                      <p className="font-semibold">
                        {(result.prediction.predicted_ctr * 100).toFixed(2)}%
                      </p>
                    </div>
                    <div className="rounded bg-muted/50 p-1.5">
                      <p className="text-muted-foreground">Engagement</p>
                      <p className="font-semibold">
                        {(result.prediction.predicted_engagement_rate * 100).toFixed(3)}%
                      </p>
                    </div>
                  </div>
                  {result.prediction.rationale && (
                    <p className="text-xs text-muted-foreground italic leading-relaxed">
                      AI says: {result.prediction.rationale}
                    </p>
                  )}
                </div>
              </div>
            )}

            {result.predictionError && (
              <p className="text-xs text-yellow-700 bg-yellow-50 rounded p-2">
                Prediction unavailable: {result.predictionError}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
