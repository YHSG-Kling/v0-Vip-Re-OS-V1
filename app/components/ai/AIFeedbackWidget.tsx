"use client"

import { useState } from "react"
import { ThumbsUp, ThumbsDown, CheckCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

export type FeedbackSourceSystem =
  | "daily_briefing"
  | "coaching_report"
  | "market_insight"
  | "behavioral_pattern"
  | "smart_suggestion"
  | "isa_response"
  | "content_generation"
  | "intent_classifier"

interface AIFeedbackWidgetProps {
  sourceSystem: FeedbackSourceSystem
  sourceRecordId: string
  sourceRecordType: string
  aiOutputSnapshot: string
  onFeedback?: (rating: 1 | -1) => void
}

export function AIFeedbackWidget({
  sourceSystem,
  sourceRecordId,
  sourceRecordType,
  aiOutputSnapshot,
  onFeedback,
}: AIFeedbackWidgetProps) {
  const [submitted, setSubmitted] = useState(false)
  const [selectedRating, setSelectedRating] = useState<1 | -1 | null>(null)
  const [showFeedbackText, setShowFeedbackText] = useState(false)
  const [feedbackText, setFeedbackText] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleRating = async (rating: 1 | -1) => {
    if (submitted || isSubmitting) return

    setSelectedRating(rating)

    // If thumbs down, show textarea for additional feedback
    if (rating === -1) {
      setShowFeedbackText(true)
      return
    }

    // For thumbs up, submit immediately
    await submitFeedback(rating, "")
  }

  const submitFeedback = async (rating: 1 | -1, text: string) => {
    setIsSubmitting(true)

    try {
      const response = await fetch("/api/intelligence/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceSystem,
          sourceRecordId,
          sourceRecordType,
          aiOutputSnapshot: aiOutputSnapshot?.slice(0, 200) || "",
          rating,
          feedbackText: text || undefined,
        }),
      })

      if (response.ok) {
        setSubmitted(true)
        onFeedback?.(rating)
      }
    } catch (error) {
      console.error("Failed to submit feedback:", error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSubmitWithText = async () => {
    if (selectedRating) {
      await submitFeedback(selectedRating, feedbackText)
    }
  }

  if (submitted) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
        <CheckCircle className="h-4 w-4 text-green-500" />
        <span>Thanks for your feedback</span>
        {selectedRating === 1 ? (
          <ThumbsUp className="h-4 w-4 text-green-500 fill-green-500" />
        ) : (
          <ThumbsDown className="h-4 w-4 text-red-500 fill-red-500" />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-sm">
        <span className="text-muted-foreground">Was this helpful?</span>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 w-7 p-0",
            selectedRating === 1 && "bg-green-100 text-green-600"
          )}
          onClick={() => handleRating(1)}
          disabled={isSubmitting}
        >
          <ThumbsUp
            className={cn(
              "h-4 w-4",
              selectedRating === 1 && "fill-green-500"
            )}
          />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 w-7 p-0",
            selectedRating === -1 && "bg-red-100 text-red-600"
          )}
          onClick={() => handleRating(-1)}
          disabled={isSubmitting}
        >
          <ThumbsDown
            className={cn(
              "h-4 w-4",
              selectedRating === -1 && "fill-red-500"
            )}
          />
        </Button>
      </div>

      {showFeedbackText && (
        <div className="space-y-2">
          <Textarea
            placeholder="Tell us more (optional)"
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            className="h-20 text-sm"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleSubmitWithText}
              disabled={isSubmitting}
            >
              {isSubmitting ? "Submitting..." : "Submit"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => submitFeedback(-1, "")}
              disabled={isSubmitting}
            >
              Skip
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
