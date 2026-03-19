"use client"

import { Card, CardContent } from "@/components/ui/card"

interface HeatmapLegendProps {
  revenueWeighted: boolean
}

const LEGEND_ITEMS = [
  { type: "Listing", color: "#3B82F6" },
  { type: "Buyer", color: "#22C55E" },
  { type: "Closed", color: "#F59E0B" },
  { type: "Lead", color: "#F97316" },
]

export function HeatmapLegend({ revenueWeighted }: HeatmapLegendProps) {
  return (
    <Card className="bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <CardContent className="p-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            {LEGEND_ITEMS.map((item) => (
              <div key={item.type} className="flex items-center gap-1.5">
                <div
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: item.color }}
                />
                <span className="text-xs text-muted-foreground">{item.type}</span>
              </div>
            ))}
          </div>
          {revenueWeighted && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground border-t pt-2 mt-1">
              <div className="flex items-center gap-1">
                <div className="h-2 w-2 rounded-full bg-gray-400" />
                <span>Small</span>
              </div>
              <div className="h-px w-4 bg-gray-300" />
              <div className="flex items-center gap-1">
                <div className="h-4 w-4 rounded-full bg-gray-400" />
                <span>Large = Higher Revenue</span>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
