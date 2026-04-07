"use client"

import { useState, useEffect, useTransition } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Calendar, ChevronRight, Clock, Sparkles, AlertTriangle } from "lucide-react"
import Link from "next/link"
import { generateWeeklyPlan } from "@/app/actions/ai-calendar-management"

// Stable singleton — createClient() inside a component body creates a new object
// on every render, which breaks useEffect dependency comparisons.
const supabase = createClient()

interface ThisWeekPreviewProps {
  agentId: string
}

type WeeklyPlan = {
  weekOverview: {
    focus: string
    keyPriorities: string[]
    expectedOutcomes: string[]
  }
  dailyThemes: Array<{
    day: string
    theme: string
    topPriority: string
  }>
  transactionFocus: Array<{
    transaction: string
    status: string
    thisWeekActions: string[]
    riskLevel: string
  }>
}

type DayEvent = {
  id: string
  title: string
  time: string
  type: string
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  showing: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  tour: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  closing: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  inspection: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  appointment: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
  follow_up: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
  default: "bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300",
}

export function ThisWeekPreview({ agentId }: ThisWeekPreviewProps) {

  const [isPending, startTransition] = useTransition()
  const [weeklyPlan, setWeeklyPlan] = useState<WeeklyPlan | null>(null)
  const [upcomingEvents, setUpcomingEvents] = useState<DayEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadWeekData() {
      setLoading(true)
      const now = new Date()
      const weekStart = new Date(now)
      weekStart.setDate(weekStart.getDate() - weekStart.getDay())
      const weekEnd = new Date(weekStart)
      weekEnd.setDate(weekEnd.getDate() + 7)

      // Fetch upcoming events for preview
      const { data: showings } = await supabase
        .from("showings")
        .select("id, scheduled_at, notes, listing_id")
        .eq("agent_id", agentId)
        .gte("scheduled_at", now.toISOString())
        .lt("scheduled_at", weekEnd.toISOString())
        .neq("status", "cancelled")
        .order("scheduled_at")
        .limit(5)

      const events: DayEvent[] = (showings || []).map((s: any) => ({
        id: s.id,
        title: s.notes || "Showing",
        time: new Date(s.scheduled_at).toLocaleString([], {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
        }),
        type: "showing",
      }))

      setUpcomingEvents(events)
      // No persistent plan store — plan is generated on-demand and held in local state only
      setLoading(false)
    }
    loadWeekData()
  }, [agentId])

  const handleGeneratePlan = () => {
    const weekStart = new Date()
    weekStart.setDate(weekStart.getDate() - weekStart.getDay())

    startTransition(async () => {
      const res = await generateWeeklyPlan({
        agentId,
        weekStartDate: weekStart.toISOString().split("T")[0],
      })
      if (res.success && res.weeklyPlan) {
        setWeeklyPlan(res.weeklyPlan as WeeklyPlan)
      }
    })
  }

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            This Week Preview
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">Loading...</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            This Week Preview
          </CardTitle>
          <Link href="/dashboard/calendar">
            <Button variant="ghost" size="sm" className="text-xs h-7">
              Open Calendar
              <ChevronRight className="h-3 w-3 ml-1" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Upcoming Events */}
        {upcomingEvents.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Upcoming</h4>
            <ScrollArea className="h-[120px]">
              <div className="space-y-1.5">
                {upcomingEvents.map((event) => (
                  <div
                    key={event.id}
                    className="flex items-center justify-between p-2 rounded-lg bg-muted/50"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge
                        className={`text-[10px] px-1.5 ${EVENT_TYPE_COLORS[event.type] || EVENT_TYPE_COLORS.default}`}
                      >
                        {event.type}
                      </Badge>
                      <span className="text-xs text-foreground truncate">{event.title}</span>
                    </div>
                    <span className="text-xs text-muted-foreground flex-shrink-0 flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {event.time}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}

        {upcomingEvents.length === 0 && !weeklyPlan && (
          <p className="text-sm text-muted-foreground text-center py-2">No upcoming events this week</p>
        )}

        {/* Weekly Plan */}
        {weeklyPlan ? (
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              AI Week Focus
            </h4>
            <div className="p-2 bg-primary/5 rounded-lg">
              <p className="text-xs font-medium text-foreground">{weeklyPlan.weekOverview.focus}</p>
              {weeklyPlan.weekOverview.keyPriorities.slice(0, 2).map((p, i) => (
                <p key={i} className="text-xs text-muted-foreground mt-0.5">- {p}</p>
              ))}
            </div>

            {/* Transaction Alerts */}
            {weeklyPlan.transactionFocus.filter((t) => t.riskLevel === "high").length > 0 && (
              <div className="p-2 bg-destructive/10 rounded-lg">
                <div className="flex items-center gap-1 text-xs font-medium text-destructive">
                  <AlertTriangle className="h-3 w-3" />
                  High-Risk Transactions
                </div>
                {weeklyPlan.transactionFocus
                  .filter((t) => t.riskLevel === "high")
                  .slice(0, 2)
                  .map((t, i) => (
                    <p key={i} className="text-xs text-muted-foreground mt-0.5">{t.transaction}</p>
                  ))}
              </div>
            )}
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="w-full text-xs"
            onClick={handleGeneratePlan}
            disabled={isPending}
          >
            <Sparkles className="h-3 w-3 mr-1.5" />
            {isPending ? "Generating..." : "Generate AI Weekly Plan"}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
