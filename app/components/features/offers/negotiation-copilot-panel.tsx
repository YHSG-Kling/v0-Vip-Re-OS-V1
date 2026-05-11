"use client"

/**
 * <NegotiationCoPilotPanel> — shared UI surface for both negotiation sides.
 *
 *   side="seller" — used at /dashboard/listings/[id]/offers when an offer
 *                   comes in on our listing
 *   side="buyer"  — used at /dashboard/buyers/[id]/offers/[offerId] when
 *                   the seller has countered our buyer's offer
 *
 * Single button → comprehensive panel with:
 *   - AI recommendation (accept / counter / walk away)
 *   - Suggested counter price + risk-of-losing-deal % + top tactics
 *   - Comparable sales nearby (median sold, avg DOM, $/sqft, insight)
 *   - Draft response message in agent voice (audience flips per side)
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import {
  negotiationCoPilot,
  type NegotiationCoPilotResult,
} from "@/app/actions/negotiation-copilot"

interface Props {
  offerId:       string
  side:          "seller" | "buyer"
  /** Override defaults. Buyer side: pass buyerMaxBudget + sellerCounter. */
  buyerMaxBudget?: number
  sellerCounter?:  number
}

export function NegotiationCoPilotPanel({
  offerId,
  side,
  buyerMaxBudget,
  sellerCounter,
}: Props) {
  const [result, setResult] = useState<NegotiationCoPilotResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleAdvise() {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const r = await negotiationCoPilot({
        offerId,
        side,
        buyerMaxBudget,
        sellerCounter,
      })
      if (!r.success) {
        setError(r.error ?? "Co-pilot failed")
      } else {
        setResult(r)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Co-pilot failed")
    } finally {
      setLoading(false)
    }
  }

  const headerLabel =
    side === "seller"
      ? "🧠 Negotiation Co-Pilot — should we accept, counter, or walk?"
      : "🧠 Negotiation Co-Pilot — respond to seller's counter?"

  return (
    <div className="rounded-lg border border-purple-200 bg-purple-50 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-purple-900">{headerLabel}</p>
        {!result && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleAdvise}
            disabled={loading}
            className="h-8 text-xs"
          >
            {loading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
            Advise
          </Button>
        )}
        {result && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setResult(null)}
            className="h-8 text-xs"
          >
            Clear
          </Button>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</p>
      )}

      {result && result.offerSnapshot && (
        <p className="text-[11px] text-purple-700">
          {side === "seller" ? "Buyer offered" : "We offered"}{" "}
          ${Number(result.offerSnapshot.offerPrice).toLocaleString()} · list{" "}
          ${Number(result.offerSnapshot.listPrice).toLocaleString()} ·{" "}
          {Math.round(result.offerSnapshot.gapPct)}% gap
        </p>
      )}

      {/* Strategy */}
      {result?.strategy && (
        <div className="rounded-md bg-white border border-purple-100 p-3 space-y-1">
          {result.strategy.recommendedResponse && (
            <p className="text-sm font-medium">
              Recommendation:{" "}
              <span className="capitalize text-purple-900">
                {result.strategy.recommendedResponse}
              </span>
            </p>
          )}
          {result.strategy.suggestedCounterPrice != null && (
            <p className="text-sm">
              {side === "seller" ? "Suggested counter" : "Suggested counter back"}:{" "}
              <strong>${Number(result.strategy.suggestedCounterPrice).toLocaleString()}</strong>
              {result.strategy.estimatedFinalPrice != null && (
                <span className="text-xs text-muted-foreground ml-2">
                  (est. final ${Number(result.strategy.estimatedFinalPrice).toLocaleString()})
                </span>
              )}
            </p>
          )}
          {result.strategy.reasoning && (
            <p className="text-xs text-muted-foreground">{result.strategy.reasoning}</p>
          )}
          {result.strategy.riskOfLosingDeal != null && (
            <p className="text-xs">
              Risk of losing deal:{" "}
              <span className={
                result.strategy.riskOfLosingDeal >= 60 ? "text-red-700 font-medium" :
                result.strategy.riskOfLosingDeal >= 30 ? "text-amber-700" : "text-emerald-700"
              }>
                {result.strategy.riskOfLosingDeal}%
              </span>
            </p>
          )}
          {Array.isArray(result.strategy.negotiationTactics) && result.strategy.negotiationTactics.length > 0 && (
            <ul className="text-xs text-muted-foreground list-disc pl-4 mt-1">
              {result.strategy.negotiationTactics.slice(0, 3).map((t: string, i: number) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Comparables */}
      {result?.comparables && result.comparables.count > 0 && (
        <div className="rounded-md bg-white border border-purple-100 p-3">
          <p className="text-xs font-semibold text-purple-900 mb-1">
            📊 Comparable sales · {result.comparables.count} nearby
          </p>
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {result.comparables.medianSoldPrice != null && (
              <span>Median sold: <strong className="text-foreground">${result.comparables.medianSoldPrice.toLocaleString()}</strong></span>
            )}
            {result.comparables.avgDom != null && (
              <span>Avg DOM: <strong className="text-foreground">{result.comparables.avgDom}</strong></span>
            )}
            {result.comparables.pricePerSqft != null && (
              <span>$/sqft: <strong className="text-foreground">${result.comparables.pricePerSqft}</strong></span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">{result.comparables.insight}</p>
        </div>
      )}

      {/* Draft response */}
      {result?.draftResponse?.body && (
        <div className="rounded-md bg-white border border-purple-100 p-3 space-y-1.5">
          <p className="text-xs font-semibold text-purple-900">
            ✍️ Draft response to {side === "seller" ? "buyer's agent" : "listing agent"}
          </p>
          {result.draftResponse.subject && (
            <p className="text-xs"><span className="text-muted-foreground">Subject:</span> {result.draftResponse.subject}</p>
          )}
          <textarea
            readOnly
            value={result.draftResponse.body}
            rows={4}
            className="w-full text-xs border border-input rounded-md px-2 py-1.5 bg-muted/30 resize-none"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => navigator.clipboard?.writeText(result.draftResponse?.body ?? "")}
          >
            Copy
          </Button>
        </div>
      )}
    </div>
  )
}
