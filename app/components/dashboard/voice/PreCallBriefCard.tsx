"use client"

/**
 * PreCallBriefCard — surfaces the 10-second contact intel that an agent needs
 * before any logged call. Mounted inside VapiCallPanel + standalone on the
 * LiveKit assistant page when a contact context is selected.
 */

import { useEffect, useState } from "react"
import { Loader2, Flame, AlertTriangle, Phone, Calendar, ListChecks } from "lucide-react"
import { Badge } from "@/components/ui/badge"

interface ContactBrief {
  contactId: string
  fullName: string
  contactType: string | null
  buyerStage: string | null
  city: string | null
  state: string | null
  engagementScore: number | null
  momentumScore: number | null
  momentumTrend: "rising" | "steady" | "declining" | "cold"
  lastContactDays: number | null
  doNotContact: boolean
  phoneOptOut: boolean
  smsOptOut: boolean
  emailOptOut: boolean
  activeDealStage: string | null
  openTaskCount: number
  recentActivities: Array<{ type: string; description: string | null; occurredAt: string }>
  talkingPoints: string[]
}

const TREND_STYLES: Record<ContactBrief["momentumTrend"], string> = {
  rising: "bg-emerald-100 text-emerald-700 border-emerald-300",
  steady: "bg-sky-100 text-sky-700 border-sky-300",
  declining: "bg-amber-100 text-amber-700 border-amber-300",
  cold: "bg-slate-100 text-slate-600 border-slate-300",
}

interface Props {
  contactId: string
  channel?: "phone" | "sms" | "email"
}

export function PreCallBriefCard({ contactId, channel = "phone" }: Props) {
  const [brief, setBrief] = useState<ContactBrief | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/contacts/${contactId}/brief`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(await r.text())))
      .then((data) => {
        if (!cancelled) setBrief(data)
      })
      .catch((e) => {
        if (!cancelled) setError(typeof e === "string" ? e : "Failed to load brief")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [contactId])

  if (loading) {
    return (
      <div className="rounded-md border bg-muted/30 px-3 py-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading brief…
      </div>
    )
  }

  if (error || !brief) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        Couldn't load contact brief.
      </div>
    )
  }

  const channelBlocked =
    (channel === "phone" && (brief.doNotContact || brief.phoneOptOut)) ||
    (channel === "sms" && (brief.doNotContact || brief.smsOptOut)) ||
    (channel === "email" && brief.emailOptOut)

  return (
    <div className="rounded-lg border bg-card p-3 space-y-2.5 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-sm leading-tight">{brief.fullName}</p>
          <p className="text-muted-foreground capitalize">
            {[brief.contactType, brief.buyerStage].filter(Boolean).join(" • ").replace(/_/g, " ")}
            {brief.city ? ` — ${brief.city}${brief.state ? `, ${brief.state}` : ""}` : ""}
          </p>
        </div>
        <Badge variant="outline" className={TREND_STYLES[brief.momentumTrend]}>
          <Flame className="h-3 w-3 mr-0.5" />
          {brief.momentumScore ?? 0}
        </Badge>
      </div>

      {channelBlocked && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-800 flex gap-1.5 items-start">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            {channel === "phone"
              ? "Phone contact restricted — confirm consent before dialing."
              : channel === "sms"
                ? "SMS contact opted out."
                : "Email opted out."}
          </span>
        </div>
      )}

      <ul className="space-y-1 text-foreground/90">
        {brief.talkingPoints.slice(0, 4).map((tp, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="text-muted-foreground">•</span>
            <span>{tp}</span>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-3 pt-1 border-t text-muted-foreground">
        <span className="flex items-center gap-1">
          <Calendar className="h-3 w-3" />
          {brief.lastContactDays == null
            ? "Never contacted"
            : brief.lastContactDays === 0
              ? "Today"
              : `${brief.lastContactDays}d ago`}
        </span>
        <span className="flex items-center gap-1">
          <ListChecks className="h-3 w-3" />
          {brief.openTaskCount} open
        </span>
        {brief.activeDealStage && (
          <span className="flex items-center gap-1">
            <Phone className="h-3 w-3" />
            <span className="capitalize">{brief.activeDealStage.replace(/_/g, " ")}</span>
          </span>
        )}
      </div>
    </div>
  )
}
