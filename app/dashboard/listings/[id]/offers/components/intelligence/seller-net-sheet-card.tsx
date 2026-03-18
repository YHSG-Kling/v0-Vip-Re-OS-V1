"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Calculator, Loader2, DollarSign, TrendingUp, AlertCircle } from "lucide-react"
import { generateSellerNetSheet } from "@/app/actions/ai-listing-presentation"

interface SellerNetSheetCardProps {
  offer: {
    id: string
    offer_price: number
    offer_number: string | null
  }
  listing: {
    id: string
    state: string | null
    agent_id: string | null
  }
  agentId: string
  // Optional pre-filled values
  mortgagePayoff?: number
  commissionRate?: number
  county?: string
}

interface NetSheetResult {
  estimatedProceeds: number
  breakdown: {
    salePrice: number
    totalCommission: number
    closingCosts: number
    mortgagePayoff: number
    transferTaxes: number
    otherDeductions: number
  }
  explanation: string
  comparisonNote?: string
}

export function SellerNetSheetCard({
  offer,
  listing,
  agentId,
  mortgagePayoff: initialMortgage = 0,
  commissionRate: initialCommission = 6,
  county: initialCounty = "",
}: SellerNetSheetCardProps) {
  const [isPending, startTransition] = useTransition()
  const [result, setResult] = useState<NetSheetResult | null>(null)
  const [showForm, setShowForm] = useState(false)

  // Form state for required params
  const [mortgagePayoff, setMortgagePayoff] = useState(initialMortgage.toString())
  const [commissionRate, setCommissionRate] = useState(initialCommission.toString())
  const [county, setCounty] = useState(initialCounty)

  const state = listing.state ?? "FL"
  const canGenerate = !!agentId && offer.offer_price > 0 && !!state

  function handleGenerate() {
    startTransition(async () => {
      const res = await generateSellerNetSheet({
        agentId,
        salePrice: offer.offer_price,
        mortgagePayoff: parseFloat(mortgagePayoff) || 0,
        commissionRate: parseFloat(commissionRate) || 6,
        state,
        county: county || undefined,
        additionalCosts: [],
      })

      if (res.success && res.netSheet) {
        setResult(res.netSheet as NetSheetResult)
        setShowForm(false)
      }
    })
  }

  if (!canGenerate) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Calculator className="h-4 w-4 text-indigo-600" />
            Seller Net Sheet
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="p-3 bg-amber-50 rounded-lg flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-700">
              Missing required data to calculate net sheet.
              {!state && " State is required."}
              {!agentId && " Agent ID is required."}
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Calculator className="h-4 w-4 text-indigo-600" />
            Seller Net Sheet
          </CardTitle>
          {result && (
            <Badge variant="outline" className="text-xs text-green-700 border-green-300">
              Calculated
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!result && !showForm && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Calculate estimated proceeds for this ${offer.offer_price.toLocaleString()} offer.
            </p>
            <Button size="sm" onClick={() => setShowForm(true)} className="w-full">
              <Calculator className="h-3.5 w-3.5 mr-1.5" />
              Calculate Net Proceeds
            </Button>
          </div>
        )}

        {showForm && !result && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Mortgage Payoff</Label>
                <Input
                  type="number"
                  placeholder="0"
                  value={mortgagePayoff}
                  onChange={(e) => setMortgagePayoff(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs">Commission Rate (%)</Label>
                <Input
                  type="number"
                  placeholder="6"
                  value={commissionRate}
                  onChange={(e) => setCommissionRate(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">County (optional)</Label>
              <Input
                placeholder="e.g., Miami-Dade"
                value={county}
                onChange={(e) => setCounty(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleGenerate} disabled={isPending} className="flex-1">
                {isPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Calculator className="h-3.5 w-3.5 mr-1.5" />
                )}
                Generate Net Sheet
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-4">
            {/* Estimated Proceeds */}
            <div className="p-4 bg-green-50 rounded-lg">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-green-700">Estimated Net Proceeds</span>
                <TrendingUp className="h-4 w-4 text-green-600" />
              </div>
              <p className="text-2xl font-bold text-green-700">
                ${result.estimatedProceeds.toLocaleString()}
              </p>
            </div>

            {/* Breakdown */}
            <div className="space-y-2 text-xs">
              <div className="flex justify-between py-1 border-b">
                <span className="text-muted-foreground">Sale Price</span>
                <span className="font-medium">${result.breakdown.salePrice.toLocaleString()}</span>
              </div>
              <div className="flex justify-between py-1 border-b">
                <span className="text-muted-foreground">Commission ({commissionRate}%)</span>
                <span className="font-medium text-red-600">
                  -${result.breakdown.totalCommission.toLocaleString()}
                </span>
              </div>
              {result.breakdown.mortgagePayoff > 0 && (
                <div className="flex justify-between py-1 border-b">
                  <span className="text-muted-foreground">Mortgage Payoff</span>
                  <span className="font-medium text-red-600">
                    -${result.breakdown.mortgagePayoff.toLocaleString()}
                  </span>
                </div>
              )}
              <div className="flex justify-between py-1 border-b">
                <span className="text-muted-foreground">Closing Costs</span>
                <span className="font-medium text-red-600">
                  -${result.breakdown.closingCosts.toLocaleString()}
                </span>
              </div>
              {result.breakdown.transferTaxes > 0 && (
                <div className="flex justify-between py-1 border-b">
                  <span className="text-muted-foreground">Transfer Taxes ({state})</span>
                  <span className="font-medium text-red-600">
                    -${result.breakdown.transferTaxes.toLocaleString()}
                  </span>
                </div>
              )}
            </div>

            {/* AI Explanation */}
            {result.explanation && (
              <div className="p-3 bg-muted/40 rounded-lg">
                <p className="text-xs text-muted-foreground">{result.explanation}</p>
              </div>
            )}

            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setResult(null)
                setShowForm(true)
              }}
              className="w-full text-xs"
            >
              Recalculate with Different Values
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
