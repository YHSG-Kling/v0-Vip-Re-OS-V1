"use client"

import { useState, useEffect } from "react"
import { Clock, ChevronDown, ChevronUp, User, Cpu } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { getSellerDecisionHistory } from "@/app/actions/seller-decision-governance"
import { formatDistanceToNow } from "date-fns"

interface DecisionHistoryPanelProps {
  listingId: string
}

const EVENT_COLORS: Record<string, string> = {
  approved:          "bg-emerald-500",
  rejected:          "bg-red-500",
  pending:           "bg-amber-500",
  counter_offer:     "bg-blue-500",
  price_reduction:   "bg-purple-500",
  accepted:          "bg-emerald-500",
  default:           "bg-slate-400",
}

function dotColor(eventType: string): string {
  const key = Object.keys(EVENT_COLORS).find((k) =>
    eventType?.toLowerCase().includes(k)
  )
  return key ? EVENT_COLORS[key] : EVENT_COLORS.default
}

export function DecisionHistoryPanel({ listingId }: DecisionHistoryPanelProps) {
  const [history, setHistory] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    getSellerDecisionHistory(listingId, 20)
      .catch(() => null)
      .then((r) => {
        setHistory(r?.data ?? [])
        setLoading(false)
      })
  }, [listingId])

  const visible = expanded ? history : history.slice(0, 10)
  const hasMore = history.length > 10

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Decision History
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex gap-3 items-start">
                <div className="mt-1 h-2.5 w-2.5 rounded-full bg-muted animate-pulse shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-32 bg-muted animate-pulse rounded" />
                  <div className="h-2.5 w-20 bg-muted animate-pulse rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : history.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">
            No decision events recorded yet. Events are logged as the listing progresses.
          </p>
        ) : (
          <div className="relative">
            {/* Vertical timeline line */}
            <div className="absolute left-[5px] top-2 bottom-2 w-px bg-border" aria-hidden />

            <ul className="space-y-4 pl-5">
              {visible.map((event: any, i: number) => {
                const ts = event.created_at ?? event.timestamp ?? event.decided_at
                const label =
                  event.decision_type ??
                  event.event_type ??
                  event.state_label ??
                  event.type ??
                  "Event"
                const notes = event.notes ?? event.reason ?? event.metadata?.reason
                const triggeredBy = event.triggered_by ?? event.actor ?? event.metadata?.actor
                const isSystem = triggeredBy === "system" || !triggeredBy

                return (
                  <li key={event.id ?? i} className="relative flex gap-3 items-start">
                    {/* Timeline dot */}
                    <span
                      className={`absolute -left-5 mt-1 h-2.5 w-2.5 rounded-full shrink-0 ${dotColor(label)}`}
                      aria-hidden
                    />

                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium capitalize leading-snug">
                        {label.replace(/_/g, " ")}
                      </p>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        {ts && (
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(ts), { addSuffix: true })}
                          </span>
                        )}
                        <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                          {isSystem ? (
                            <Cpu className="h-3 w-3" />
                          ) : (
                            <User className="h-3 w-3" />
                          )}
                          {isSystem ? "System" : triggeredBy}
                        </span>
                      </div>
                      {notes && (
                        <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{notes}</p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>

            {hasMore && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-3 w-full text-xs"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? (
                  <>
                    <ChevronUp className="h-3 w-3 mr-1" />
                    Show less
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3 w-3 mr-1" />
                    Show {history.length - 10} more
                  </>
                )}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
