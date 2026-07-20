"use client"

import { useState, useEffect, useMemo } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { deriveNetSheetClosingCostSection } from "@/lib/offers/seller-closing-costs"

interface NetSheetProps {
  offerPrice: number
  listPrice: number
  currentMortgageBalance: number
  propertyAddress: string
  /** The property's state ("TX" / "Texas"). When known, the closing-costs
   *  default derives from that state's REAL closing conventions
   *  (lib/offers/seller-closing-costs) and the regional section renders with
   *  its provenance label. Unknown → the flat 2% starting point stands. */
  state?: string | null
}

export function NetSheetCalculator({ offerPrice, listPrice, currentMortgageBalance, propertyAddress, state = null }: NetSheetProps) {
  const [price, setPrice] = useState(offerPrice)
  const [commissionRate, setCommissionRate] = useState(6)

  // REGIONAL CLOSING-COST SECTION (keep-one: the seller closing-cost model
  // supplies this calculator's closing-cost line; this surface stays the
  // canonical portal net view). Recomputed as the price slider moves.
  const closingCostSection = useMemo(
    () => deriveNetSheetClosingCostSection(price, state),
    [price, state],
  )
  const initialSection = deriveNetSheetClosingCostSection(offerPrice, state)
  const [closingCosts, setClosingCosts] = useState(initialSection ? initialSection.midpoint : offerPrice * 0.02)
  // Manual override preserved: once the seller edits the field, the regional
  // default stops following the price slider.
  const [closingCostsOverridden, setClosingCostsOverridden] = useState(false)
  useEffect(() => {
    if (!closingCostsOverridden && closingCostSection) setClosingCosts(closingCostSection.midpoint)
  }, [closingCostSection, closingCostsOverridden])

  const [liens, setLiens] = useState(0)
  const [hoaFees, setHoaFees] = useState(0)
  const [prorations, setProrations] = useState(0)

  const [commission, setCommission] = useState(0)
  const [netProceeds, setNetProceeds] = useState(0)

  useEffect(() => {
    const calc = {
      commission: price * (commissionRate / 100),
      netProceeds:
        price - price * (commissionRate / 100) - closingCosts - currentMortgageBalance - liens - hoaFees + prorations,
    }
    setCommission(calc.commission)
    setNetProceeds(calc.netProceeds)
  }, [price, commissionRate, closingCosts, currentMortgageBalance, liens, hoaFees, prorations])

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
      amount,
    )
  }

  const calculateScenarioNet = (scenarioPrice: number) => {
    return (
      scenarioPrice -
      scenarioPrice * (commissionRate / 100) -
      closingCosts -
      currentMortgageBalance -
      liens -
      hoaFees +
      prorations
    )
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Your Net Proceeds Calculator</CardTitle>
        <p className="text-sm text-muted-foreground">See exactly what you'll walk away with at closing</p>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Sale Price */}
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <Label>Sale Price</Label>
            <span className="text-2xl font-bold text-green-600">{formatCurrency(price)}</span>
          </div>
          <Slider
            value={[price]}
            onValueChange={(value) => setPrice(value[0])}
            min={listPrice * 0.85}
            max={listPrice * 1.15}
            step={1000}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{formatCurrency(listPrice * 0.85)}</span>
            <span>List: {formatCurrency(listPrice)}</span>
            <span>{formatCurrency(listPrice * 1.15)}</span>
          </div>
        </div>

        <Separator />

        {/* Deductions */}
        <div className="space-y-4">
          <h3 className="font-semibold">Deductions</h3>

          {/* Commission */}
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <Label>Commission ({commissionRate}%)</Label>
              <span className="text-red-600">-{formatCurrency(commission)}</span>
            </div>
            <Slider
              value={[commissionRate]}
              onValueChange={(value) => setCommissionRate(value[0])}
              min={4}
              max={7}
              step={0.5}
              className="w-full"
            />
          </div>

          {/* Closing Costs — regional band default when the state is known; the input is the manual override */}
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <Label htmlFor="closingCosts">Closing Costs (estimated)</Label>
              <Input
                id="closingCosts"
                type="number"
                value={closingCosts}
                onChange={(e) => {
                  setClosingCostsOverridden(true)
                  setClosingCosts(Number(e.target.value))
                }}
                className="w-32 text-right"
              />
            </div>
            <span className="text-red-600 text-right block text-sm">-{formatCurrency(closingCosts)}</span>
            {closingCostSection && (
              <div className="rounded-md border bg-muted/40 p-3 space-y-1">
                <p className="text-xs font-semibold">
                  Seller closing costs · {closingCostSection.regionLabel}
                </p>
                {closingCostSection.lines.map((l) => (
                  <div key={l.label} className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                    <span>{l.label}</span>
                    <span className="tabular-nums whitespace-nowrap">
                      {formatCurrency(l.low)}{l.high !== l.low ? `–${formatCurrency(l.high)}` : ""}
                    </span>
                  </div>
                ))}
                <div className="flex items-baseline justify-between gap-3 border-t pt-1 text-xs font-semibold">
                  <span>Band total</span>
                  <span className="tabular-nums whitespace-nowrap">
                    {formatCurrency(closingCostSection.low)}–{formatCurrency(closingCostSection.high)}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-snug">
                  The field above starts at this band's midpoint
                  {closingCostsOverridden ? " (you've overridden it)" : ""} — a {closingCostSection.regionLabel},
                  not a quote. Commission and mortgage payoff are their own lines. The settlement statement is
                  the authority.
                </p>
              </div>
            )}
          </div>

          {/* Mortgage Payoff */}
          <div className="flex justify-between items-center">
            <Label>Mortgage Payoff</Label>
            <span className="text-red-600">-{formatCurrency(currentMortgageBalance)}</span>
          </div>

          {/* Liens */}
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <Label htmlFor="liens">Liens / HOA Dues</Label>
              <Input
                id="liens"
                type="number"
                value={liens}
                onChange={(e) => setLiens(Number(e.target.value))}
                className="w-32 text-right"
                placeholder="0"
              />
            </div>
            {liens > 0 && <span className="text-red-600 text-right block text-sm">-{formatCurrency(liens)}</span>}
          </div>

          {/* Prorations */}
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <Label htmlFor="prorations">Prorations (taxes, HOA)</Label>
              <Input
                id="prorations"
                type="number"
                value={prorations}
                onChange={(e) => setProrations(Number(e.target.value))}
                className="w-32 text-right"
                placeholder="0"
              />
            </div>
            {prorations !== 0 && (
              <span className={`${prorations > 0 ? "text-green-600" : "text-red-600"} text-right block text-sm`}>
                {prorations > 0 ? "+" : ""}
                {formatCurrency(prorations)}
              </span>
            )}
          </div>
        </div>

        <Separator />

        {/* Net Proceeds */}
        <div className="bg-gradient-to-r from-green-50 to-emerald-50 p-6 rounded-lg border-2 border-green-200">
          <div className="flex justify-between items-center">
            <div>
              <p className="text-sm text-muted-foreground mb-1">Your Net Proceeds</p>
              <p className="text-4xl font-bold text-green-700">{formatCurrency(netProceeds)}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">After all costs</p>
              <p className="text-sm text-green-600">{((netProceeds / price) * 100).toFixed(1)}% of sale price</p>
            </div>
          </div>
        </div>

        {/* Scenario Comparison */}
        <div className="space-y-3">
          <h4 className="font-semibold text-sm">Quick Scenarios</h4>
          <div className="grid grid-cols-3 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPrice(listPrice * 0.95)}
              className="flex flex-col h-auto py-2"
            >
              <span className="font-semibold">5% Below Ask</span>
              <span className="text-xs text-muted-foreground mt-1">
                Net: {formatCurrency(calculateScenarioNet(listPrice * 0.95))}
              </span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPrice(listPrice)}
              className="flex flex-col h-auto py-2"
            >
              <span className="font-semibold">Full Ask</span>
              <span className="text-xs text-muted-foreground mt-1">
                Net: {formatCurrency(calculateScenarioNet(listPrice))}
              </span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPrice(listPrice * 1.05)}
              className="flex flex-col h-auto py-2"
            >
              <span className="font-semibold">5% Over Ask</span>
              <span className="text-xs text-muted-foreground mt-1">
                Net: {formatCurrency(calculateScenarioNet(listPrice * 1.05))}
              </span>
            </Button>
          </div>
        </div>

        {/* Download PDF */}
        <Button className="w-full" variant="default">
          Download Net Sheet PDF
        </Button>

        {/* Disclaimer */}
        <p className="text-xs text-muted-foreground text-center">
          *This is an estimate. Final numbers determined at closing with title company.
        </p>
      </CardContent>
    </Card>
  )
}
