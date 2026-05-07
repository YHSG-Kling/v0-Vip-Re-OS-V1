"use client"

/**
 * BuyerTourCard — surfaces an approved/upcoming tour itinerary in the
 * buyer's portal. Shows: tour date + start time + start address, total
 * duration / drive time, ordered stop list with photo + price + per-stop
 * confirmed/pending status, plus a Google Maps directions link.
 *
 * IMPORTANT — privacy rule:
 *   The buyer is represented by their agent and must NEVER see the
 *   listing agent's contact info in the portal. The buyer agent is the
 *   sole point of contact with listing agents; surfacing listing-agent
 *   names/phones to the buyer would let them go around their own agent
 *   (and would expose other-brokerage contact info that doesn't belong
 *   in the portal). Listing-agent contact lives in the AGENT-side tour
 *   confirm tab only.
 *
 * Renders ONLY when:
 *   - status is 'confirmed' or 'scheduling' (buyer never sees in-progress
 *     AI drafts), AND
 *   - report_sent_at is set (the agent has explicitly sent it to the buyer)
 */

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import {
  Calendar, Clock, MapPin, Route, Home, CheckCircle2,
} from "lucide-react"

interface TourStop {
  id: string
  order_index: number | null
  property_address: string | null
  city: string | null
  state: string | null
  zip: string | null
  list_price: number | null
  primary_photo_url: string | null
  suggested_time: string | null
  suggested_duration_minutes: number | null
  drive_time_from_prev_minutes: number | null
  confirmed_time: string | null
  is_confirmed: boolean | null
}

interface Tour {
  id: string
  tour_date: string | null
  start_time: string | null
  start_address: string | null
  status: string | null
  all_confirmed: boolean | null
  total_duration_minutes: number | null
  total_drive_time_minutes: number | null
  agent_approved_at: string | null
  report_sent_at: string | null
  ai_plan_narrative: string | null
  notes: string | null
  tour_stops: TourStop[] | null
}

interface Props {
  tour: Tour
}

export function BuyerTourCard({ tour }: Props) {
  const stops = (tour.tour_stops ?? []).slice().sort(
    (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0)
  )
  const tourDateLabel = tour.tour_date
    ? new Date(tour.tour_date + "T00:00:00").toLocaleDateString(undefined, {
        weekday: "long", month: "long", day: "numeric",
      })
    : "Date TBD"

  // Build a Google Maps directions URL from start_address through each stop
  const mapsUrl = (() => {
    const stopAddrs = stops
      .map(s => [s.property_address, s.city, s.state].filter(Boolean).join(", "))
      .filter(Boolean)
    if (stopAddrs.length === 0) return null
    const origin = tour.start_address ? encodeURIComponent(tour.start_address) : ""
    const destination = encodeURIComponent(stopAddrs[stopAddrs.length - 1])
    const waypoints = stopAddrs.slice(0, -1).map(encodeURIComponent).join("|")
    const waypointParam = waypoints ? `&waypoints=${waypoints}` : ""
    const originParam = origin ? `&origin=${origin}` : ""
    return `https://www.google.com/maps/dir/?api=1${originParam}&destination=${destination}${waypointParam}&travelmode=driving`
  })()

  const totalHours = tour.total_duration_minutes
    ? Math.floor(tour.total_duration_minutes / 60)
    : null
  const totalMins = tour.total_duration_minutes
    ? tour.total_duration_minutes % 60
    : null

  return (
    <Card className="border-l-4 border-l-emerald-500">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Route className="h-4 w-4 text-emerald-600" />
              <CardTitle className="text-base">Your Tour</CardTitle>
              <Badge
                className={
                  tour.status === "confirmed"
                    ? "bg-emerald-100 text-emerald-800 border-0"
                    : "bg-amber-100 text-amber-800 border-0"
                }
              >
                {tour.status === "confirmed" ? "Confirmed" : "Scheduling"}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {tourDateLabel}
              {tour.start_time && (
                <span className="ml-2 inline-flex items-center gap-0.5">
                  <Clock className="h-3.5 w-3.5" />
                  Starts {formatTime(tour.start_time)}
                </span>
              )}
            </p>
          </div>
          {mapsUrl && (
            <Button size="sm" variant="outline" asChild>
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer">
                <MapPin className="h-3.5 w-3.5 mr-1.5" />
                Open Map
              </a>
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Tour summary stats */}
        <div className="grid grid-cols-3 gap-2 rounded-md bg-muted/30 p-3 text-center">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Stops</p>
            <p className="text-sm font-bold">{stops.length}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Total time</p>
            <p className="text-sm font-bold">
              {totalHours != null && totalMins != null
                ? totalHours > 0
                  ? `${totalHours}h ${totalMins}m`
                  : `${totalMins}m`
                : "—"}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Driving</p>
            <p className="text-sm font-bold">
              {tour.total_drive_time_minutes != null
                ? `${tour.total_drive_time_minutes}m`
                : "—"}
            </p>
          </div>
        </div>

        {/* Start address */}
        {tour.start_address && (
          <div className="flex items-start gap-2 text-xs">
            <Home className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
            <div>
              <p className="text-muted-foreground">Starting at</p>
              <p className="font-medium">{tour.start_address}</p>
            </div>
          </div>
        )}

        {/* Ordered stop list */}
        <div className="space-y-2">
          {stops.map((stop, i) => (
            <div
              key={stop.id}
              className="flex items-start gap-3 rounded-lg border bg-background p-3"
            >
              <div className="shrink-0 h-9 w-9 rounded-full bg-emerald-50 flex items-center justify-center text-sm font-bold text-emerald-700">
                {i + 1}
              </div>
              {stop.primary_photo_url ? (
                <img
                  src={stop.primary_photo_url}
                  alt=""
                  className="shrink-0 h-12 w-12 rounded object-cover"
                />
              ) : (
                <div className="shrink-0 h-12 w-12 rounded bg-muted flex items-center justify-center">
                  <Home className="h-5 w-5 text-muted-foreground" />
                </div>
              )}
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium truncate">
                    {stop.property_address || "Property"}
                  </p>
                  {stop.is_confirmed ? (
                    <Badge className="bg-emerald-100 text-emerald-800 border-0 text-[10px] gap-0.5 px-1.5 h-[18px]">
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      Confirmed
                    </Badge>
                  ) : (
                    <Badge className="bg-amber-100 text-amber-800 border-0 text-[10px] px-1.5 h-[18px]">
                      Pending
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {stop.confirmed_time
                      ? new Date(stop.confirmed_time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
                      : stop.suggested_time
                        ? formatTime(stop.suggested_time)
                        : "TBD"}
                    {stop.suggested_duration_minutes && (
                      <span className="ml-1">({stop.suggested_duration_minutes}m)</span>
                    )}
                  </span>
                  {stop.list_price != null && (
                    <span>${stop.list_price.toLocaleString()}</span>
                  )}
                  {stop.drive_time_from_prev_minutes != null && i > 0 && (
                    <span className="flex items-center gap-1">
                      <Route className="h-3 w-3" />
                      {stop.drive_time_from_prev_minutes}m drive
                    </span>
                  )}
                </div>
                {/* Listing-agent contact intentionally NOT shown to the buyer.
                    Buyer's own agent owns the relationship with listing agents;
                    surfacing other-brokerage contact info here would let the
                    buyer bypass their representative. */}
              </div>
            </div>
          ))}
        </div>

        {/* AI narrative if present */}
        {tour.ai_plan_narrative && (
          <div className="rounded-md bg-blue-50/50 border border-blue-100 p-3">
            <p className="text-[11px] uppercase tracking-wide text-blue-700 font-semibold mb-1">
              About this tour
            </p>
            <p className="text-xs text-blue-900 whitespace-pre-line">
              {tour.ai_plan_narrative}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function formatTime(t: string): string {
  // Accepts 'HH:MM' or 'HH:MM:SS' — render as 'h:MM AM/PM'
  const [hh, mm] = t.split(":").map(Number)
  if (hh == null || mm == null) return t
  const period = hh >= 12 ? "PM" : "AM"
  const h12 = hh % 12 || 12
  return `${h12}:${String(mm).padStart(2, "0")} ${period}`
}
