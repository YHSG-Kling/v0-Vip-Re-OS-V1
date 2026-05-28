"use client"

/**
 * ListingApptPrepWidget — surfaces upcoming listing-appointment-prep runs.
 *
 * Sits on the agent dashboard. Each row shows the prep readiness %, the
 * appointment countdown, and a click-through to the full Co-Pilot panel.
 */

import Link from "next/link"
import { CalendarClock, ArrowRight, AlertTriangle, CheckCircle2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { ListingApptPrepRow } from "@/app/actions/listing-appointment-copilot"
import { cn } from "@/lib/utils"

interface Props {
  preps: ListingApptPrepRow[]
}

export function ListingApptPrepWidget({ preps }: Props) {
  if (preps.length === 0) return null

  return (
    <Card className="border-indigo-200 dark:border-indigo-900">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-indigo-500" />
            Upcoming Listing Appointments
          </CardTitle>
          <Badge variant="outline" className="text-[10px]">{preps.length}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Auto-prep chain: CMA → presentation → chapter videos → drip. Review and mark ready before each appointment.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {preps.map((p) => {
          const countdown =
            p.daysUntil == null ? null :
            p.daysUntil < 0     ? `${Math.abs(p.daysUntil)}d ago` :
            p.daysUntil === 0   ? "today" :
                                  `${p.daysUntil}d to go`
          const countdownStyle =
            p.daysUntil == null ? "bg-gray-100 text-gray-700" :
            p.daysUntil <= 1    ? "bg-red-100 text-red-700" :
            p.daysUntil <= 3    ? "bg-amber-100 text-amber-700" :
                                  "bg-indigo-100 text-indigo-700"

          return (
            <Link
              key={p.runId}
              href={`/dashboard/listing-appointments/${p.runId}`}
              className="block"
            >
              <div className="flex items-start justify-between gap-3 p-3 border rounded-lg bg-card hover:bg-muted/40 transition">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm truncate">
                      {p.contactName ?? "Contact"}
                    </span>
                    {countdown && (
                      <Badge className={cn("text-[10px]", countdownStyle)}>
                        {countdown}
                      </Badge>
                    )}
                    {p.status === "completed" ? (
                      <Badge variant="outline" className="text-[10px] text-emerald-700 border-emerald-300 gap-0.5">
                        <CheckCircle2 className="h-2.5 w-2.5" /> ready
                      </Badge>
                    ) : p.blockedOn ? (
                      <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300 gap-0.5">
                        <AlertTriangle className="h-2.5 w-2.5" /> {p.blockedOn}
                      </Badge>
                    ) : null}
                  </div>
                  {p.propertyAddress && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{p.propertyAddress}</p>
                  )}
                  {p.appointmentDate && (
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {new Date(p.appointmentDate).toLocaleString(undefined, {
                        weekday: "short", month: "short", day: "numeric",
                        hour: "numeric", minute: "2-digit",
                      })}
                    </p>
                  )}
                  {/* Readiness bar */}
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden max-w-[160px]">
                      <div
                        className={cn(
                          "h-full transition-all",
                          p.readyPercent >= 100 ? "bg-emerald-500" :
                          p.readyPercent >= 50  ? "bg-indigo-500" :
                                                  "bg-amber-500",
                        )}
                        style={{ width: `${p.readyPercent}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-muted-foreground tabular-nums">{p.readyPercent}%</span>
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
              </div>
            </Link>
          )
        })}
      </CardContent>
    </Card>
  )
}
