"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { TrendingUp, DollarSign, ExternalLink, Loader2, BarChart3 } from "lucide-react"
import { getBreakEvenAnalysis, getRecruitingCostBreakdown } from "@/app/actions/recruiting-roi"
import Link from "next/link"

interface Props {
  brokerageId: string
  breakEvenAnalysis: {
    avgBreakEvenMonth: number
    breakEvenMonths: { recruitId?: string; months: number }[]
  }
  costBreakdown: {
    training: number
    marketing: number
    technology: number
    bonuses: number
    guarantees: number
    other: number
  }
}

export function BrokerRecruitingActionBar({ brokerageId, breakEvenAnalysis, costBreakdown }: Props) {
  const [sheet, setSheet] = useState<"break-even" | "cost" | null>(null)
  const [liveBreakEven, setLiveBreakEven] = useState(breakEvenAnalysis)
  const [liveCost, setLiveCost] = useState(costBreakdown)
  const [isPending, startTransition] = useTransition()

  function openBreakEven() {
    setSheet("break-even")
    startTransition(async () => {
      const result = await getBreakEvenAnalysis(brokerageId).catch(() => liveBreakEven)
      setLiveBreakEven(result)
    })
  }

  function openCostBreakdown() {
    setSheet("cost")
    startTransition(async () => {
      const result = await getRecruitingCostBreakdown(brokerageId).catch(() => liveCost)
      setLiveCost(result)
    })
  }

  const totalCost = Object.values(liveCost).reduce((a, b) => a + b, 0)

  return (
    <>
      <Card className="border-border">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <TrendingUp className="h-4 w-4 text-emerald-600" />
            Recruiting Correction Actions
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={openBreakEven}
            disabled={isPending}
          >
            {isPending && sheet === "break-even" ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <BarChart3 className="h-4 w-4 mr-2" />
            )}
            View Break-Even Analysis
            {liveBreakEven.avgBreakEvenMonth > 18 && (
              <Badge variant="destructive" className="ml-auto text-xs">
                {liveBreakEven.avgBreakEvenMonth.toFixed(0)}mo avg
              </Badge>
            )}
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={openCostBreakdown}
            disabled={isPending}
          >
            {isPending && sheet === "cost" ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <DollarSign className="h-4 w-4 mr-2" />
            )}
            View Cost Breakdown
          </Button>

          <Link href="/dashboard/recruiting-roi">
            <Button variant="ghost" size="sm" className="w-full justify-start">
              <ExternalLink className="h-4 w-4 mr-2" />
              Open Full Recruiting
            </Button>
          </Link>
        </CardContent>
      </Card>

      {/* Break-Even Sheet */}
      <Sheet open={sheet === "break-even"} onOpenChange={(open) => !open && setSheet(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Break-Even Analysis</SheetTitle>
            <SheetDescription>Months to break even per recruit</SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-4">
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted">
              <span className="text-sm font-medium">Average Break-Even</span>
              <Badge variant={liveBreakEven.avgBreakEvenMonth > 18 ? "destructive" : liveBreakEven.avgBreakEvenMonth > 12 ? "secondary" : "outline"}>
                {liveBreakEven.avgBreakEvenMonth.toFixed(1)} months
              </Badge>
            </div>
            {liveBreakEven.breakEvenMonths.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Per Recruit</p>
                {liveBreakEven.breakEvenMonths.slice(0, 10).map((item, i) => (
                  <div key={i} className="flex items-center justify-between text-sm border-b pb-1">
                    <span className="text-muted-foreground">Recruit #{i + 1}</span>
                    <span className={item.months > 18 ? "text-red-600 font-semibold" : "font-medium"}>
                      {item.months} mo
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">No per-recruit data available</p>
            )}
            <Link href="/dashboard/recruiting-roi">
              <Button className="w-full mt-4">
                <ExternalLink className="h-4 w-4 mr-2" />
                Open Recruiting ROI
              </Button>
            </Link>
          </div>
        </SheetContent>
      </Sheet>

      {/* Cost Breakdown Sheet */}
      <Sheet open={sheet === "cost"} onOpenChange={(open) => !open && setSheet(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Recruiting Cost Breakdown</SheetTitle>
            <SheetDescription>Cost per channel and total investment</SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-3">
            {([
              ["Training", liveCost.training],
              ["Marketing", liveCost.marketing],
              ["Technology", liveCost.technology],
              ["Bonuses", liveCost.bonuses],
              ["Guarantees", liveCost.guarantees],
              ["Other", liveCost.other],
            ] as [string, number][]).map(([label, value]) => (
              <div key={label} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium">
                  ${value.toLocaleString()}
                  <span className="text-xs text-muted-foreground ml-1">
                    ({totalCost > 0 ? ((value / totalCost) * 100).toFixed(0) : 0}%)
                  </span>
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between text-sm font-semibold border-t pt-2">
              <span>Total Investment</span>
              <span>${totalCost.toLocaleString()}</span>
            </div>
            <Link href="/dashboard/recruiting-roi">
              <Button className="w-full mt-4">
                <ExternalLink className="h-4 w-4 mr-2" />
                Open Recruiting ROI
              </Button>
            </Link>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
