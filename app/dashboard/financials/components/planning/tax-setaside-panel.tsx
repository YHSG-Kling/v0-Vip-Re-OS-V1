"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { PiggyBank, Check, Info } from "lucide-react"
import { toast } from "sonner"

interface TaxSetasidePanelProps {
  ytdGCI: number
  setAsidePercent: number
  onUpdatePercent: (pct: number) => void
}

export function TaxSetasidePanel({
  ytdGCI,
  setAsidePercent,
  onUpdatePercent,
}: TaxSetasidePanelProps) {
  const [localPercent, setLocalPercent] = useState(setAsidePercent)
  const [tracked, setTracked] = useState(false)

  const setAsideAmount = (ytdGCI * localPercent) / 100
  const quarterlyPaymentEstimate = setAsideAmount / 4
  const monthsOfPayments = quarterlyPaymentEstimate > 0 ? Math.floor(setAsideAmount / quarterlyPaymentEstimate) : 0

  const handleSliderChange = (value: number[]) => {
    setLocalPercent(value[0])
    onUpdatePercent(value[0])
  }

  const handleAddToTracking = () => {
    setTracked(true)
    toast.success(`Set-aside of ${localPercent}% tracked`, {
      description: `$${setAsideAmount.toLocaleString()} earmarked for taxes`,
    })
    setTimeout(() => setTracked(false), 3000)
  }

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PiggyBank className="h-5 w-5 text-green-600" />
          Tax Set-Aside Calculator
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Slider */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Set-aside percentage</span>
            <span className="text-lg font-semibold">{localPercent}%</span>
          </div>
          <Slider
            value={[localPercent]}
            onValueChange={handleSliderChange}
            min={0}
            max={35}
            step={1}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>0%</span>
            <span>35%</span>
          </div>
        </div>

        {/* Amount display */}
        <div className="p-4 rounded-lg bg-green-50 border border-green-200 text-center">
          <p className="text-sm text-green-700">Set aside from your gross</p>
          <p className="text-3xl font-bold text-green-800">{formatCurrency(setAsideAmount)}</p>
        </div>

        {/* Recommended range */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50">
          <Info className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <p className="font-medium">Recommended: 25-30%</p>
            <p className="text-muted-foreground">
              Most self-employed agents should set aside 25-30% of gross income for federal and state taxes.
            </p>
          </div>
        </div>

        {/* Months of payments */}
        <div className="text-center text-sm text-muted-foreground">
          This represents{" "}
          <span className="font-semibold text-foreground">{monthsOfPayments} quarters</span>{" "}
          of projected quarterly payments
        </div>

        {/* Add to tracking button */}
        <Button
          onClick={handleAddToTracking}
          disabled={tracked}
          className="w-full"
          variant={tracked ? "secondary" : "default"}
        >
          {tracked ? (
            <>
              <Check className="h-4 w-4 mr-2" />
              Tracked
            </>
          ) : (
            "Add to Tracking"
          )}
        </Button>
      </CardContent>
    </Card>
  )
}
