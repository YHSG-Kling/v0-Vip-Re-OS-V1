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
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  SENTIMENT_CONFIG,
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

function FeedbackItem({ feedback }: { feedback: ShowingFeedback }) {
  const sentiment = SENTIMENT_CONFIG[feedback.sentiment ?? "neutral"] ?? SENTIMENT_CONFIG.neutral
  const SentimentIcon = feedback.sentiment === "positive"
    ? ThumbsUp
    : feedback.sentiment === "negative"
    ? ThumbsDown
    : Minus

  const showingDate = feedback.showing?.showing_date
    ? new Date(feedback.showing.showing_date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : ""

  return (
    <div className="p-3 rounded-lg border bg-card">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Calendar className="h-3.5 w-3.5" />
          <span>{showingDate}</span>
          {feedback.rating && (
            <>
              <span className="text-muted-foreground/50">|</span>
              <Star className="h-3.5 w-3.5 text-amber-500" />
              <span>{feedback.rating}/5</span>
            </>
          )}
        </div>
        <Badge variant="secondary" className={cn("shrink-0 text-xs", sentiment.color)}>
          <SentimentIcon className="h-3 w-3 mr-1" />
          {sentiment.label}
        </Badge>
      </div>
      <p className="text-sm line-clamp-2">
        {feedback.feedback_text || "No written feedback provided."}
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
