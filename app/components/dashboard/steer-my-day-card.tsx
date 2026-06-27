"use client"

// SteerMyDayCard — the agent's whole-funnel "work these first" cockpit on the briefing dashboard.
// The deterministic queue (a cold lead AND a slipping client on ONE list, most-at-risk first) that
// complements the LLM daily narrative. Read-only, agent's own book. RISE's "Top 5 Contacts", but
// across the entire funnel — and already driven by the live relationship-health + warmth signals.

import { useEffect, useState } from "react"
import Link from "next/link"
import { Compass, ArrowRight, Send, ShieldAlert } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { loadSteerMyDay, type SteerMyDayView } from "@/app/actions/steer-my-day"

const bandCls = (band: string) =>
  band === "at_risk" ? "bg-red-100 text-red-800"
  : band === "cooling" ? "bg-amber-100 text-amber-800"
  : "bg-muted text-muted-foreground"

export function SteerMyDayCard() {
  const [data, setData] = useState<SteerMyDayView | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    loadSteerMyDay().then((r) => {
      if (!cancelled) { if (r.success && r.data) setData(r.data); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Compass className="h-4 w-4 text-teal-600" /> Steer My Day
        </CardTitle>
        <CardDescription>{loading ? "Reading your whole funnel…" : (data?.headline ?? "You're on top of it.")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
        ) : data && data.items.length > 0 ? (
          <>
            {data.items.map((item) => {
              const href = item.kind === "contact" ? `/crm/contacts/${item.id}` : `/crm/leads/${item.id}`
              return (
                <Link key={`${item.kind}:${item.id}`} href={href}>
                  <div className="flex items-center justify-between rounded-lg border p-3 hover:border-teal-300 transition cursor-pointer">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{item.name}</p>
                        <Badge className={`${bandCls(item.band)} text-[10px]`}>{item.band.replace("_", " ")}</Badge>
                        <span className="text-[10px] text-muted-foreground uppercase">{item.kind}</span>
                      </div>
                      {item.drivers.length > 0 && <p className="text-xs text-muted-foreground truncate">{item.drivers.slice(0, 2).join(" · ")}</p>}
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0 ml-2" />
                  </div>
                </Link>
              )
            })}
            <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1">
              <span className="flex items-center gap-1"><Send className="h-3 w-3" />{data.planned.willSend} planned today</span>
              {data.planned.blocked > 0 && <span className="flex items-center gap-1"><ShieldAlert className="h-3 w-3" />{data.planned.blocked} held by the gates</span>}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No one's slipping — nicely done. Your AI team has the routine touches covered.</p>
        )}
      </CardContent>
    </Card>
  )
}
