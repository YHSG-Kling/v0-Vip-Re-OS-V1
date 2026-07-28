"use client"

/**
 * app/components/features/offers/interactive-net-sheet.tsx
 *
 * INTERACTIVE seller net sheet — the side-by-side, recompute-live comparison the agent
 * (or seller) uses to see WHICH OFFER NETS THE SELLER MOST as they adjust assumptions
 * (commission %, mortgage payoff, county/city taxes, HOA proration, other prorated fees).
 *
 * The net math is the SAME pure engine the kernel/cron use — computeNetProceeds +
 * rankOffersByNet from lib/kernel/offer-net-sheet (pure, non-server-only) — so the
 * number the seller sees here is the number the portal card and agent summary report.
 * No new math here; this is the editable surface on top of the consolidated engine.
 *
 * Surfaced on the agent's offer view AND reusable by the seller portal (read-only mode
 * via `readOnly`). Self-contained and compiling.
 */

import { useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Calculator, TrendingUp, Trophy } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  rankOffersByNet,
  counterScenario,
  type OfferNetInput,
  type SellerCosts,
} from "@/lib/offers/net-sheet-calc"
import type { NetSheetClosingCostSection } from "@/lib/offers/seller-closing-costs"

interface InteractiveNetSheetProps {
  listingAddress?: string | null
  /** Offers to compare (offer price + each offer's buyer closing credit). */
  offers: OfferNetInput[]
  /** Starting cost assumptions — the agent/seller edits these live. */
  initialCosts: Omit<SellerCosts, "buyerClosingCredit">
  /** When true, inputs are disabled (seller portal read-only view). */
  readOnly?: boolean
  /** The regional seller closing-cost section (keep-one: derived by the caller
   *  via lib/offers/seller-closing-costs when the listing's state is known).
   *  Display + provenance only — "Other prorated fees" starts at the band's
   *  midpoint and the field above stays editable (manual override preserved). */
  closingCostSection?: NetSheetClosingCostSection | null
}

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
}

function NumberField({
  label,
  value,
  onChange,
  readOnly,
  isPercent = false,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  readOnly?: boolean
  isPercent?: boolean
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="relative">
        {!isPercent && (
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
        )}
        <Input
          type="number"
          inputMode="decimal"
          disabled={readOnly}
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
          className={cn("h-8 text-sm text-right", !isPercent && "pl-5", isPercent && "pr-6")}
        />
        {isPercent && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
        )}
      </div>
    </div>
  )
}

export function InteractiveNetSheet({
  listingAddress,
  offers,
  initialCosts,
  readOnly = false,
  closingCostSection = null,
}: InteractiveNetSheetProps) {
  // Commission held as a percent for the UI; converted to decimal for the engine.
  const [commissionPct, setCommissionPct] = useState(Math.round(initialCosts.commissionRate * 1000) / 10)
  const [mortgagePayoff, setMortgagePayoff] = useState(initialCosts.mortgagePayoff)
  const [countyCityTaxes, setCountyCityTaxes] = useState(initialCosts.countyCityTaxes)
  const [hoaDuesProration, setHoaDuesProration] = useState(initialCosts.hoaDuesProration)
  const [otherProratedFees, setOtherProratedFees] = useState(initialCosts.otherProratedFees)
  // Brokerage transaction fee charged to the SELLER — flat dollars, not a percentage.
  const [transactionFee, setTransactionFee] = useState(initialCosts.transactionFee)
  const [counterPrice, setCounterPrice] = useState<number | null>(null)

  const ranking = useMemo(
    () =>
      rankOffersByNet(offers, {
        commissionRate: commissionPct / 100,
        mortgagePayoff,
        countyCityTaxes,
        hoaDuesProration,
        otherProratedFees,
        transactionFee,
      }),
    [offers, commissionPct, mortgagePayoff, countyCityTaxes, hoaDuesProration, otherProratedFees, transactionFee],
  )

  const netWinner = ranking.lines.find((l) => l.offerId === ranking.topByNet)
  const priceWinner = ranking.lines.find((l) => l.offerId === ranking.topByPrice)
  const counter = useMemo(() => {
    if (!netWinner || counterPrice === null || !Number.isFinite(counterPrice) || counterPrice <= 0) return null
    return counterScenario(
      { offerPrice: netWinner.offerPrice, buyerClosingCredit: netWinner.buyerClosingCredit },
      counterPrice,
      { commissionRate: commissionPct / 100, mortgagePayoff, countyCityTaxes, hoaDuesProration, otherProratedFees, transactionFee },
    )
  }, [netWinner, counterPrice, commissionPct, mortgagePayoff, countyCityTaxes, hoaDuesProration, otherProratedFees, transactionFee])
  const delta =
    netWinner && priceWinner && ranking.netBeatsPrice ? netWinner.netProceeds - priceWinner.netProceeds : 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Calculator className="h-4 w-4 text-indigo-600" />
          Interactive Net Sheet
          {listingAddress ? <span className="text-muted-foreground font-normal">· {listingAddress}</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Headline: which offer nets the most */}
        {netWinner && (
          <div
            className={cn(
              "rounded-lg p-4",
              ranking.netBeatsPrice ? "bg-amber-50 border border-amber-200" : "bg-green-50 border border-green-200",
            )}
          >
            <div className="flex items-center gap-2 mb-1">
              <Trophy className={cn("h-4 w-4", ranking.netBeatsPrice ? "text-amber-600" : "text-green-600")} />
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Best net to seller
              </span>
            </div>
            <p className="text-2xl font-bold text-foreground">
              {netWinner.buyerName ?? "Top offer"} · {fmt(netWinner.netProceeds)}
            </p>
            {ranking.netBeatsPrice && delta > 0 && (
              <p className="text-xs text-amber-700 mt-1">
                Nets ~{fmt(delta)} more than the highest-priced offer ({priceWinner?.buyerName ?? "—"}) despite a
                lower price.
              </p>
            )}
          </div>
        )}

        {/* Editable shared assumptions */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Seller-responsible costs {readOnly ? "" : "(adjust live)"}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <NumberField label="Commission" value={commissionPct} onChange={setCommissionPct} readOnly={readOnly} isPercent />
            <NumberField label="Mortgage payoff" value={mortgagePayoff} onChange={setMortgagePayoff} readOnly={readOnly} />
            <NumberField label="County/city taxes" value={countyCityTaxes} onChange={setCountyCityTaxes} readOnly={readOnly} />
            <NumberField label="HOA dues/proration" value={hoaDuesProration} onChange={setHoaDuesProration} readOnly={readOnly} />
            <NumberField label="Other prorated fees" value={otherProratedFees} onChange={setOtherProratedFees} readOnly={readOnly} />
            <NumberField label="Transaction fee (flat)" value={transactionFee} onChange={setTransactionFee} readOnly={readOnly} />
          </div>
          {mortgagePayoff === 0 && (
            <p className="mt-2 text-xs text-red-700">
              ⛔ Payoff is still $0 — every net figure above overstates what the seller keeps. Enter the real payoff before presenting.
            </p>
          )}

          {/* REGIONAL CLOSING-COST SECTION (keep-one: lib/offers/seller-closing-costs).
              Provenance display for the "Other prorated fees" default — the field above
              stays editable, so a manual override always wins. */}
          {closingCostSection && (
            <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-900">
                Seller closing costs · {closingCostSection.regionLabel}
              </p>
              <div className="mt-2 space-y-1">
                {closingCostSection.lines.map((l) => (
                  <div key={l.label} className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-muted-foreground">{l.label}</span>
                    <span className="tabular-nums whitespace-nowrap font-medium">
                      {fmt(l.low)}{l.high !== l.low ? `–${fmt(l.high)}` : ""}
                    </span>
                  </div>
                ))}
                <div className="flex items-baseline justify-between gap-3 border-t border-indigo-200 pt-1 text-xs font-semibold">
                  <span>Band total</span>
                  <span className="tabular-nums whitespace-nowrap">
                    {fmt(closingCostSection.low)}–{fmt(closingCostSection.high)}
                  </span>
                </div>
              </div>
              <p className="mt-2 text-[11px] leading-snug text-indigo-900/80">
                "Other prorated fees" starts at this band's midpoint ({fmt(closingCostSection.midpoint)}) — a{" "}
                {closingCostSection.regionLabel}, not a quote. Edit the field to override; the settlement
                statement is the authority.
              </p>
            </div>
          )}
        </div>

        {/* Counter what-if — "what if we counter at X?" recomputed live */}
        {!readOnly && netWinner && (
          <div className="rounded-lg border p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              What if we counter?
            </p>
            <div className="flex items-end gap-3">
              <div className="w-40">
                <Label className="text-xs">Counter price</Label>
                <Input
                  type="number"
                  value={counterPrice ?? ""}
                  onChange={(e) => setCounterPrice(e.target.value === "" ? null : Number(e.target.value))}
                  placeholder={String(netWinner.offerPrice)}
                  className="h-8 text-sm"
                />
              </div>
              {counter && (
                <div className="flex-1 text-sm">
                  <span className="font-semibold">{fmt(counter.netProceeds)} net</span>
                  <span className={cn("ml-2 text-xs", counter.deltaVsOffer >= 0 ? "text-green-700" : "text-red-700")}>
                    {counter.deltaVsOffer >= 0 ? "+" : ""}{fmt(counter.deltaVsOffer)} vs {netWinner.buyerName ?? "the top-net offer"}
                  </span>
                  <p className="text-xs text-muted-foreground mt-0.5">{counter.explanation}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Side-by-side comparison */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="text-left py-2 font-medium">Line</th>
                {ranking.lines.map((l, i) => (
                  <th key={l.offerId} className="text-right py-2 font-medium whitespace-nowrap px-2">
                    {l.buyerName ?? `Offer ${String.fromCharCode(65 + i)}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <Row label="Offer price" lines={ranking.lines} pick={(l) => l.offerPrice} />
              <Row label="Commission" lines={ranking.lines} pick={(l) => l.commission} subtract />
              <Row label="Mortgage payoff" lines={ranking.lines} pick={(l) => l.mortgagePayoff} subtract />
              <Row label="County/city taxes" lines={ranking.lines} pick={(l) => l.countyCityTaxes} subtract />
              <Row label="HOA dues/proration" lines={ranking.lines} pick={(l) => l.hoaDuesProration} subtract />
              <Row label="Other prorated fees" lines={ranking.lines} pick={(l) => l.otherProratedFees} subtract />
              <Row label="Transaction fee" lines={ranking.lines} pick={(l) => l.transactionFee} subtract />
              <Row label="Buyer closing credit" lines={ranking.lines} pick={(l) => l.buyerClosingCredit} subtract />
              <tr className="border-t-2 border-foreground/20">
                <td className="py-2 font-semibold flex items-center gap-1">
                  <TrendingUp className="h-3.5 w-3.5 text-green-600" /> Net proceeds
                </td>
                {ranking.lines.map((l) => (
                  <td
                    key={l.offerId}
                    className={cn(
                      "text-right py-2 px-2 font-bold tabular-nums whitespace-nowrap",
                      l.offerId === ranking.topByNet ? "text-green-700" : "text-foreground",
                    )}
                  >
                    {fmt(l.netProceeds)}
                    {l.offerId === ranking.topByNet && (
                      <Badge variant="outline" className="ml-1 text-[10px] text-green-700 border-green-300">
                        best
                      </Badge>
                    )}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed">
          Estimate only. Payoff, prorated taxes, HOA and other fees are starting assumptions — edit them with your
          final figures. Actual net proceeds are set on the closing statement.
        </p>
      </CardContent>
    </Card>
  )
}

function Row({
  label,
  lines,
  pick,
  subtract = false,
}: {
  label: string
  lines: ReturnType<typeof rankOffersByNet>["lines"]
  pick: (l: ReturnType<typeof rankOffersByNet>["lines"][number]) => number
  subtract?: boolean
}) {
  return (
    <tr className="border-b border-border/40">
      <td className="py-1.5 text-muted-foreground">{label}</td>
      {lines.map((l) => {
        const v = pick(l)
        return (
          <td
            key={l.offerId}
            className={cn("text-right py-1.5 px-2 tabular-nums whitespace-nowrap", subtract && v > 0 && "text-red-600")}
          >
            {subtract && v > 0 ? `(${fmt(v)})` : fmt(v)}
          </td>
        )
      })}
    </tr>
  )
}
