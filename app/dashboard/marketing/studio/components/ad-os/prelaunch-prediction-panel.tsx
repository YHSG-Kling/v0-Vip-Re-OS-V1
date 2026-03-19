"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Progress } from "@/components/ui/progress"
import {
  Zap,
  TrendingUp,
  TrendingDown,
  AlertCircle,
  CheckCircle,
  Lightbulb,
  Loader2,
  BarChart3,
} from "lucide-react"
import { predictPerformanceAction, getUserContextForPrediction } from "@/app/actions/content-prediction"
import type { PredictionData } from "@/components/prediction-widget"

type ContentType = "social_post" | "newsletter" | "blog_post" | "ad_creative" | "video_script"
type Platform = "facebook" | "instagram" | "linkedin" | "email" | "web"

interface PrelaunchPredictionPanelProps {
  agentId: string
  listingId?: string
}

const CONTENT_TYPES: Array<{ id: ContentType; label: string }> = [
  { id: "social_post", label: "Social Post" },
  { id: "ad_creative", label: "Ad Creative" },
  { id: "video_script", label: "Video Script" },
  { id: "newsletter", label: "Email/Newsletter" },
  { id: "blog_post", label: "Blog Post" },
]

const PLATFORMS: Array<{ id: Platform; label: string }> = [
  { id: "facebook", label: "Facebook" },
  { id: "instagram", label: "Instagram" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "email", label: "Email" },
  { id: "web", label: "Website" },
]

export function PrelaunchPredictionPanel({ agentId, listingId }: PrelaunchPredictionPanelProps) {
  const [contentText, setContentText] = useState("")
  const [contentType, setContentType] = useState<ContentType>("social_post")
  const [platform, setPlatform] = useState<Platform>("facebook")
  const [isPredicting, setIsPredicting] = useState(false)
  const [prediction, setPrediction] = useState<PredictionData | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handlePredict() {
    if (!contentText.trim()) return

    setIsPredicting(true)
    setError(null)
    setPrediction(null)

    try {
      const userContext = await getUserContextForPrediction()
      if (!userContext.success || !userContext.userId || !userContext.brokerageId) {
        setError("Unable to get user context for prediction")
        return
      }

      const result = await predictPerformanceAction({
        brokerageId: userContext.brokerageId,
        userId: userContext.userId,
        contentType,
        sourceTable: "marketing_assets",
        sourceId: `preview-${Date.now()}`,
        contentText,
        platform,
      })

      if (result.success && result.prediction) {
        setPrediction(result.prediction)
      } else {
        setError(result.error || "Prediction failed")
      }
    } catch (err) {
      console.error("Prediction error:", err)
      setError("Failed to generate prediction")
    } finally {
      setIsPredicting(false)
    }
  }

  function getScoreColor(score: number): string {
    if (score >= 80) return "text-green-600"
    if (score >= 60) return "text-amber-600"
    return "text-red-600"
  }

  function getScoreBg(score: number): string {
    if (score >= 80) return "bg-green-100 dark:bg-green-950/30"
    if (score >= 60) return "bg-amber-100 dark:bg-amber-950/30"
    return "bg-red-100 dark:bg-red-950/30"
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-violet-600" />
          Prelaunch Prediction
        </CardTitle>
        <CardDescription>
          Predict content performance before publishing
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Content Input */}
        <div className="space-y-2">
          <Label>Content to Analyze</Label>
          <Textarea
            value={contentText}
            onChange={(e) => setContentText(e.target.value)}
            placeholder="Paste your ad copy, social post, or content to predict performance..."
            className="min-h-[100px]"
          />
        </div>

        {/* Content Type & Platform */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Content Type</Label>
            <Select value={contentType} onValueChange={(v) => setContentType(v as ContentType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTENT_TYPES.map((type) => (
                  <SelectItem key={type.id} value={type.id}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Platform</Label>
            <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORMS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Predict Button */}
        <Button
          onClick={handlePredict}
          disabled={isPredicting || !contentText.trim()}
          className="w-full bg-violet-600 hover:bg-violet-700"
        >
          {isPredicting ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Analyzing Content...
            </>
          ) : (
            <>
              <Zap className="h-4 w-4 mr-2" />
              Predict Performance
            </>
          )}
        </Button>

        {/* Error */}
        {error && (
          <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800">
            <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
              <AlertCircle className="h-4 w-4" />
              <p className="text-sm">{error}</p>
            </div>
          </div>
        )}

        {/* Prediction Results */}
        {prediction && (
          <div className="space-y-4 pt-4 border-t">
            {/* Overall Score */}
            <div className={`p-4 rounded-lg ${getScoreBg(prediction.predicted_score)}`}>
              <div className="flex items-center justify-between mb-2">
                <p className="font-medium">Predicted Engagement Score</p>
                <span className={`text-2xl font-bold ${getScoreColor(prediction.predicted_score)}`}>
                  {prediction.predicted_score}/100
                </span>
              </div>
              <Progress value={prediction.predicted_score} className="h-2" />
            </div>

            {/* Channel Prediction */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground">Strongest Channel</p>
                <div className="flex items-center gap-1 mt-1">
                  <TrendingUp className="h-4 w-4 text-green-600" />
                  <p className="font-medium capitalize">
                    {prediction.channel_prediction?.best_channel || platform}
                  </p>
                </div>
              </div>
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground">Confidence Level</p>
                <p className="font-medium capitalize mt-1">{prediction.confidence_level}</p>
              </div>
            </div>

            {/* Weak Spots */}
            {prediction.suggested_improvements && prediction.suggested_improvements.length > 0 && (
              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                <div className="flex items-center gap-2 mb-2">
                  <AlertCircle className="h-4 w-4 text-amber-600" />
                  <p className="font-medium text-sm text-amber-700 dark:text-amber-300">Areas to Improve</p>
                </div>
                <ul className="space-y-1">
                  {prediction.suggested_improvements.slice(0, 3).map((improvement, i) => (
                    <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                      <span className="text-amber-600">•</span>
                      {improvement}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Recommendations */}
            {prediction.recommended_timing && (
              <div className="p-3 rounded-lg bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800">
                <div className="flex items-center gap-2 mb-2">
                  <Lightbulb className="h-4 w-4 text-violet-600" />
                  <p className="font-medium text-sm text-violet-700 dark:text-violet-300">
                    Recommendation
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">
                  Best time to post: <span className="font-medium">{prediction.recommended_timing}</span>
                </p>
              </div>
            )}

            {/* Verdict Badge */}
            <div className="flex justify-center">
              <Badge
                variant={prediction.predicted_score >= 70 ? "default" : "secondary"}
                className={`px-4 py-1 ${
                  prediction.predicted_score >= 70
                    ? "bg-green-600"
                    : prediction.predicted_score >= 50
                      ? "bg-amber-600"
                      : "bg-red-600"
                }`}
              >
                {prediction.predicted_score >= 70 ? (
                  <>
                    <CheckCircle className="h-4 w-4 mr-1" />
                    Ready to Launch
                  </>
                ) : prediction.predicted_score >= 50 ? (
                  <>
                    <AlertCircle className="h-4 w-4 mr-1" />
                    Consider Improvements
                  </>
                ) : (
                  <>
                    <TrendingDown className="h-4 w-4 mr-1" />
                    Needs Work
                  </>
                )}
              </Badge>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
