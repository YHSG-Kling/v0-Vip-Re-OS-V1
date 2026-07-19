"use client"

/**
 * BUYER CLOSING-COST BREAKDOWN (client portal) — what closing actually costs
 * beyond the down payment, as honest ranges grounded in THIS deal's numbers.
 * Renders nothing when the deal has no price yet — never a hollow estimate.
 *
 * PROVENANCE LABELS (owner: region-derived closing costs): every line shows
 * where its number came from — "per your lender" (a real record), "regional
 * estimate — {state} conventions", or "AI-refined" (the bounded accuracy pass,
 * user-initiated via the button below). The lender's Loan Estimate stays the
 * named authority throughout (TRID).
 */

import { useEffect, useState } from "react"
import { Card } from "@/components/ui/card"
import { Calculator, ChevronDown, ChevronUp, Sparkles } from "lucide-react"
import { getBuyerClosingCosts } from "@/app/actions/buyer-closing-costs"
import type { BuyerClosingEstimate, BuyerCostLine } from "@/lib/offers/buyer-closing-costs"

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`

function sourceBadge(l: BuyerCostLine): string | null {
  if (l.pending) return null // the pending state is its own label
  if (l.source === "lender_fact") return l.sourceLabel ?? "per your lender's terms on file"
  if (l.source === "regional_estimate") return l.sourceLabel ?? "regional estimate"
  if (l.source === "ai_refined") return l.sourceLabel ?? "AI-refined within the regional band"
  return null // industry_band: the note already says what it is
}

export function BuyerClosingCostsCard({ contactId, transactionId }: { contactId: string; transactionId: string }) {
  const [est, setEst] = useState<BuyerClosingEstimate | null>(null)
  const [open, setOpen] = useState(false)
  const [refining, setRefining] = useState(false)
  useEffect(() => {
    getBuyerClosingCosts({ contactId, transactionId })
      .then((res) => { if (res.success) setEst(res.estimate) })
      .catch(() => {})
  }, [contactId, transactionId])

  const refine = () => {
    if (refining) return
    setRefining(true)
    getBuyerClosingCosts({ contactId, transactionId, refineWithAi: true })
      .then((res) => { if (res.success) setEst(res.estimate) })
      .catch(() => {})
      .finally(() => setRefining(false))
  }

  if (!est) return null
  return (
    <Card className="p-6">
      <div className="flex items-center gap-2">
        <Calculator className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-xl font-semibold">Your closing costs, in plain numbers</h2>
      </div>
      <p className="mt-2 text-sm">
        Beyond your down payment, plan for roughly <span className="font-semibold">{usd(est.netLow)}–{usd(est.netHigh)}</span> at
        closing ({est.pctLow}%–{est.pctHigh}% of the purchase price{est.sellerCredit > 0 ? `, after the ${usd(est.sellerCredit)} seller credit your agent negotiated` : ""}).
        {est.isCash ? " Paying cash keeps the lender fees off this list entirely." : ""}
        {!est.isCash && !est.loanKnown ? " Lender charges aren't included yet — they depend on your loan terms, which aren't on file." : ""}
      </p>
      {est.loanSourceNote && (
        <p className="mt-1 text-xs text-muted-foreground">Loan figures {est.loanSourceNote}.</p>
      )}
      {est.regionLabel && (
        <p className="mt-1 text-xs text-muted-foreground">
          Labeled lines are a {est.regionLabel} — your lender&apos;s Loan Estimate is the authority.
        </p>
      )}
      <div className="mt-3 flex items-center gap-4">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          See the line-by-line breakdown
        </button>
        {est.regionState && !est.aiRefined && (
          <button
            type="button"
            onClick={refine}
            disabled={refining}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <Sparkles className="h-3 w-3" />
            {refining ? "Sharpening…" : "Sharpen this estimate with AI"}
          </button>
        )}
      </div>
      {est.aiRefined && est.aiRefineSummary && (
        <p className="mt-2 text-xs text-muted-foreground">
          <Sparkles className="mr-1 inline h-3 w-3" />
          AI accuracy pass (bounded by the regional model): {est.aiRefineSummary}
        </p>
      )}
      {open && (
        <div className="mt-3 space-y-1.5">
          {est.lines.map((l) => {
            const badge = sourceBadge(l)
            return (
              <div key={l.label} className="flex items-start justify-between gap-3 text-sm">
                <span>
                  {l.label}
                  {l.note && <span className="block text-xs text-muted-foreground">{l.note}</span>}
                  {badge && <span className="block text-[11px] italic text-muted-foreground">{badge}</span>}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {l.pending ? "Pending lender terms" : `${usd(l.low)}–${usd(l.high)}`}
                </span>
              </div>
            )
          })}
          {est.sellerCredit > 0 && (
            <div className="flex items-start justify-between gap-3 border-t pt-1.5 text-sm">
              <span className="font-medium text-emerald-700">Seller credit (negotiated for you)</span>
              <span className="shrink-0 tabular-nums font-medium text-emerald-700">−{usd(est.sellerCredit)}</span>
            </div>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{est.disclaimer}</p>
    </Card>
  )
}
