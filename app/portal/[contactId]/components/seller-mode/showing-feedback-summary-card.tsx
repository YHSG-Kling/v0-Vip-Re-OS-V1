"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { MessageCircle, ThumbsUp, ThumbsDown, AlertTriangle, ArrowRight, TrendingUp } from "lucide-react"

interface FeedbackSummary {
  positivePatterns: string[]
  commonConcerns: string[]
  pricingSignal: "priced_right" | "too_high" | "good_value" | null
  averageRating: number | null
  totalFeedback: number
}

interface ShowingFeedbackSummaryCardProps {
  contactId: string
  summary: FeedbackSummary
}

export function ShowingFeedbackSummaryCard({ contactId, summary }: ShowingFeedbackSummaryCardProps) {
  const { positivePatterns, commonConcerns, pricingSignal, averageRating, totalFeedback } = summary

  const pricingConfig: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
    priced_right: { label: "Priced Right", color: "bg-green-100 text-green-800", icon: <TrendingUp className="h-3.5 w-3.5" /> },
    too_high: { label: "May Be High", color: "bg-amber-100 text-amber-800", icon: <AlertTriangle className="h-3.5 w-3.5" /> },
    good_value: { label: "Good Value", color: "bg-blue-100 text-blue-800", icon: <ThumbsUp className="h-3.5 w-3.5" /> },
  }

  const pricingInfo = pricingSignal ? pricingConfig[pricingSignal] : null

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageCircle className="h-4 w-4" />
            Showing Feedback
          </CardTitle>
          {totalFeedback > 0 && (
            <Badge variant="outline" className="text-xs">
              {totalFeedback} {totalFeedback === 1 ? "response" : "responses"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {totalFeedback === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No feedback yet. Feedback will appear here after showings.
          </p>
        ) : (
          <>
            {/* Positive Patterns */}
            {positivePatterns.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide flex items-center gap-1">
                  <ThumbsUp className="h-3.5 w-3.5" />
                  What Buyers Love
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {positivePatterns.slice(0, 4).map((pattern, i) => (
                    <Badge key={i} variant="outline" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200">
                      {pattern}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Common Concerns */}
            {commonConcerns.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide flex items-center gap-1">
                  <ThumbsDown className="h-3.5 w-3.5" />
                  Common Feedback
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {commonConcerns.slice(0, 3).map((concern, i) => (
                    <Badge key={i} variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-200">
                      {concern}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Pricing Signal */}
            {pricingInfo && (
              <div className="flex items-center justify-between p-3 rounded-lg border">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Price Perception</span>
                </div>
                <Badge className={pricingInfo.color}>
                  {pricingInfo.icon}
                  <span className="ml-1">{pricingInfo.label}</span>
                </Badge>
              </div>
            )}

            {/* Average Rating */}
            {averageRating !== null && (
              <p className="text-sm text-muted-foreground">
                Average impression:{" "}
                <span className="font-medium text-foreground">
                  {averageRating >= 4 ? "Very Positive" : averageRating >= 3 ? "Positive" : "Mixed"}
                </span>
              </p>
            )}
          </>
        )}

        {/* CTA */}
        <Button variant="outline" size="sm" asChild className="w-full">
          <Link href={`/portal/${contactId}/insights`}>
            View All Feedback
            <ArrowRight className="h-4 w-4 ml-2" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
