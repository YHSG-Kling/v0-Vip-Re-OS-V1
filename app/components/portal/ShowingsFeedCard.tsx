"use client"

// components/portal/ShowingsFeedCard.tsx
// Displays showing activity strip and recent feedback for seller portal.

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Skeleton } from "@/app/components/ui/skeleton"
import {
  Eye,
  Calendar,
  Star,
  MessageSquare,
  ArrowRight,
  TrendingUp,
  ThumbsUp,
  ThumbsDown,
  Minus,
  DollarSign,
  CheckCircle,
  Flame,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  SENTIMENT_CONFIG,
  deriveOverallSentiment,
  type ShowingFeedback,
} from "@/lib/portal/resolve-seller-context"

interface ShowingActivityStripProps {
  thisWeek: number
  total: number
  avgRating: number | null
  contactId: string
}

export function ShowingActivityStrip({
  thisWeek,
  total,
  avgRating,
  contactId,
}: ShowingActivityStripProps) {
  return (
    <div className="grid grid-cols-3 gap-4">
      <StatCard
        icon={Calendar}
        label="This Week"
        value={thisWeek}
        trend={thisWeek > 0 ? "up" : undefined}
      />
      <StatCard
        icon={Eye}
        label="Total Showings"
        value={total}
      />
      <StatCard
        icon={Star}
        label="Avg. Rating"
        value={avgRating !== null ? avgRating.toFixed(1) : "N/A"}
        suffix={avgRating !== null ? "/5" : ""}
      />
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  suffix = "",
  trend,
}: {
  icon: any
  label: string
  value: number | string
  suffix?: string
  trend?: "up" | "down"
}) {
  return (
    <Card>
      <CardContent className="py-4 text-center">
        <div className="flex items-center justify-center gap-2 mb-1">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {trend === "up" && <TrendingUp className="h-3 w-3 text-green-600" />}
        </div>
        <p className="text-2xl font-semibold">
          {value}{suffix}
        </p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  )
}

interface ShowingFeedbackCardProps {
  feedback: ShowingFeedback[]
  contactId: string
  isLoading?: boolean
}

export function ShowingFeedbackCard({
  feedback,
  contactId,
  isLoading = false,
}: ShowingFeedbackCardProps) {
  if (isLoading) {
    return <ShowingFeedbackCardSkeleton />
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Recent Feedback
          </CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/portal/${contactId}/insights`}>
              See All
              <ArrowRight className="h-4 w-4 ml-1" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {feedback.length === 0 ? (
          <div className="text-center py-6">
            <MessageSquare className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              No feedback yet. Feedback from showings will appear here.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {feedback.map((fb) => (
              <FeedbackItem key={fb.id} feedback={fb} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// Price opinion config
const PRICE_OPINION_CONFIG: Record<string, { label: string; color: string }> = {
  too_high: { label: "Too High", color: "bg-red-100 text-red-700" },
  priced_right: { label: "Priced Right", color: "bg-green-100 text-green-700" },
  good_value: { label: "Good Value", color: "bg-emerald-100 text-emerald-700" },
}

// Meets buyer needs config
const MEETS_NEEDS_CONFIG: Record<string, { label: string; color: string }> = {
  yes: { label: "Meets Needs", color: "bg-green-100 text-green-700" },
  partially: { label: "Partially", color: "bg-amber-100 text-amber-700" },
  no: { label: "Doesn't Meet Needs", color: "bg-red-100 text-red-700" },
}

// Offer interest config
const OFFER_INTEREST_CONFIG: Record<string, { label: string; color: string }> = {
  very_likely: { label: "Very Likely", color: "bg-green-100 text-green-700" },
  possible: { label: "Possible", color: "bg-blue-100 text-blue-700" },
  unlikely: { label: "Unlikely", color: "bg-amber-100 text-amber-700" },
  no: { label: "No", color: "bg-slate-100 text-slate-600" },
}

// Buyer interest level config
const BUYER_INTEREST_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  hot: { label: "Hot", color: "bg-red-100 text-red-700", icon: Flame },
  warm: { label: "Warm", color: "bg-orange-100 text-orange-700", icon: TrendingUp },
  cool: { label: "Cool", color: "bg-blue-100 text-blue-700", icon: Minus },
  cold: { label: "Cold", color: "bg-slate-100 text-slate-600", icon: Minus },
}

function FeedbackItem({ feedback }: { feedback: ShowingFeedback }) {
  // Derive sentiment from overall_impression (no direct sentiment column)
  const derivedSentiment = deriveOverallSentiment(feedback)
  const sentiment = SENTIMENT_CONFIG[derivedSentiment] ?? SENTIMENT_CONFIG.neutral
  const SentimentIcon = derivedSentiment === "positive"
    ? ThumbsUp
    : derivedSentiment === "negative"
    ? ThumbsDown
    : Minus

  // Use scheduled_at from showing (not showing_date)
  const showingDate = feedback.showing?.scheduled_at
    ? new Date(feedback.showing.scheduled_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : ""

  // Calculate average rating from presentation_rating and cleanliness_rating
  const hasRating = feedback.presentation_rating || feedback.cleanliness_rating
  const avgRating = hasRating
    ? (((feedback.presentation_rating ?? 0) + (feedback.cleanliness_rating ?? 0)) / 2).toFixed(1)
    : null

  // Get display text from available fields
  const displayText =
    feedback.ai_summary ||
    feedback.buyer_favorite_features ||
    feedback.specific_concerns ||
    feedback.additional_notes ||
    "No written feedback provided."

  return (
    <div className="p-3 rounded-lg border bg-card">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Calendar className="h-3.5 w-3.5" />
          <span>{showingDate}</span>
          {avgRating && (
            <>
              <span className="text-muted-foreground/50">|</span>
              <Star className="h-3.5 w-3.5 text-amber-500" />
              <span>{avgRating}/5</span>
            </>
          )}
        </div>
        <Badge variant="secondary" className={cn("shrink-0 text-xs", sentiment.color)}>
          <SentimentIcon className="h-3 w-3 mr-1" />
          {sentiment.label}
        </Badge>
      </div>

      {/* Rich data badges row */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {/* Price opinion badge */}
        {feedback.price_opinion && PRICE_OPINION_CONFIG[feedback.price_opinion] && (
          <Badge variant="outline" className={cn("text-xs", PRICE_OPINION_CONFIG[feedback.price_opinion].color)}>
            <DollarSign className="h-3 w-3 mr-0.5" />
            {PRICE_OPINION_CONFIG[feedback.price_opinion].label}
          </Badge>
        )}

        {/* Meets buyer needs badge */}
        {feedback.meets_buyer_needs && MEETS_NEEDS_CONFIG[feedback.meets_buyer_needs] && (
          <Badge variant="outline" className={cn("text-xs", MEETS_NEEDS_CONFIG[feedback.meets_buyer_needs].color)}>
            <CheckCircle className="h-3 w-3 mr-0.5" />
            {MEETS_NEEDS_CONFIG[feedback.meets_buyer_needs].label}
          </Badge>
        )}

        {/* Offer interest badge */}
        {feedback.offer_interest && OFFER_INTEREST_CONFIG[feedback.offer_interest] && (
          <Badge variant="outline" className={cn("text-xs", OFFER_INTEREST_CONFIG[feedback.offer_interest].color)}>
            {OFFER_INTEREST_CONFIG[feedback.offer_interest].label}
          </Badge>
        )}

        {/* Buyer interest level badge */}
        {feedback.buyer_interest_level && BUYER_INTEREST_CONFIG[feedback.buyer_interest_level] && (
          <Badge variant="outline" className={cn("text-xs", BUYER_INTEREST_CONFIG[feedback.buyer_interest_level].color)}>
            {(() => {
              const InterestIcon = BUYER_INTEREST_CONFIG[feedback.buyer_interest_level].icon
              return <InterestIcon className="h-3 w-3 mr-0.5" />
            })()}
            {BUYER_INTEREST_CONFIG[feedback.buyer_interest_level].label}
          </Badge>
        )}
      </div>

      {/* Feedback text */}
      <p className="text-sm line-clamp-2">
        {displayText}
      </p>
    </div>
  )
}

function ShowingFeedbackCardSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-8 w-20" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-3 rounded-lg border">
              <div className="flex items-center justify-between mb-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3 mt-1" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export { ShowingFeedbackCardSkeleton }
