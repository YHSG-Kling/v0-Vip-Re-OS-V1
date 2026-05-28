"use client"

import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Calendar, MapPin, User, ArrowRight, Sparkles, Clock, AlertCircle } from "lucide-react"
import type { UpcomingShowing } from "./actions"

interface Props { rows: UpcomingShowing[] }

const fmtTime = (iso: string | null) => {
  if (!iso) return "—"
  const d = new Date(iso)
  const today = new Date()
  const tomorrow = new Date(today.getTime() + 86_400_000)
  const sameDay = d.toDateString() === today.toDateString()
  const isTomorrow = d.toDateString() === tomorrow.toDateString()
  const dayLabel = sameDay ? "Today" : isTomorrow ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
  const timeLabel = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return `${dayLabel} · ${timeLabel}`
}

const minutesUntil = (iso: string | null) => {
  if (!iso) return null
  return Math.round((new Date(iso).getTime() - Date.now()) / 60_000)
}

export function ShowingPrepListClient({ rows }: Props) {
  const upcoming = rows.filter(r => {
    const m = minutesUntil(r.scheduledAt)
    return m == null ? true : m >= -120  // hide showings >2h in the past
  })
  const withBrief = upcoming.filter(r => r.hasBriefing).length

  return (
    <div className="container max-w-4xl mx-auto py-8 px-4">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="h-5 w-5 text-indigo-600" />
          <h1 className="text-2xl font-semibold tracking-tight">Showing Prep</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Every upcoming showing with an AI-generated 1-pager you can read in the car. Buyer signals,
          property matchup, recent comps, and 4-6 specific talking points keyed to THIS buyer — not
          generic real-estate boilerplate.
        </p>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <Badge variant="secondary">{upcoming.length} upcoming</Badge>
        {upcoming.length > 0 && (
          <Badge variant={withBrief === upcoming.length ? "default" : "outline"}>
            {withBrief} of {upcoming.length} briefed
          </Badge>
        )}
      </div>

      {upcoming.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-sm text-muted-foreground space-y-2">
            <Calendar className="h-10 w-10 text-muted-foreground mx-auto" />
            <p className="font-medium text-foreground">No showings on the calendar.</p>
            <p className="text-xs">When you schedule a showing, AI auto-generates the prep brief within an hour.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {upcoming.map(s => {
            const mins = minutesUntil(s.scheduledAt)
            const isImminent = mins != null && mins >= 0 && mins <= 120
            const isPast = mins != null && mins < 0
            return (
              <Card key={s.id} className={isImminent ? "border-indigo-300" : undefined}>
                <CardContent className="py-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <p className="text-sm font-medium">{fmtTime(s.scheduledAt)}</p>
                        {isImminent && <Badge className="bg-indigo-600 text-white text-[10px]">Soon</Badge>}
                        {isPast && <Badge variant="outline" className="text-[10px]">Past</Badge>}
                      </div>
                      <div className="flex items-center gap-2 mb-0.5">
                        <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <p className="text-sm truncate">{s.listingAddress ?? "Address not set"}</p>
                      </div>
                      {s.buyerName && (
                        <div className="flex items-center gap-2">
                          <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <p className="text-xs text-muted-foreground">{s.buyerName}</p>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      {s.hasBriefing ? (
                        <Badge variant="default" className="text-[10px] bg-emerald-600">
                          <Sparkles className="h-3 w-3 mr-1" /> Briefed
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          <Clock className="h-3 w-3 mr-1" /> Pending
                        </Badge>
                      )}
                      <Button asChild size="sm" variant={s.hasBriefing ? "default" : "outline"}>
                        <Link href={`/dashboard/showings/prep/${s.id}`}>
                          {s.hasBriefing ? "Read brief" : "Generate brief"} <ArrowRight className="h-3 w-3 ml-1" />
                        </Link>
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <p className="mt-6 text-xs text-muted-foreground text-center">
        <AlertCircle className="h-3 w-3 inline mr-1" />
        Briefs auto-generate via cron every hour for showings within 24 hours. You can also regenerate any brief on demand.
      </p>
    </div>
  )
}
