"use client"

import type { ISACampaignStats } from "@/app/actions/ai-isa"

interface Props {
  stats: ISACampaignStats
}

export function CampaignStatsBar({ stats }: Props) {
  const items = [
    { label: "Active Campaigns", value: stats.activeCampaigns },
    { label: "Leads Targeted",   value: stats.leadsTargeted.toLocaleString() },
    { label: "Touches Sent",     value: stats.touchesSent.toLocaleString() },
    { label: "Conversion Rate",  value: `${stats.conversionRate}%` },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-lg border border-border bg-card p-4 text-center"
        >
          <p className="text-2xl font-bold text-foreground">{item.value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{item.label}</p>
        </div>
      ))}
    </div>
  )
}
