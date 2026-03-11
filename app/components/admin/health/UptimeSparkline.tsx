"use client"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

interface UptimeSparklineProps {
  data: {
    snapshot_date: string
    uptime_pct: number
  }[]
}

export function UptimeSparkline({ data }: UptimeSparklineProps) {
  const getBarColor = (uptime: number) => {
    if (uptime >= 99.9) return "bg-green-500"
    if (uptime >= 95) return "bg-amber-500"
    return "bg-destructive"
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  }

  // Ensure we have 7 days of data, fill with placeholder if needed
  const paddedData = [...data]
  while (paddedData.length < 7) {
    const lastDate = paddedData.length > 0 
      ? new Date(paddedData[paddedData.length - 1].snapshot_date)
      : new Date()
    lastDate.setDate(lastDate.getDate() + 1)
    paddedData.push({
      snapshot_date: lastDate.toISOString().split("T")[0],
      uptime_pct: 100,
    })
  }

  return (
    <TooltipProvider>
      <div className="flex items-end gap-1 h-8">
        {paddedData.slice(-7).map((day, index) => {
          const height = Math.max(10, (day.uptime_pct / 100) * 32)
          return (
            <Tooltip key={index}>
              <TooltipTrigger asChild>
                <div
                  className={`flex-1 rounded-sm ${getBarColor(day.uptime_pct)} transition-all hover:opacity-80 cursor-pointer`}
                  style={{ height: `${height}px` }}
                />
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">
                  {formatDate(day.snapshot_date)}: {day.uptime_pct.toFixed(2)}%
                </p>
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
  )
}
