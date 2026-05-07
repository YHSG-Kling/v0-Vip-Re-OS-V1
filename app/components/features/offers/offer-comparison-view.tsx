"use client"

/**
 * app/components/features/offers/offer-comparison-view.tsx
 *
 * Side-by-side comparison of multiple offers on a listing.
 * Used on listing offer dashboards (seller side).
 * Data is server-loaded and passed in; no client fetch.
 * Comparison matrix is stored in `offer_comparison.comparison_matrix` (jsonb).
 */

import { cn } from "@/lib/utils"
import { CheckCircle, XCircle, Minus } from "lucide-react"
import type { OfferRow } from "@/lib/kernel/offers"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(value: number | null) {
  if (value === null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value)
}

function formatDate(iso: string | null) {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

// ─── Column header ────────────────────────────────────────────────────────────

function OfferColumnHeader({
  offer,
  rank,
  isRecommended,
}: {
  offer:          OfferRow
  rank:           number
  isRecommended:  boolean
}) {
  return (
    <div className={cn(
      "rounded-t-lg border border-border px-4 py-3 text-center space-y-1",
      isRecommended ? "border-green-300 bg-green-50" : "bg-muted/20"
    )}>
      {isRecommended && (
        <span className="inline-flex items-center rounded-full border border-green-300 bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">
          Recommended
        </span>
      )}
      <p className="text-xs text-muted-foreground font-medium">Offer #{rank}</p>
      <p className={cn("text-lg font-bold", isRecommended ? "text-green-800" : "text-foreground")}>
        {fmt(offer.offer_price)}
      </p>
      <span className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
        offer.status === "accepted"
          ? "border-green-300 bg-green-50 text-green-700"
          : offer.status === "rejected"
          ? "border-red-200 bg-red-50 text-red-700"
          : "border-border bg-background text-muted-foreground"
      )}>
        {offer.status}
      </span>
    </div>
  )
}

// ─── Comparison cell ──────────────────────────────────────────────────────────

function Cell({
  value,
  isBest = false,
}: {
  value:   string | null
  isBest?: boolean
}) {
  return (
    <td className={cn(
      "border border-border px-4 py-3 text-center text-sm",
      isBest ? "bg-green-50 font-semibold text-green-800" : "bg-background text-foreground"
    )}>
      {value ?? "—"}
    </td>
  )
}

// ─── Boolean cell ─────────────────────────────────────────────────────────────

function BoolCell({ value }: { value: boolean | null }) {
  if (value === null) return <td className="border border-border px-4 py-3 text-center"><Minus className="h-4 w-4 mx-auto text-muted-foreground" /></td>
  return (
    <td className="border border-border px-4 py-3 text-center">
      {value
        ? <CheckCircle className="h-4 w-4 mx-auto text-green-600" />
        : <XCircle    className="h-4 w-4 mx-auto text-muted-foreground" />
      }
    </td>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

interface OfferComparisonViewProps {
  offers:             OfferRow[]
  recommendedOfferId: string | null
  listPrice:          number | null
  aiAnalysisNotes:    string | null
}

export function OfferComparisonView({
  offers,
  recommendedOfferId,
  listPrice,
  aiAnalysisNotes,
}: OfferComparisonViewProps) {
  if (!offers || offers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center gap-2">
        <p className="text-sm text-muted-foreground">No offers to compare yet.</p>
      </div>
    )
  }

  // Find best offer price for highlighting
  const maxPrice = Math.max(...offers.map((o) => o.offer_price))

  return (
    <div className="space-y-5">
      {/* AI analysis notes */}
      {aiAnalysisNotes && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
          <p className="text-xs font-semibold text-blue-800 mb-1">AI Analysis</p>
          <p className="text-sm text-blue-800 leading-relaxed">{aiAnalysisNotes}</p>
        </div>
      )}

      {/* Column headers */}
      <div className={cn(
        "grid gap-2",
        offers.length === 1 ? "grid-cols-1" :
        offers.length === 2 ? "grid-cols-2" :
        offers.length === 3 ? "grid-cols-3" : "grid-cols-4"
      )}>
        {offers.map((offer, i) => (
          <OfferColumnHeader
            key={offer.id}
            offer={offer}
            rank={i + 1}
            isRecommended={offer.id === recommendedOfferId}
          />
        ))}
      </div>

      {/* Comparison table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-muted/30">
              <th className="border border-border px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide w-40">
                Term
              </th>
              {offers.map((_, i) => (
                <th key={i} className="border border-border px-4 py-3 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Offer {i + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Price */}
            <tr>
              <td className="border border-border px-4 py-3 text-xs font-medium text-muted-foreground bg-muted/10">Offer Price</td>
              {offers.map((o) => (
                <Cell
                  key={o.id}
                  value={fmt(o.offer_price)}
                  isBest={o.offer_price === maxPrice}
                />
              ))}
            </tr>
            {/* vs list */}
            {listPrice !== null && (
              <tr>
                <td className="border border-border px-4 py-3 text-xs font-medium text-muted-foreground bg-muted/10">vs List Price</td>
                {offers.map((o) => {
                  const diff = ((o.offer_price - listPrice!) / listPrice!) * 100
                  return (
                    <td key={o.id} className={cn(
                      "border border-border px-4 py-3 text-center text-sm font-medium",
                      diff >= 0 ? "text-green-700 bg-green-50" : "text-red-600"
                    )}>
                      {diff >= 0 ? "+" : ""}{diff.toFixed(1)}%
                    </td>
                  )
                })}
              </tr>
            )}
            {/* Earnest money */}
            <tr>
              <td className="border border-border px-4 py-3 text-xs font-medium text-muted-foreground bg-muted/10">Earnest Money</td>
              {offers.map((o) => (
                <Cell key={o.id} value={fmt(o.earnest_money)} />
              ))}
            </tr>
            {/* Down payment */}
            <tr>
              <td className="border border-border px-4 py-3 text-xs font-medium text-muted-foreground bg-muted/10">Down Payment %</td>
              {offers.map((o) => (
                <Cell key={o.id} value={o.down_payment_percent !== null ? `${o.down_payment_percent}%` : null} />
              ))}
            </tr>
            {/* Financing */}
            <tr>
              <td className="border border-border px-4 py-3 text-xs font-medium text-muted-foreground bg-muted/10">Financing</td>
              {offers.map((o) => (
                <Cell key={o.id} value={o.financing_type} />
              ))}
            </tr>
            {/* Closing date */}
            <tr>
              <td className="border border-border px-4 py-3 text-xs font-medium text-muted-foreground bg-muted/10">Closing Date</td>
              {offers.map((o) => (
                <Cell key={o.id} value={formatDate(o.closing_date)} />
              ))}
            </tr>
            {/* Closing credit */}
            <tr>
              <td className="border border-border px-4 py-3 text-xs font-medium text-muted-foreground bg-muted/10">Closing Credit</td>
              {offers.map((o) => (
                <Cell key={o.id} value={o.closing_cost_contribution ? fmt(o.closing_cost_contribution) : "None"} />
              ))}
            </tr>
            {/* Net to seller */}
            <tr className="font-semibold">
              <td className="border border-border px-4 py-3 text-xs font-semibold text-foreground bg-muted/20">Est. Net to Seller</td>
              {offers.map((o) => {
                const maxNet = Math.max(...offers.map((x) => x.seller_net_estimate ?? 0))
                return (
                  <Cell
                    key={o.id}
                    value={o.seller_net_estimate !== null ? fmt(o.seller_net_estimate) : null}
                    isBest={o.seller_net_estimate !== null && o.seller_net_estimate === maxNet}
                  />
                )
              })}
            </tr>
            {/* Escalation clause */}
            <tr>
              <td className="border border-border px-4 py-3 text-xs font-medium text-muted-foreground bg-muted/10">Escalation Clause</td>
              {offers.map((o) => (
                <BoolCell key={o.id} value={o.escalation_clause ?? null} />
              ))}
            </tr>
            {/* Inspection */}
            <tr>
              <td className="border border-border px-4 py-3 text-xs font-medium text-muted-foreground bg-muted/10">Inspection Period</td>
              {offers.map((o) => (
                <Cell key={o.id} value={o.inspection_period_days !== null ? `${o.inspection_period_days} days` : null} />
              ))}
            </tr>
            {/* Financing contingency */}
            <tr>
              <td className="border border-border px-4 py-3 text-xs font-medium text-muted-foreground bg-muted/10">Financing Cont.</td>
              {offers.map((o) => (
                <Cell key={o.id} value={o.financing_contingency_days !== null ? `${o.financing_contingency_days} days` : "Waived"} />
              ))}
            </tr>
            {/* Appraisal */}
            <tr>
              <td className="border border-border px-4 py-3 text-xs font-medium text-muted-foreground bg-muted/10">Appraisal Cont.</td>
              {offers.map((o) => (
                <Cell key={o.id} value={o.appraisal_contingency_days !== null ? `${o.appraisal_contingency_days} days` : "Waived"} />
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        Comparison uses data extracted from uploaded offer documents + information entered during offer creation.
        Net to seller is an estimate only.
      </p>
    </div>
  )
}
