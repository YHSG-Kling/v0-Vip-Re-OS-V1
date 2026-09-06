"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Star, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react"

interface Props {
  analytics: {
    total_showings: number
    avg_days_between_showings: number | null
    feedback_response_rate: number | null
    avg_presentation_rating: number | null
    avg_cleanliness_rating: number | null
    price_opinion_distribution: Record<string, number>
    meets_needs_distribution: Record<string, number>
    offer_interest_distribution: Record<string, number>
    top_concerns: string[] | null
    top_liked_features: string[] | null
    ai_market_signals: string | null
  } | null
  feedbackCards: any[]
}

function Stars({ value }: { value: number | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>
  return (
    <span className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`h-3.5 w-3.5 ${i <= Math.round(value) ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`}
        />
      ))}
      <span className="ml-1 text-xs text-muted-foreground">{value.toFixed(1)}</span>
    </span>
  )
}

function DistBar({ label, count, total }: { label: string; count: number; total: number }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between text-xs">
        <span className="text-foreground capitalize">{label.replace(/_/g, " ")}</span>
        <span className="text-muted-foreground">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function FeedbackSummaryPanel({ analytics, feedbackCards }: Props) {
  const [expandedCard, setExpandedCard] = useState<string | null>(null)

  if (!analytics) {
    return (
      <Card className="h-fit">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Feedback Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No analytics yet. Complete showings to see aggregated feedback.
          </p>
        </CardContent>
      </Card>
    )
  }

  const priceTotal = Object.values(analytics.price_opinion_distribution ?? {}).reduce((a, b) => a + b, 0)
  const meetsTotal = Object.values(analytics.meets_needs_distribution ?? {}).reduce((a, b) => a + b, 0)
  const offerTotal = Object.values(analytics.offer_interest_distribution ?? {}).reduce((a, b) => a + b, 0)

  // Consistency banner: 3+ showings with repeated concerns
  const showBanner =
    analytics.total_showings >= 3 &&
    (analytics.top_concerns?.length ?? 0) > 0

  return (
    <div className="flex flex-col gap-4">
      {/* Stats */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Feedback Summary</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Key numbers */}
          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col items-center gap-0.5 rounded-lg bg-muted/40 py-2">
              <span className="text-lg font-semibold text-foreground">{analytics.total_showings}</span>
              <span className="text-center text-[10px] text-muted-foreground leading-tight">Showings</span>
            </div>
            <div className="flex flex-col items-center gap-0.5 rounded-lg bg-muted/40 py-2">
              <span className="text-lg font-semibold text-foreground">
                {analytics.feedback_response_rate != null
                  ? `${Math.round(analytics.feedback_response_rate)}%`
                  : "—"}
              </span>
              <span className="text-center text-[10px] text-muted-foreground leading-tight">Response Rate</span>
            </div>
            <div className="flex flex-col items-center gap-0.5 rounded-lg bg-muted/40 py-2">
              <span className="text-lg font-semibold text-foreground">
                {analytics.avg_days_between_showings != null
                  ? analytics.avg_days_between_showings.toFixed(1)
                  : "—"}
              </span>
              <span className="text-center text-[10px] text-muted-foreground leading-tight">Avg Days</span>
            </div>
          </div>

          {/* Star ratings */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Presentation</span>
              <Stars value={analytics.avg_presentation_rating} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Cleanliness</span>
              <Stars value={analytics.avg_cleanliness_rating} />
            </div>
          </div>

          {/* Price opinion */}
          {priceTotal > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">Price Opinion</span>
              {Object.entries(analytics.price_opinion_distribution).map(([k, v]) => (
                <DistBar key={k} label={k} count={v} total={priceTotal} />
              ))}
            </div>
          )}

          {/* Meets needs */}
          {meetsTotal > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">Meets Buyer Needs</span>
              {Object.entries(analytics.meets_needs_distribution).map(([k, v]) => (
                <DistBar key={k} label={k} count={v} total={meetsTotal} />
              ))}
            </div>
          )}

          {/* Offer interest */}
          {offerTotal > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">Offer Interest</span>
              {Object.entries(analytics.offer_interest_distribution).map(([k, v]) => (
                <DistBar key={k} label={k} count={v} total={offerTotal} />
              ))}
            </div>
          )}

          {/* Top concerns */}
          {(analytics.top_concerns?.length ?? 0) > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">Top Concerns</span>
              <div className="flex flex-wrap gap-1">
                {analytics.top_concerns!.map((c) => (
                  <Badge key={c} variant="secondary" className="text-xs">{c}</Badge>
                ))}
              </div>
            </div>
          )}

          {/* Top liked features */}
          {(analytics.top_liked_features?.length ?? 0) > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">Buyers Like</span>
              <div className="flex flex-wrap gap-1">
                {analytics.top_liked_features!.map((f) => (
                  <Badge key={f} variant="outline" className="text-xs">{f}</Badge>
                ))}
              </div>
            </div>
          )}

          {/* AI market signals */}
          {analytics.ai_market_signals && (
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="text-xs font-medium text-foreground mb-1">AI Market Signal</p>
              <p className="text-xs text-muted-foreground">{analytics.ai_market_signals}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Consistency alert banner */}
      {showBanner && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/30">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Buyers consistently mention <strong>{analytics.top_concerns![0]}</strong> — consider discussing price strategy with your seller.
          </p>
        </div>
      )}

      {/* Individual feedback cards */}
      {feedbackCards.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Feedback ({feedbackCards.length})</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 p-0">
            {feedbackCards.map((fb) => {
              const isOpen = expandedCard === fb.id
              return (
                <div key={fb.id} className="border-b border-border last:border-0">
                  <button
                    className="flex w-full items-center justify-between gap-2 px-6 py-3 text-left"
                    onClick={() => setExpandedCard(isOpen ? null : fb.id)}
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">
                        {fb.submitted_by_agent_name ?? fb.showings?.buyer_agent_name ?? "Anonymous"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {fb.showings?.scheduled_at
                          ? new Date(fb.showings.scheduled_at).toLocaleDateString()
                          : "—"}
                      </span>
                    </div>
                    {isOpen ? (
                      <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                  </button>
                  {isOpen && (
                    <div className="flex flex-col gap-2 px-6 pb-4">
                      {fb.ai_summary && (
                        <p className="text-xs text-muted-foreground">{fb.ai_summary}</p>
                      )}
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        {fb.presentation_rating != null && (
                          <>
                            <span className="text-muted-foreground">Presentation</span>
                            <Stars value={fb.presentation_rating} />
                          </>
                        )}
                        {fb.cleanliness_rating != null && (
                          <>
                            <span className="text-muted-foreground">Cleanliness</span>
                            <Stars value={fb.cleanliness_rating} />
                          </>
                        )}
                        {fb.price_opinion && (
                          <>
                            <span className="text-muted-foreground">Price</span>
                            <Badge variant="secondary" className="w-fit text-[10px]">{fb.price_opinion.replace(/_/g, " ")}</Badge>
                          </>
                        )}
                        {fb.offer_interest && (
                          <>
                            <span className="text-muted-foreground">Offer?</span>
                            <Badge variant="outline" className="w-fit text-[10px]">{fb.offer_interest.replace(/_/g, " ")}</Badge>
                          </>
                        )}
                        {fb.overall_impression && (
                          <>
                            <span className="text-muted-foreground">Impression</span>
                            <span className="text-foreground capitalize">{fb.overall_impression.replace(/_/g, " ")}</span>
                          </>
                        )}
                        {fb.buyer_interest_level && (
                          <>
                            <span className="text-muted-foreground">Interest</span>
                            <span className="font-medium capitalize text-foreground">{fb.buyer_interest_level}</span>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
