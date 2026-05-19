"use client"

/**
 * <RepairCoPilotPanel> — post-inspection negotiation Co-Pilot.
 *
 * Single button → comprehensive panel with:
 *   - AI strategy (approach, suggested total credit, walk-risk for both sides)
 *   - Per-item table (category, recommendation, suggested credit, reason)
 *   - Draft response message in agent voice (audience flips per side)
 *   - One-click Send via communication spine (compliance-gated)
 *
 * Mount points:
 *   side="buyer"  — buyer-side workspace, advising on what to ask for
 *   side="seller" — seller-side workspace (transaction-detail-client repairs),
 *                   advising on how to respond
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Loader2, Send, AlertTriangle, ShieldAlert } from "lucide-react"
import {
  repairNegotiationCoPilot,
  sendRepairResponseAsDraft,
  type RepairCoPilotResult,
} from "@/app/actions/repair-negotiation-copilot"

interface Props {
  transactionId: string
  side:          "buyer" | "seller"
}

const APPROACH_LABEL: Record<string, string> = {
  accept_all:         "Accept all repairs",
  accept_safety_only: "Accept safety only, decline cosmetic",
  credit:             "Offer a lump credit instead of repairs",
  subset_with_credit: "Repair some, credit the rest",
  counter_partial:    "Counter with a reduced repair list",
  walk:               "Hold firm — willing to risk losing the deal",
}

const CATEGORY_STYLE: Record<string, string> = {
  safety:     "bg-red-100 text-red-700",
  structural: "bg-orange-100 text-orange-700",
  system:     "bg-amber-100 text-amber-700",
  code:       "bg-blue-100 text-blue-700",
  cosmetic:   "bg-gray-100 text-gray-700",
  other:      "bg-gray-100 text-gray-600",
}

const REC_STYLE: Record<string, string> = {
  accept:  "bg-emerald-100 text-emerald-700",
  credit:  "bg-blue-100 text-blue-700",
  counter: "bg-amber-100 text-amber-700",
  decline: "bg-red-100 text-red-700",
}

export function RepairCoPilotPanel({ transactionId, side }: Props) {
  const [result, setResult] = useState<RepairCoPilotResult | null>(null)
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
      const r = await repairNegotiationCoPilot({ transactionId, side })
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
      const r = await sendRepairResponseAsDraft({
        transactionId,
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
      ? "🛠️ Repair Co-Pilot — accept, credit, or counter the buyer's ask?"
      : "🛠️ Repair Co-Pilot — what should our buyer ask the seller for?"

  return (
    <div className="rounded-lg border border-orange-200 bg-orange-50 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-orange-900">{headerLabel}</p>
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
            onClick={() => { setResult(null); setSendStatus(null) }}
            className="h-8 text-xs"
          >
            Clear
          </Button>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</p>
      )}

      {result && result.transactionSnapshot && (
        <p className="text-[11px] text-orange-700">
          {result.transactionSnapshot.propertyAddress}
          {" · "}${result.transactionSnapshot.purchasePrice.toLocaleString()}
          {result.transactionSnapshot.daysToClose != null && (
            <> · {result.transactionSnapshot.daysToClose}d to close</>
          )}
          {result.transactionSnapshot.inspectionCount > 0 && (
            <> · {result.transactionSnapshot.inspectionCount} inspection{result.transactionSnapshot.inspectionCount === 1 ? "" : "s"} on file</>
          )}
        </p>
      )}

      {/* No repairs yet */}
      {result && (!result.items || result.items.length === 0) && (
        <div className="rounded-md bg-white border border-orange-100 p-3">
          <p className="text-sm text-muted-foreground">
            No repair items submitted yet. Co-Pilot becomes useful once buyer's repair request is in.
          </p>
        </div>
      )}

      {/* Strategy card */}
      {result?.strategy && (
        <div className="rounded-md bg-white border border-orange-100 p-3 space-y-1.5">
          <p className="text-sm font-medium">
            Recommended approach:{" "}
            <span className="text-orange-900">
              {APPROACH_LABEL[result.strategy.recommendedApproach] ?? result.strategy.recommendedApproach}
            </span>
          </p>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <p className="text-muted-foreground text-[10px]">Total ask</p>
              <p className="font-medium">${Math.round(result.strategy.totalEstimatedRepairCost).toLocaleString()}</p>
            </div>
            {result.strategy.suggestedTotalCredit != null && (
              <div>
                <p className="text-muted-foreground text-[10px]">
                  {side === "seller" ? "Suggested credit" : "Ask for credit"}
                </p>
                <p className="font-medium">${Math.round(result.strategy.suggestedTotalCredit).toLocaleString()}</p>
              </div>
            )}
            <div>
              <p className="text-muted-foreground text-[10px]">
                {side === "seller" ? "Risk buyer walks" : "Risk seller walks"}
              </p>
              <p className={
                "font-medium " + (
                  (side === "seller" ? result.strategy.riskOfBuyerWalking : result.strategy.riskOfSellerWalking) >= 50
                    ? "text-red-700"
                    : (side === "seller" ? result.strategy.riskOfBuyerWalking : result.strategy.riskOfSellerWalking) >= 25
                    ? "text-amber-700"
                    : "text-emerald-700"
                )
              }>
                {side === "seller" ? result.strategy.riskOfBuyerWalking : result.strategy.riskOfSellerWalking}%
              </p>
            </div>
          </div>
          {result.strategy.reasoning && (
            <p className="text-xs text-muted-foreground">{result.strategy.reasoning}</p>
          )}
          {result.strategy.marketContext && (
            <p className="text-[11px] text-muted-foreground italic">{result.strategy.marketContext}</p>
          )}
          {result.strategy.tactics?.length > 0 && (
            <ul className="text-xs text-muted-foreground list-disc pl-4 mt-1">
              {result.strategy.tactics.slice(0, 4).map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Per-item table */}
      {result?.items && result.items.length > 0 && (
        <div className="rounded-md bg-white border border-orange-100 p-3">
          <p className="text-xs font-semibold text-orange-900 mb-1.5">
            📋 Per-item recommendations · {result.items.length} item{result.items.length === 1 ? "" : "s"}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-input">
                  <th className="py-1 pr-2 font-medium">Item</th>
                  <th className="py-1 px-2 font-medium">Cat</th>
                  <th className="py-1 px-2 font-medium text-right">Est</th>
                  <th className="py-1 px-2 font-medium">Rec</th>
                  <th className="py-1 px-2 font-medium text-right">Credit</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((i) => (
                  <tr key={i.id} className="border-b border-input/40 last:border-0 align-top">
                    <td className="py-1 pr-2">
                      <p className="leading-snug">{i.itemDescription}</p>
                      <p className="text-[10px] text-muted-foreground leading-tight">{i.recommendationReason}</p>
                    </td>
                    <td className="py-1 px-2">
                      <span className={"text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap " + (CATEGORY_STYLE[i.category] ?? CATEGORY_STYLE.other)}>
                        {i.category}
                      </span>
                    </td>
                    <td className="py-1 px-2 text-right tabular-nums">
                      {i.estimatedCost != null ? `$${Number(i.estimatedCost).toLocaleString()}` : "—"}
                    </td>
                    <td className="py-1 px-2">
                      <span className={"text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap " + (REC_STYLE[i.recommendation] ?? "bg-gray-100 text-gray-700")}>
                        {i.recommendation}
                      </span>
                    </td>
                    <td className="py-1 px-2 text-right tabular-nums">
                      {i.suggestedCredit != null ? `$${Number(i.suggestedCredit).toLocaleString()}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Draft response */}
      {result?.draftResponse?.body && (
        <div className="rounded-md bg-white border border-orange-100 p-3 space-y-1.5">
          <p className="text-xs font-semibold text-orange-900">
            ✍️ Draft response to {side === "seller" ? "buyer's agent" : "listing agent"}
          </p>
          {result.draftResponse.subject && (
            <p className="text-xs"><span className="text-muted-foreground">Subject:</span> {result.draftResponse.subject}</p>
          )}
          <textarea
            readOnly
            value={result.draftResponse.body}
            rows={5}
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
              disabled={sending || !result.transactionSnapshot?.contactId}
              title={
                !result.transactionSnapshot?.contactId
                  ? "No contact linked to this transaction — can't route a send."
                  : "Send this draft via the communication spine (runs compliance gate first)"
              }
            >
              {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              Send as repair response
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
