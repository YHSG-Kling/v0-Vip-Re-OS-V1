"use client"

/**
 * app/components/features/offers/net-sheet-view.tsx
 *
 * Seller net sheet calculator.
 * All computation is client-side — inputs passed as props from the server workspace.
 * Computes net proceeds from offer_price, closing costs, earnest money, commission.
 */

import { useMemo } from "react"
import { cn }      from "@/lib/utils"
import { calcNetToSeller } from "@/lib/offers/offer-math"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value)
}

function pct(value: number) {
  return `${value.toFixed(2)}%`
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface NetSheetViewProps {
  offerPrice:              number
  listPrice:               number | null
  closingCostContribution: number | null
  earnestMoney:            number | null
  sellerNetEstimate:       number | null
  /** Commission percentage from brokerage settings — defaults to 6% */
  commissionRate?:         number
}

// ─── Line item ────────────────────────────────────────────────────────────────

function LineItem({
  label,
  amount,
  isSubtract = false,
  isBold     = false,
  isTotal    = false,
}: {
  label:        string
  amount:       number
  isSubtract?:  boolean
  isBold?:      boolean
  isTotal?:     boolean
}) {
  return (
    <div className={cn(
      "flex items-center justify-between py-2",
      isTotal ? "border-t-2 border-foreground/20 mt-1 pt-3" : "border-t border-border/40",
    )}>
      <span className={cn(
        "text-sm",
        isBold || isTotal ? "font-semibold text-foreground" : "text-muted-foreground",
      )}>
        {label}
      </span>
      <span className={cn(
        "text-sm tabular-nums",
        isTotal  ? "text-lg font-bold text-foreground" :
        isSubtract ? "text-red-600 font-medium" : "font-medium text-foreground",
      )}>
        {isSubtract ? `(${fmt(Math.abs(amount))})` : fmt(amount)}
      </span>
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function NetSheetView({
  offerPrice,
  listPrice,
  closingCostContribution,
  earnestMoney,
  sellerNetEstimate,
  commissionRate = 6,
}: NetSheetViewProps) {

  const {
    commissionAmount,
    sellerClosingCosts,
    closingCreditDeduction,
    computedNet,
    priceVsListPct,
  } = useMemo(() => {
    // Standard commission split
    const commissionAmount = offerPrice * (commissionRate / 100)

    // Typical seller closing costs: ~1% title/escrow/transfer — an explicit,
    // ITEMIZED estimate this view adds on top of the canonical core.
    const sellerClosingCosts = offerPrice * 0.01

    // Closing credit the seller agreed to give buyer
    const closingCreditDeduction = closingCostContribution ?? 0

    // CANONICAL core (lib/offers/offer-math calcNetToSeller — the single source of
    // truth shared with the offer analyzer + kernel net-sheet engine), minus the
    // itemized title/escrow estimate shown in the breakdown below.
    const computedNet =
      calcNetToSeller({
        offer_price: offerPrice,
        commission_rate: commissionRate / 100,
        closing_cost_contribution: closingCostContribution,
      })
      - sellerClosingCosts

    const priceVsListPct = listPrice
      ? ((offerPrice - listPrice) / listPrice) * 100
      : null

    return { commissionAmount, sellerClosingCosts, closingCreditDeduction, computedNet, priceVsListPct }
  }, [offerPrice, listPrice, closingCostContribution, commissionRate])

  // Prefer server-computed seller_net_estimate if available; show computed as secondary
  const displayNet = sellerNetEstimate ?? computedNet

  return (
    <div className="space-y-6">
      {/* Header metrics */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Offer Price</p>
          <p className="text-xl font-bold text-foreground">{fmt(offerPrice)}</p>
        </div>

        {listPrice !== null && (
          <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">vs List Price</p>
            <p className={cn(
              "text-xl font-bold",
              priceVsListPct === null ? "text-muted-foreground" :
              priceVsListPct >= 0 ? "text-green-600" : "text-red-600"
            )}>
              {priceVsListPct === null ? "—" : (
                `${priceVsListPct >= 0 ? "+" : ""}${priceVsListPct.toFixed(1)}%`
              )}
            </p>
          </div>
        )}

        <div className="rounded-lg border border-border bg-green-50 p-4 space-y-1 col-span-2 sm:col-span-1">
          <p className="text-xs text-green-700 uppercase tracking-wide font-medium">Est. Net Proceeds</p>
          <p className="text-xl font-bold text-green-800">{fmt(displayNet)}</p>
          {sellerNetEstimate !== null && (
            <p className="text-xs text-green-600">From AI analysis</p>
          )}
        </div>
      </div>

      {/* Breakdown */}
      <div className="rounded-lg border border-border bg-background divide-y-0">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-4 pt-4 pb-2">
          Net Sheet Breakdown
        </h3>
        <div className="px-4 pb-4 space-y-0">
          <LineItem label="Offer Price" amount={offerPrice} />
          <LineItem
            label={`Commission (${pct(commissionRate)})`}
            amount={commissionAmount}
            isSubtract
          />
          <LineItem
            label="Seller Closing Costs (est. 1%)"
            amount={sellerClosingCosts}
            isSubtract
          />
          {closingCreditDeduction > 0 && (
            <LineItem
              label="Buyer Closing Credit"
              amount={closingCreditDeduction}
              isSubtract
            />
          )}
          <LineItem
            label="Estimated Net Proceeds"
            amount={computedNet}
            isBold
            isTotal
          />
        </div>
      </div>

      {/* Earnest money note */}
      {earnestMoney !== null && earnestMoney > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-xs text-amber-800 leading-relaxed">
            <span className="font-semibold">Earnest Money: </span>
            {fmt(earnestMoney)} — credited toward buyer&apos;s down payment at closing.
            Not deducted from seller net proceeds above.
          </p>
        </div>
      )}

      {/* Disclaimer */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        This is an estimate only. Actual net proceeds depend on your mortgage payoff, prorated taxes,
        HOA fees, negotiated repairs, and final closing statement. Consult your transaction coordinator.
      </p>
    </div>
  )
}
