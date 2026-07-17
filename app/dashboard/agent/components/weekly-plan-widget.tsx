"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Calendar, Loader2, Sparkles, ChevronLeft, ChevronRight } from "lucide-react"
import { generateWeeklyPlan } from "@/app/actions/ai-calendar-management"

interface Props {
  agentId: string
}

function startOfWeek(d: Date): Date {
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1) // Monday-start
  const r = new Date(d)
  r.setDate(diff)
  r.setHours(0, 0, 0, 0)
  return r
}

function shiftWeek(d: Date, weeks: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + weeks * 7)
  return r
}

export function WeeklyPlanWidget({ agentId }: Props) {
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()))
  const [plan, setPlan] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [, startTransition] = useTransition()

  async function load(forceRegenerate = false) {
    setLoading(true)
    try {
      const result = await generateWeeklyPlan({
        agentId,
        weekStartDate: weekStart.toISOString(),
        forceRegenerate,
      })
      if ((result as any).success) {
        setPlan((result as any).weeklyPlan ?? null)
      } else {
        setPlan(null)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, weekStart])

  const weekEnd = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000)
  const weekLabel = `${weekStart.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })} – ${weekEnd.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-primary" />
            Weekly Plan
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => startTransition(() => setWeekStart((d) => shiftWeek(d, -1)))}
              aria-label="Previous week"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums">{weekLabel}</span>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => startTransition(() => setWeekStart((d) => shiftWeek(d, 1)))}
              aria-label="Next week"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            Building your week…
          </div>
        ) : !plan ? (
          <div className="text-sm text-muted-foreground text-center py-4 space-y-2">
            <Sparkles className="h-5 w-5 mx-auto opacity-50" />
            <p>No plan generated for this week yet.</p>
            <Button size="sm" variant="outline" onClick={() => load()}>
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              Generate plan
            </Button>
          </div>
        ) : (
          <>
            {plan.summary && (
              <p className="text-xs text-muted-foreground italic">{plan.summary}</p>
            )}
            {plan.priorities && Array.isArray(plan.priorities) && plan.priorities.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  Top priorities
                </p>
                <ul className="space-y-1">
                  {plan.priorities.slice(0, 5).map((p: any, i: number) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <Badge variant="outline" className="text-[10px] mt-0.5 shrink-0">
                        {i + 1}
                      </Badge>
                      <span>{typeof p === "string" ? p : p.action ?? p.title ?? JSON.stringify(p)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {plan.appointments != null && (
              <div className="grid grid-cols-3 gap-2 text-xs pt-1 border-t">
                <div>
                  <p className="font-semibold tabular-nums">{plan.appointments ?? 0}</p>
                  <p className="text-muted-foreground">Appointments</p>
                </div>
                <div>
                  <p className="font-semibold tabular-nums">{plan.followUps ?? plan.follow_ups ?? 0}</p>
                  <p className="text-muted-foreground">Follow-ups</p>
                </div>
                <div>
                  <p className="font-semibold tabular-nums">{plan.deadlines ?? 0}</p>
                  <p className="text-muted-foreground">Deadlines</p>
                </div>
              </div>
            )}
            <Button size="sm" variant="ghost" className="w-full text-xs" onClick={() => load(true)}>
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              Regenerate plan
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}
