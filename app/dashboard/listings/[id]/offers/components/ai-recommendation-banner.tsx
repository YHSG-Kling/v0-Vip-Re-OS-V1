"use client"

import { Sparkles, X } from "lucide-react"
import { useState } from "react"

interface Offer { id: string; offer_number: string | null }

interface Props {
  result: Record<string, unknown>
  offers: Offer[]
}

export function AIRecommendationBanner({ result, offers }: Props) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null

  const recommendation = result.recommendation as string | undefined
  const summary = result.comparison_summary as string | undefined
  const perOfferNotes = result.per_offer_notes as Record<string, string> | undefined

  return (
    <div className="relative rounded-lg border border-primary/30 bg-primary/5 p-4">
      <button
        className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss AI recommendation"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          <Sparkles className="h-5 w-5 text-primary" />
        </div>
        <div className="flex flex-col gap-2 pr-6">
          <p className="text-sm font-semibold text-foreground">AI Recommendation</p>
          {recommendation && (
            <p className="text-sm text-foreground/80">{recommendation}</p>
          )}
          {summary && (
            <p className="text-xs text-muted-foreground border-t border-border/50 pt-2 mt-1">{summary}</p>
          )}
          {perOfferNotes && Object.keys(perOfferNotes).length > 0 && (
            <div className="flex flex-col gap-1 mt-1">
              {Object.entries(perOfferNotes).map(([offerId, note]) => {
                const offer = offers.find((o) => o.id === offerId)
                return (
                  <p key={offerId} className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground/70">
                      {offer?.offer_number ?? offerId.slice(0, 8)}:
                    </span>{" "}
                    {note}
                  </p>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
