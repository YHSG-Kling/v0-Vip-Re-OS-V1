"use client"

/**
 * Seller showing-sentiment summary — the ON-DEMAND half.
 *
 * Wave 4 slice 2: `app/actions/seller-showing-sentiment.ts` says its summary is
 * "triggered by the seller-updates cron (Mondays 8am) **and on-demand from the
 * listing detail page**". Only the cron half existed:
 * `app/api/cron/seller-updates/route.ts` calls the ungated
 * `buildShowingSentimentSummary` (correct — an unattended caller must have its
 * own door), while the session-gated `getShowingSentimentSummaryAction` had no
 * caller at all. This is the missing on-demand door.
 *
 * Deliberately button-triggered, not loaded with the page: the summary runs an
 * LLM theme extraction, so firing it on every render would spend AI budget on
 * an agent who only wanted the showings list.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { HeartPulse, Loader2, AlertTriangle } from "lucide-react"
import { getShowingSentimentSummaryAction } from "@/app/actions/seller-showing-sentiment"
import type { ShowingSentimentSummary } from "@/app/actions/seller-showing-sentiment"

const PRESSURE_COPY: Record<string, { label: string; cls: string }> = {
  raise: { label: "Demand supports a higher ask", cls: "bg-green-100 text-green-800" },
  hold: { label: "Price is holding", cls: "bg-blue-100 text-blue-800" },
  reduce: { label: "Pressure to reduce", cls: "bg-amber-100 text-amber-900" },
  insufficient_data: { label: "Not enough feedback yet", cls: "bg-muted text-muted-foreground" },
}

export function SellerSentimentPanel({ listingId }: { listingId: string }) {
  const [summary, setSummary] = useState<ShowingSentimentSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleRun() {
    setError(null)
    startTransition(async () => {
      const r = await getShowingSentimentSummaryAction(listingId).catch(() => ({
        success: false as const,
        error: "Could not reach the server",
      }))
      if (!r.success) {
        // The action's refusals are "unauthorized" / "not_found" / "forbidden".
        // Say them in words rather than rendering an empty summary, which would
        // read as "no feedback" when it was really a refusal.
        setError(
          r.error === "forbidden" || r.error === "unauthorized"
            ? "You don't have access to this listing's showing feedback."
            : r.error === "not_found"
              ? "That listing could not be found."
              : (r.error ?? "Could not build the summary")
        )
        return
      }
      setSummary((r as { summary: ShowingSentimentSummary }).summary ?? null)
    })
  }

  const pressure = summary ? (PRESSURE_COPY[summary.pricingPressure] ?? PRESSURE_COPY.insufficient_data) : null
  const round = (n: number | null) => (n === null || Number.isNaN(n) ? "—" : n.toFixed(1))

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <HeartPulse className="h-4 w-4 text-rose-600" />
              Seller sentiment — last 7 days
            </CardTitle>
            <CardDescription className="text-xs">
              The same summary the Monday seller update sends, on demand. Aggregates this
              listing&apos;s showing feedback into themes, objections and a pricing signal.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={handleRun} disabled={isPending}>
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : summary ? "Refresh" : "Build summary"}
          </Button>
        </div>
      </CardHeader>

      {(error || summary) && (
        <CardContent className="space-y-3 text-xs">
          {error && (
            <p className="flex items-start gap-2 text-red-700 bg-red-50 border border-red-200 rounded p-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </p>
          )}

          {summary && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-muted-foreground">
                  {summary.showingCount} showing{summary.showingCount === 1 ? "" : "s"} ·{" "}
                  {summary.feedbackCount} with feedback
                </span>
                {pressure && (
                  <Badge className={pressure.cls} variant="secondary">{pressure.label}</Badge>
                )}
              </div>

              <div className="flex flex-wrap gap-4 text-muted-foreground">
                <span>Presentation <span className="font-semibold text-foreground">{round(summary.averagePresentation)}</span></span>
                <span>Cleanliness <span className="font-semibold text-foreground">{round(summary.averageCleanliness)}</span></span>
                <span>Impression <span className="font-semibold text-foreground">{round(summary.averageImpression)}</span></span>
                <span>High interest <span className="font-semibold text-foreground">{summary.highInterestCount}</span></span>
                <span>Low interest <span className="font-semibold text-foreground">{summary.lowInterestCount}</span></span>
              </div>

              {summary.positiveThemes.length > 0 && (
                <div>
                  <p className="font-medium text-green-700">Buyers consistently love:</p>
                  {summary.positiveThemes.map((t, i) => (
                    <p key={i} className="text-muted-foreground">+ {t}</p>
                  ))}
                </div>
              )}

              {summary.objections.length > 0 && (
                <div>
                  <p className="font-medium text-amber-700">Objections raised:</p>
                  {summary.objections.map((t, i) => (
                    <p key={i} className="text-muted-foreground">! {t}</p>
                  ))}
                </div>
              )}

              {summary.recommendedAction && (
                <div>
                  <p className="font-medium text-blue-700">Recommended next action:</p>
                  <p className="text-muted-foreground">{summary.recommendedAction}</p>
                </div>
              )}

              {summary.feedbackCount === 0 && (
                <p className="text-muted-foreground">
                  No showing feedback landed in this window — the ratings and themes above are
                  empty because nothing was collected, not because the showings went badly.
                </p>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}
