"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Users, Cpu, HardDrive, Video } from "lucide-react"
import { formatSeatLimit, normalizeCatalogSeatLimit } from "@/lib/kernel/tier-role-matrix"

interface UsageSectionProps {
  usage: {
    active_agents?: number
    ai_calls_count?: number
    storage_bytes?: number
    video_minutes?: number
  } | null
  /** Catalogue seat cap. `null` = UNLIMITED — the spelling the live
   *  multi_location tier actually stores in subscription_tiers.max_agents.
   *  This used to be a bare `number` fed by `max_agents || 1`, which turned
   *  the unlimited plan into a ONE-seat cap and drew the bar pegged at 100%. */
  maxAgents: number | null
  aiCallsLimit: number
  storageLimitGb: number
  videoMinutesLimit: number
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 GB"
  const gb = bytes / (1024 * 1024 * 1024)
  return `${gb.toFixed(2)} GB`
}

function getProgressColor(percent: number): string {
  if (percent >= 95) return "bg-red-500"
  if (percent >= 80) return "bg-amber-500"
  return "bg-blue-500"
}

export function UsageSection({
  usage,
  maxAgents,
  aiCallsLimit,
  storageLimitGb,
  videoMinutesLimit,
}: UsageSectionProps) {
  const activeAgents = usage?.active_agents || 0
  const aiCalls = usage?.ai_calls_count || 0
  const storageBytes = usage?.storage_bytes || 0
  const videoMinutes = usage?.video_minutes || 0

  // null = unlimited ⇒ no percentage to draw. Folded through the ONE shared
  // normalizer so display and the seat gate cannot disagree.
  const seatCap = normalizeCatalogSeatLimit(maxAgents)
  const agentPercent = seatCap !== null && seatCap > 0 ? Math.min((activeAgents / seatCap) * 100, 100) : 0
  const aiPercent = aiCallsLimit > 0 ? Math.min((aiCalls / aiCallsLimit) * 100, 100) : 0
  const storagePercent = storageLimitGb > 0 
    ? Math.min((storageBytes / (storageLimitGb * 1024 * 1024 * 1024)) * 100, 100) 
    : 0
  const videoPercent = videoMinutesLimit > 0 
    ? Math.min((videoMinutes / videoMinutesLimit) * 100, 100) 
    : 0

  const usageItems = [
    {
      label: "Seats in use",
      icon: Users,
      current: activeAgents,
      max: formatSeatLimit(maxAgents),
      percent: seatCap === null ? 0 : agentPercent,
      unit: "",
    },
    {
      label: "AI Calls (MTD)",
      icon: Cpu,
      current: aiCalls.toLocaleString(),
      max: aiCallsLimit.toLocaleString(),
      percent: aiPercent,
      unit: "",
    },
    {
      label: "Storage",
      icon: HardDrive,
      current: formatBytes(storageBytes),
      max: `${storageLimitGb} GB`,
      percent: storagePercent,
      unit: "",
    },
    {
      label: "Video Minutes (MTD)",
      icon: Video,
      current: videoMinutes,
      max: videoMinutesLimit,
      percent: videoPercent,
      unit: "min",
    },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage This Period</CardTitle>
        <CardDescription>
          Monitor your resource consumption against plan limits
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 md:grid-cols-2">
          {usageItems.map((item) => {
            const Icon = item.icon
            const colorClass = getProgressColor(item.percent)
            
            return (
              <div key={item.label} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    {item.label}
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {item.current}{item.unit} / {item.max}{item.unit}
                  </span>
                </div>
                <div className="relative">
                  <Progress 
                    value={item.percent} 
                    className="h-2"
                  />
                  <div 
                    className={`absolute top-0 left-0 h-2 rounded-full transition-all ${colorClass}`}
                    style={{ width: `${item.percent}%` }}
                  />
                </div>
                {item.percent >= 80 && (
                  <p className={`text-xs ${item.percent >= 95 ? "text-red-600" : "text-amber-600"}`}>
                    {item.percent >= 95 
                      ? "Limit reached! Upgrade to continue." 
                      : "Approaching limit. Consider upgrading."}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
