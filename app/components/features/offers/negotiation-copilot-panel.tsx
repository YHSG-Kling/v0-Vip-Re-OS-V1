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
import { Loader2, Send, AlertTriangle, ShieldAlert } from "lucide-react"
import {
  negotiationCoPilot,
  sendDraftAsCounterResponse,
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
  const [sending, setSending] = useState(false)
  const [sendStatus, setSendStatus] = useState<
    | { kind: "sent"; messageId?: string }
    | { kind: "blocked"; reason: string }
    | { kind: "error"; message: string }
    | null
  >(null)

  async function handleAdvise() {
    setLoading(true)
    setError(null)
    setResult(null)
    setSendStatus(null)
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

  async function handleSendDraft() {
    if (!result?.draftResponse?.body) return
    setSending(true)
    setSendStatus(null)
    try {
      const r = await sendDraftAsCounterResponse({
        offerId,
        body:    result.draftResponse.body,
        subject: result.draftResponse.subject,
        channel: "email",
      })
      if (r.success) {
        setSendStatus({ kind: "sent", messageId: r.messageId })
      } else if (r.blocked) {
        setSendStatus({ kind: "blocked", reason: r.blockedReason ?? r.error ?? "Compliance block" })
      } else {
        setSendStatus({ kind: "error", message: r.error ?? "Send failed" })
      }
    } catch (e) {
      setSendStatus({ kind: "error", message: e instanceof Error ? e.message : "Send failed" })
    } finally {
      setSending(false)
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

      {/* Escalation Cap Calculator — surfaces on buyer side or when seller side detects competition */}
      {result?.escalation && (
        <div className="rounded-md bg-white border border-purple-100 p-3 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-purple-900">
              🎯 Escalation Cap Calculator
              {result.escalation.competingOffersDetected > 0 && (
                <span className="ml-1.5 text-[10px] font-normal text-purple-600">
                  · {result.escalation.competingOffersDetected} competing offer{result.escalation.competingOffersDetected === 1 ? "" : "s"} detected
                </span>
              )}
            </p>
            <span className={
              "text-[10px] px-1.5 py-0.5 rounded-full font-medium " +
              (result.escalation.competitionLevel === "high"   ? "bg-red-100 text-red-700"
              : result.escalation.competitionLevel === "medium" ? "bg-amber-100 text-amber-700"
              : result.escalation.competitionLevel === "low"    ? "bg-blue-100 text-blue-700"
              :                                                   "bg-gray-100 text-gray-600")
            }>
              {result.escalation.competitionLevel} competition
            </span>
          </div>
          {result.escalation.recommended ? (
            <>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <p className="text-muted-foreground text-[10px]">Starting offer</p>
                  <p className="font-medium">${Math.round(result.escalation.startingOffer).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-[10px]">Increment</p>
                  <p className="font-medium">${Math.round(result.escalation.escalationIncrement).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-[10px]">Max cap</p>
                  <p className="font-medium">${Math.round(result.escalation.maxEscalationPrice).toLocaleString()}</p>
                </div>
              </div>
              {result.escalation.capAtAppraisal && (
                <p className="text-[10px] text-amber-700">⚠ Cap should be subject to appraisal — buyer needs to know the gap risk.</p>
              )}
              <p className="text-[11px] text-muted-foreground">{result.escalation.reasoning}</p>
              {result.escalation.proofRequired && result.escalation.proofRequired.length > 0 && (
                <p className="text-[10px] text-muted-foreground">
                  <span className="font-medium">Proof to request:</span> {result.escalation.proofRequired.join(", ")}
                </p>
              )}
              {result.escalation.sampleClauseText && (
                <details className="text-[10px]">
                  <summary className="cursor-pointer text-purple-700 font-medium">Sample clause text</summary>
                  <pre className="mt-1 whitespace-pre-wrap font-sans bg-muted/30 rounded p-2 border border-input text-[10px]">{result.escalation.sampleClauseText}</pre>
                </details>
              )}
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Escalation clause not recommended in this scenario — {result.escalation.reasoning}
            </p>
          )}
        </div>
      )}

      {/* Concession Trade-off Matrix */}
      {result?.concessionMatrix && result.concessionMatrix.scenarios.length > 0 && (
        <div className="rounded-md bg-white border border-purple-100 p-3 space-y-1.5">
          <p className="text-xs font-semibold text-purple-900">
            💱 Concession Trade-off Matrix
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-input">
                  <th className="py-1 pr-2 font-medium">Scenario</th>
                  <th className="py-1 px-2 font-medium text-right">Δ Seller net</th>
                  <th className="py-1 px-2 font-medium text-right">Δ Buyer cash</th>
                  <th className="py-1 pl-2 font-medium">Lean</th>
                </tr>
              </thead>
              <tbody>
                {result.concessionMatrix.scenarios.map((s, i) => (
                  <tr key={i} className="border-b border-input/40 last:border-0">
                    <td className="py-1 pr-2">{s.label}</td>
                    <td className={"py-1 px-2 text-right tabular-nums " + (s.netToSellerDelta > 0 ? "text-emerald-700" : s.netToSellerDelta < 0 ? "text-red-700" : "text-muted-foreground")}>
                      {s.netToSellerDelta > 0 ? "+" : ""}${Math.abs(s.netToSellerDelta).toLocaleString()}
                    </td>
                    <td className={"py-1 px-2 text-right tabular-nums " + (s.netToBuyerDelta > 0 ? "text-emerald-700" : s.netToBuyerDelta < 0 ? "text-red-700" : "text-muted-foreground")}>
                      {s.netToBuyerDelta > 0 ? "+" : ""}${Math.abs(s.netToBuyerDelta).toLocaleString()}
                    </td>
                    <td className="py-1 pl-2">
                      <span className={
                        "text-[10px] px-1.5 py-0.5 rounded-full " +
                        (s.recommendation === "seller_favored" ? "bg-emerald-100 text-emerald-700"
                        : s.recommendation === "buyer_favored"  ? "bg-blue-100 text-blue-700"
                        :                                          "bg-gray-100 text-gray-700")
                      }>
                        {s.recommendation === "seller_favored" ? "Seller" : s.recommendation === "buyer_favored" ? "Buyer" : "Balanced"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground italic">{result.concessionMatrix.bottomLine}</p>
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
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => navigator.clipboard?.writeText(result.draftResponse?.body ?? "")}
            >
              Copy
            </Button>
            <Button
              size="sm"
              variant="default"
              className="h-7 text-xs gap-1.5"
              onClick={handleSendDraft}
              disabled={sending || !result.offerSnapshot?.contactId}
              title={
                !result.offerSnapshot?.contactId
                  ? "No contact linked to this offer — can't route a send."
                  : "Send this draft via the communication spine (runs compliance gate first)"
              }
            >
              {sending
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <Send className="h-3 w-3" />
              }
              Send as counter response
            </Button>
            {sendStatus?.kind === "sent" && (
              <span className="text-[11px] text-emerald-700">✓ Sent</span>
            )}
            {sendStatus?.kind === "blocked" && (
              <span className="inline-flex items-center gap-1 text-[11px] text-amber-700">
                <ShieldAlert className="h-3 w-3" />
                Blocked by compliance: {sendStatus.reason}
              </span>
            )}
            {sendStatus?.kind === "error" && (
              <span className="inline-flex items-center gap-1 text-[11px] text-red-700">
                <AlertTriangle className="h-3 w-3" />
                {sendStatus.message}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
