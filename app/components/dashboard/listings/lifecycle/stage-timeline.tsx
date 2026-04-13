"use client"

import { Calendar, AlertTriangle, CheckCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"

interface LifecycleEvent {
  id: string
  event_type: string
  metadata: Record<string, any> | null
  actor_user_id: string | null
  created_at: string
}

interface Listing {
  id: string
  go_live_date: string | null
  open_house_marketing_date: string | null
  open_house_event_date: string | null
}

interface Props {
  listing: Listing
  lifecycleEvents: LifecycleEvent[]
}

function fmtDate(iso: string | null) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
}

export function StageTimeline({ listing, lifecycleEvents }: Props) {
  // Descending order for display
  const events = [...lifecycleEvents].reverse()

  return (
    <div>
      {/* Date summary cards */}
      <div className="p-4 border-b border-border space-y-2">
        <h2 className="text-sm font-semibold text-foreground mb-3">Key Dates</h2>

        <DateCard
          label="MLS Live"
          value={fmtDate(listing.go_live_date)}
          icon={<Calendar className="w-3.5 h-3.5" />}
        />
        <DateCard
          label="OH Marketing"
          value={fmtDate(listing.open_house_marketing_date)}
          sub="Friday before go-live"
          icon={<Calendar className="w-3.5 h-3.5" />}
        />
        <DateCard
          label="OH Event"
          value={fmtDate(listing.open_house_event_date)}
          sub="Saturday after go-live"
          icon={<Calendar className="w-3.5 h-3.5" />}
        />
      </div>

      {/* Timeline */}
      <div className="p-4">
        <h2 className="text-sm font-semibold text-foreground mb-3">Stage History</h2>

        {events.length === 0 ? (
          <p className="text-xs text-muted-foreground">No transitions recorded yet</p>
        ) : (
          <ol className="relative border-l border-border ml-2 space-y-4">
            {events.map((evt) => {
              const isOverride = evt.metadata?.is_override === true
              const isFailed   = evt.event_type?.includes("FAILED")
              const toState    = evt.metadata?.to_state as string | undefined
              const fromState  = evt.metadata?.from_state as string | undefined
              const notes      = evt.metadata?.notes as string | undefined

              return (
                <li key={evt.id} className="ml-4">
                  {/* Dot */}
                  <span className={cn(
                    "absolute -left-1.5 flex h-3 w-3 rounded-full border-2 border-card",
                    isFailed   ? "bg-destructive" :
                    isOverride ? "bg-amber-400" :
                    "bg-primary"
                  )} />

                  <div className="rounded-md border border-border bg-background px-3 py-2 text-xs">
                    {/* Stage transition */}
                    <div className="flex items-center gap-1.5 font-medium text-foreground">
                      {toState ? (
                        <>
                          {fromState && (
                            <span className="text-muted-foreground">
                              {fromState.replace(/_/g, " ").toLowerCase()}
                            </span>
                          )}
                          {fromState && <span className="text-muted-foreground">→</span>}
                          <span>{toState.replace(/_/g, " ").toLowerCase()}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">{evt.event_type}</span>
                      )}
                    </div>

                    {/* Badges */}
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {isOverride && (
                        <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold border border-amber-200">
                          <AlertTriangle className="w-2.5 h-2.5" />
                          OVERRIDE
                        </span>
                      )}
                      {isFailed && (
                        <span className="px-1.5 py-0.5 rounded bg-destructive/10 text-destructive text-[10px] font-semibold border border-destructive/20">
                          FAILED
                        </span>
                      )}
                      {!isFailed && !isOverride && (
                        <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[10px] font-medium border border-emerald-200">
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          completed
                        </span>
                      )}
                    </div>

                    {/* Notes */}
                    {notes && (
                      <p className="mt-1.5 text-muted-foreground italic line-clamp-2">{notes}</p>
                    )}

                    {/* Failure reason */}
                    {isFailed && evt.metadata?.failure_reason && (
                      <p className="mt-1 text-destructive">{evt.metadata.failure_reason}</p>
                    )}

                    {/* Timestamp */}
                    <p className="mt-1.5 text-muted-foreground/70">{fmtTime(evt.created_at)}</p>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </div>
  )
}

function DateCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string
  value: string | null
  sub?: string
  icon: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border bg-background px-3 py-2">
      <span className="text-muted-foreground flex-shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
        <p className="text-xs font-semibold text-foreground">{value ?? "Not set"}</p>
        {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
      </div>
    </div>
  )
}
