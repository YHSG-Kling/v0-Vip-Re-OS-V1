import { createServiceClient } from "@/lib/supabase/service"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Route, Clock, MapPin, Info } from "lucide-react"

/**
 * OPTIMIZED ROUTE SUMMARY (agent-facing) — surfaces the Tour Day Optimizer's work where
 * the agent reviews a planned tour before sending it: the optimized stop order, the total
 * ESTIMATED drive time (tours.total_drive_time_minutes), and the optimization_score from
 * the persisted showing_routes row.
 *
 * The optimizer runs on the cron (and writes tours.total_drive_time_minutes as its stamp);
 * this read-only section makes its output visible to the agent. Honest by construction:
 * drive times are labeled "est." and stops the optimizer couldn't sequence (no
 * coordinates) are shown with no fabricated number.
 *
 * Server component — fetches the tours' stops + the matching showing_routes audit rows for
 * THIS contact, scoped to the brokerage.
 */
export async function OptimizedRouteSummary({
  contactId,
  brokerageId,
}: {
  contactId: string
  brokerageId: string
}) {
  const supabase = createServiceClient()

  // Tours the optimizer has processed (total_drive_time_minutes set) that are still in a
  // pre-send state (planned/scheduling/confirmed) — that's where this review section helps.
  const { data: tours } = await supabase
    .from("tours")
    .select(
      `id, tour_date, status, total_drive_time_minutes,
       tour_stops(id, order_index, property_address, suggested_time,
                  drive_time_from_prev_minutes)`,
    )
    .eq("contact_id", contactId)
    .eq("brokerage_id", brokerageId)
    .not("total_drive_time_minutes", "is", null)
    .in("status", ["planned", "scheduling", "confirmed"])
    .order("tour_date", { ascending: false })
    .limit(3)

  const optimizedTours = (tours ?? []) as any[]
  if (optimizedTours.length === 0) return null

  // Pull the persisted route audit rows (optimization_score, estimated_miles) keyed by
  // tour_id inside showings jsonb.
  const tourIds = optimizedTours.map((t) => t.id)
  const { data: routes } = await supabase
    .from("showing_routes")
    .select("id, showings, optimization_score, estimated_miles, total_duration, route_notes, created_at")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(50)
  const routeByTour = new Map<string, any>()
  for (const r of (routes ?? []) as any[]) {
    const tid = r?.showings?.tour_id
    if (tid && tourIds.includes(tid) && !routeByTour.has(tid)) routeByTour.set(tid, r)
  }

  return (
    <div className="mb-4 space-y-3">
      {optimizedTours.map((tour) => {
        const stops = [...(tour.tour_stops ?? [])].sort(
          (a: any, b: any) => (a.order_index ?? 0) - (b.order_index ?? 0),
        )
        const route = routeByTour.get(tour.id)
        const score = route?.optimization_score != null ? Number(route.optimization_score) : null
        const miles = route?.estimated_miles != null ? Number(route.estimated_miles) : null
        const tourDate = tour.tour_date ? new Date(tour.tour_date) : null

        return (
          <Card key={tour.id} className="border-blue-200 bg-blue-50/40">
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <Route className="h-4 w-4 text-blue-600" />
                  <span className="text-sm font-semibold">
                    Optimized route
                    {tourDate
                      ? ` — ${tourDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`
                      : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {tour.total_drive_time_minutes != null && (
                    <Badge variant="secondary" className="bg-blue-100 text-blue-800">
                      <Clock className="h-3 w-3 mr-1" />~{tour.total_drive_time_minutes} min drive (est.)
                    </Badge>
                  )}
                  {miles != null && miles > 0 && (
                    <Badge variant="outline" className="text-xs">
                      ~{miles.toFixed(1)} mi
                    </Badge>
                  )}
                  {score != null && (
                    <Badge variant="outline" className="text-xs">
                      score {score.toFixed(2)}
                    </Badge>
                  )}
                </div>
              </div>

              <ol className="space-y-1.5">
                {stops.map((s: any, i: number) => (
                  <li key={s.id} className="flex items-center gap-2 text-sm">
                    <span className="h-5 w-5 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-semibold shrink-0">
                      {i + 1}
                    </span>
                    <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1 min-w-0 truncate">{s.property_address}</span>
                    {i > 0 && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        {s.drive_time_from_prev_minutes != null
                          ? `+${s.drive_time_from_prev_minutes} min`
                          : "drive n/a"}
                      </span>
                    )}
                  </li>
                ))}
              </ol>

              <p className="mt-3 flex items-start gap-1 text-[11px] text-muted-foreground">
                <Info className="h-3 w-3 mt-0.5 shrink-0" />
                Drive times are straight-line estimates for planning, not traffic-aware. Stops
                shown as "drive n/a" had no coordinates to sequence and kept their entered order.
              </p>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
