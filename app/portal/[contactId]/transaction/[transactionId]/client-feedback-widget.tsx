"use client"

import { useState } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { submitClientFeedback } from "@/app/actions/multi-persona"
import { Star, CheckCircle2, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

interface ClientFeedbackWidgetProps {
  contactId: string
  transactionId: string
  agentId: string
}

const CATEGORIES = [
  { key: "communication", label: "Communication" },
  { key: "responsiveness", label: "Responsiveness" },
  { key: "market_knowledge", label: "Market Knowledge" },
  { key: "negotiation", label: "Negotiation" },
  { key: "overall_experience", label: "Overall Experience" },
]

export function ClientFeedbackWidget({ contactId, transactionId, agentId }: ClientFeedbackWidgetProps) {
  const [rating, setRating] = useState(0)
  const [hovered, setHovered] = useState(0)
  const [reviewText, setReviewText] = useState("")
  const [wouldRecommend, setWouldRecommend] = useState<boolean | null>(null)
  const [categoryRatings, setCategoryRatings] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  function setCategoryRating(key: string, value: number) {
    setCategoryRatings((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (rating === 0 || wouldRecommend === null) return

    setLoading(true)
    try {
      await submitClientFeedback({
        contactId,
        transactionId,
        agentId,
        rating,
        reviewText: reviewText.trim(),
        categories: categoryRatings,
        wouldRecommend,
      })
      setSubmitted(true)
    } catch {
      // silently fail — the portal experience should never block on feedback errors
    } finally {
      setLoading(false)
    }
  }

  if (submitted) {
    return (
      <Card className="p-6">
        <div className="flex flex-col items-center text-center gap-3 py-4">
          <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-950/30 flex items-center justify-center">
            <CheckCircle2 className="w-6 h-6 text-green-600" />
          </div>
          <h3 className="font-semibold text-lg">Thank you for your feedback!</h3>
          <p className="text-sm text-muted-foreground max-w-xs">
            Your review helps us improve and helps future clients find the right agent.
          </p>
        </div>
      </Card>
    )
  }

  return (
    <Card className="p-6">
      <h2 className="text-xl font-semibold mb-1">Share Your Experience</h2>
      <p className="text-sm text-muted-foreground mb-5">
        How was working with your agent? Your feedback is private until approved.
      </p>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Star Rating */}
        <div className="space-y-2">
          <Label>Overall Rating</Label>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => setRating(star)}
                onMouseEnter={() => setHovered(star)}
                onMouseLeave={() => setHovered(0)}
                className="focus:outline-none"
                aria-label={`Rate ${star} star${star !== 1 ? "s" : ""}`}
              >
                <Star
                  className={cn(
                    "w-8 h-8 transition-colors",
                    (hovered || rating) >= star
                      ? "fill-amber-400 text-amber-400"
                      : "text-muted-foreground",
                  )}
                />
              </button>
            ))}
          </div>
        </div>

        {/* Category Ratings */}
        <div className="space-y-3">
          <Label>Rate Specific Areas</Label>
          {CATEGORIES.map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground w-40">{label}</span>
              <div className="flex gap-0.5">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => setCategoryRating(key, star)}
                    className="focus:outline-none"
                    aria-label={`Rate ${label} ${star} star${star !== 1 ? "s" : ""}`}
                  >
                    <Star
                      className={cn(
                        "w-5 h-5 transition-colors",
                        (categoryRatings[key] ?? 0) >= star
                          ? "fill-amber-400 text-amber-400"
                          : "text-muted-foreground",
                      )}
                    />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Review Text */}
        <div className="space-y-2">
          <Label htmlFor="reviewText">Tell us more (optional)</Label>
          <Textarea
            id="reviewText"
            placeholder="What stood out about your experience?"
            value={reviewText}
            onChange={(e) => setReviewText(e.target.value)}
            rows={3}
            className="resize-none"
          />
        </div>

        {/* Would Recommend */}
        <div className="space-y-2">
          <Label>Would you recommend this agent to a friend?</Label>
          <div className="flex gap-3">
            <Button
              type="button"
              variant={wouldRecommend === true ? "default" : "outline"}
              size="sm"
              onClick={() => setWouldRecommend(true)}
            >
              Yes
            </Button>
            <Button
              type="button"
              variant={wouldRecommend === false ? "destructive" : "outline"}
              size="sm"
              onClick={() => setWouldRecommend(false)}
            >
              No
            </Button>
          </div>
        </div>

        <Button
          type="submit"
          className="w-full"
          disabled={loading || rating === 0 || wouldRecommend === null}
        >
          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          Submit Review
        </Button>
      </form>
    </Card>
  )
}
