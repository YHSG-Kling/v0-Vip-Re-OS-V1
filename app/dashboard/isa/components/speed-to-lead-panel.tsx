// app/dashboard/isa/components/speed-to-lead-panel.tsx
//
// Speed-to-Lead KPI strip — surfaces the m228 first-touch truth so the agent SEES that
// every lead/contact is getting a fast, automatic first touch (and who is still waiting).
// Presentational: fed real metrics from getSpeedToLeadMetrics.

import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Zap, Clock, Mail, MessageSquare, Phone, Mailbox, Inbox } from "lucide-react"
import type { SpeedToLeadMetrics } from "@/app/actions/ai-isa/speed-to-lead-metrics"

function humanizeSeconds(s: number | null): string {
  if (s === null) return "—"
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

const CHANNEL_META: Record<string, { label: string; icon: typeof Mail }> = {
  email: { label: "Email", icon: Mail },
  sms: { label: "SMS", icon: MessageSquare },
  phone: { label: "Phone", icon: Phone },
  direct_mail: { label: "Direct Mail", icon: Mailbox },
  unknown: { label: "Other", icon: Inbox },
}

export function SpeedToLeadPanel({ metrics }: { metrics: SpeedToLeadMetrics }) {
  const { awaitingLeads, awaitingContacts, recent } = metrics
  const awaiting = awaitingLeads + awaitingContacts
  const slaPct = recent.pctWithinSla === null ? null : Math.round(recent.pctWithinSla * 100)
  const slaColor =
    slaPct === null ? "text-muted-foreground"
    : slaPct >= 90 ? "text-green-600"
    : slaPct >= 70 ? "text-amber-600"
    : "text-red-600"

  const channelChips = Object.entries(recent.channelBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)

  return (
    <Card className="border-indigo-200 bg-gradient-to-br from-indigo-50/60 to-white">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="w-4 h-4 text-indigo-600" />
          <h2 className="text-sm font-semibold text-indigo-900">Speed-to-Lead</h2>
          <span className="text-xs text-muted-foreground">automatic first touch · last 7 days</span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Awaiting first touch */}
          <div className="rounded-lg bg-white border p-3">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500 mb-1">
              <Inbox className="w-3 h-3" /> Awaiting First Touch
            </div>
            <p className="text-2xl font-bold leading-none">{awaiting}</p>
            <p className="text-[11px] text-muted-foreground mt-1">
              {awaitingLeads} lead{awaitingLeads === 1 ? "" : "s"} · {awaitingContacts} contact
              {awaitingContacts === 1 ? "" : "s"}
            </p>
          </div>

          {/* Median time to first touch */}
          <div className="rounded-lg bg-white border p-3">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-blue-500 mb-1">
              <Clock className="w-3 h-3" /> Median First Touch
            </div>
            <p className="text-2xl font-bold leading-none">{humanizeSeconds(recent.medianSeconds)}</p>
            <p className="text-[11px] text-muted-foreground mt-1">{recent.touchedCount} touched</p>
          </div>

          {/* % within 5-min SLA */}
          <div className="rounded-lg bg-white border p-3">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-green-500 mb-1">
              <Zap className="w-3 h-3" /> Within 5 Min
            </div>
            <p className={`text-2xl font-bold leading-none ${slaColor}`}>
              {slaPct === null ? "—" : `${slaPct}%`}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">SLA met</p>
          </div>

          {/* Channel mix */}
          <div className="rounded-lg bg-white border p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-indigo-500 mb-1.5">
              Channels Used
            </div>
            {channelChips.length === 0 ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {channelChips.map(([ch, n]) => {
                  const meta = CHANNEL_META[ch] ?? CHANNEL_META.unknown
                  const Icon = meta.icon
                  return (
                    <Badge key={ch} variant="outline" className="text-[10px] gap-1 font-normal">
                      <Icon className="w-3 h-3" />
                      {meta.label} {n}
                    </Badge>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
