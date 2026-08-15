"use client"

/**
 * PresentationReadyBanner — surfaces listing presentations the daily cron
 * (Sprint J auto-build) has prepared for the agent's upcoming appointments.
 *
 * Renders as a prominent card on the agent dashboard with a one-tap
 * "Open Presentation" button that deep-links to /dashboard/listings/
 * presentations/[id]. Auto-hides when no prepared presentations exist or
 * all of them are for appointments more than 48 hours out.
 *
 * Loaded via a thin server-action wrapper so the dashboard (client component)
 * can consume it without leaking service-role credentials.
 *
 * PURELY ADDITIVE — drop into any layout slot. Returns null when nothing
 * relevant.
 */

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sparkles, Clock, MapPin, ChevronRight } from "lucide-react"
import { loadUpcomingPresentations, type UpcomingPresentation } from "@/app/actions/presentations-list"

export default function PresentationReadyBanner() {
  const [presentations, setPresentations] = useState<UpcomingPresentation[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadUpcomingPresentations()
      .then(rows => { if (!cancelled) setPresentations(rows) })
      .catch(() => { /* never break dashboard */ })
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])

  if (!loaded) return null
  if (presentations.length === 0) return null

  return (
    <Card className="border-emerald-300 dark:border-emerald-800 bg-gradient-to-br from-emerald-50/40 to-transparent dark:from-emerald-950/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-emerald-600" />
          Listing presentations ready
          <Badge variant="outline" className="ml-1 text-xs">{presentations.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {presentations.slice(0, 3).map(pres => {
          const apptAt = pres.appointmentAt ? new Date(pres.appointmentAt) : null
          const hoursUntil = apptAt ? Math.round((apptAt.getTime() - Date.now()) / 3_600_000) : null
          return (
            <div key={pres.id} className="flex items-start justify-between gap-3 rounded-md border bg-white dark:bg-slate-900 p-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{pres.propertyAddress ?? "Property"}</span>
                </div>
                {apptAt && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
                    <Clock className="h-3 w-3" />
                    {apptAt.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    {hoursUntil != null && hoursUntil >= 0 && hoursUntil < 48 && (
                      <Badge variant="outline" className="ml-1 text-[10px]">
                        in {hoursUntil < 1 ? "<1h" : `${hoursUntil}h`}
                      </Badge>
                    )}
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  Value range: ${Math.round(pres.cmaLow / 1000)}K – ${Math.round(pres.cmaHigh / 1000)}K
                </p>
              </div>
              <Button asChild size="sm" className="shrink-0 gap-1">
                <Link href={`/dashboard/listings/presentations/${pres.id}`}>
                  Open <ChevronRight className="h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          )
        })}

        {presentations.length > 3 && (
          <p className="text-xs text-center text-muted-foreground pt-1">
            +{presentations.length - 3} more upcoming presentation{presentations.length - 3 === 1 ? "" : "s"}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
