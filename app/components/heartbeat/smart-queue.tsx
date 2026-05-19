"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Flame, AlertTriangle, Sparkles, Diamond, ArrowRight } from "lucide-react"
import {
  getSmartQueue,
  type SmartQueueData,
  type SmartSegment,
} from "@/app/actions/smart-queue"

/**
 * <SmartQueue> — single segmented list replacing 5 contact-urgency widgets.
 *
 * Vision pattern: one mental model, one filter chip set:
 *   🔥 Hot · ⚠ At-risk · 🆕 New · 💎 Likely sellers
 *
 * Click a chip → filter the list. Click a row → open contact with
 * suggested action queued (?action=draft_followup, etc.).
 */

const SEGMENTS: Array<{
  key: SmartSegment | "all"
  label: string
  icon: React.ReactElement
  color: string
}> = [
  { key: "all", label: "All", icon: <></>, color: "bg-slate-100 text-slate-700" },
  { key: "hot", label: "Hot", icon: <Flame className="h-3.5 w-3.5" />, color: "bg-red-100 text-red-700" },
  { key: "at_risk", label: "At-risk", icon: <AlertTriangle className="h-3.5 w-3.5" />, color: "bg-amber-100 text-amber-700" },
  { key: "new", label: "New", icon: <Sparkles className="h-3.5 w-3.5" />, color: "bg-blue-100 text-blue-700" },
  { key: "likely_seller", label: "Likely seller", icon: <Diamond className="h-3.5 w-3.5" />, color: "bg-purple-100 text-purple-700" },
]

export function SmartQueue() {
  const [data, setData] = useState<SmartQueueData | null>(null)
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState<SmartSegment | "all">("all")

  useEffect(() => {
    getSmartQueue()
      .then(setData)
      .finally(() => setLoading(false))
  }, [])

  const visible = useMemo(() => {
    if (!data) return []
    if (active === "all") return data.rows.slice(0, 12)
    return data.rows.filter((r) => r.segment === active).slice(0, 12)
  }, [data, active])

  if (loading) return null
  if (!data || data.rows.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Flame className="h-4 w-4 text-red-500" />
          Smart Queue
          <span className="text-xs text-muted-foreground font-normal">
            · {data.rows.length} contacts need attention
          </span>
        </CardTitle>
        {/* Segment chips */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {SEGMENTS.map((s) => {
            const count =
              s.key === "all"
                ? data.rows.length
                : data.counts[s.key as SmartSegment] ?? 0
            if (s.key !== "all" && count === 0) return null
            const isActive = active === s.key
            return (
              <button
                key={s.key}
                onClick={() => setActive(s.key)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs transition-colors ${
                  isActive ? s.color + " font-medium" : "bg-muted/50 hover:bg-muted text-muted-foreground"
                }`}
              >
                {s.icon}
                <span>{s.label}</span>
                <span className="opacity-70">{count}</span>
              </button>
            )
          })}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y">
          {visible.map((row) => {
            const segMeta = SEGMENTS.find((s) => s.key === row.segment) ?? SEGMENTS[0]
            const href = row.suggestedAction === "open_contact"
              ? `/crm?contact=${row.contactId}`
              : `/crm?contact=${row.contactId}&action=${row.suggestedAction}`
            return (
              <Link
                key={row.contactId}
                href={href}
                className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-muted/40 transition-colors"
              >
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  <div className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${segMeta.color} shrink-0 flex items-center gap-1`}>
                    {segMeta.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{row.fullName}</p>
                    <p className="text-xs text-muted-foreground line-clamp-1">{row.signal}</p>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1 shrink-0"
                  asChild
                >
                  <span>
                    {row.suggestedAction === "draft_followup"
                      ? "Draft"
                      : row.suggestedAction === "schedule_appointment"
                      ? "Schedule"
                      : "Open"}
                    <ArrowRight className="h-3 w-3" />
                  </span>
                </Button>
              </Link>
            )
          })}
        </div>
        {visible.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-6">
            No {active !== "all" ? SEGMENTS.find((s) => s.key === active)?.label.toLowerCase() : ""} contacts in this segment.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
