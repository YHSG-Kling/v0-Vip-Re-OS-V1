"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Rocket, CheckCircle2, Clock } from "lucide-react"
import { getAgentDailyActionPlan, type AgentJourney } from "@/app/actions/onboarding/daily-plan"

/**
 * <OnboardingJourneyCard> — the new agent's 90-day journey: current phase + progress + today's action plan
 * (3 priority tasks + 1 learning tip), drawn from their real onboarding state. Hides once onboarding ends.
 */
export function OnboardingJourneyCard({ agentId }: { agentId: string }) {
  const [j, setJ] = useState<AgentJourney | null>(null)
  useEffect(() => {
    let alive = true
    if (agentId) getAgentDailyActionPlan(agentId).then((d) => { if (alive) setJ(d) }).catch(() => {})
    return () => { alive = false }
  }, [agentId])

  if (!j || !j.active || !j.progress || !j.plan) return null
  const riskColor = j.risk === "red" ? "bg-red-100 text-red-800 border-red-200" : j.risk === "yellow" ? "bg-amber-100 text-amber-800 border-amber-200" : ""

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Rocket className="h-5 w-5 text-indigo-500" /> Your 90-Day Journey
          <Badge variant="secondary">Phase {j.progress.phase}: {j.progress.phaseLabel}</Badge>
          {j.risk !== "none" && <Badge className={`border ${riskColor}`}>{j.risk === "red" ? "behind" : "watch"}</Badge>}
        </CardTitle>
        <CardDescription>{j.plan.greeting}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
            <span>Overall</span><span>{j.progress.overallPct}%</span>
          </div>
          <div className="h-2 w-full rounded bg-muted overflow-hidden">
            <div className="h-full bg-indigo-500" style={{ width: `${j.progress.overallPct}%` }} />
          </div>
          <p className="text-xs text-muted-foreground mt-1">{j.phaseFocus}</p>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Today&apos;s priorities</p>
          <div className="space-y-2">
            {j.plan.priorityTasks.map((t, i) => (
              <div key={i} className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 text-indigo-500 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{t.title}</div>
                  <div className="text-xs text-muted-foreground">{t.detail}{t.estimatedMinutes ? ` · ~${t.estimatedMinutes} min` : ""}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-md bg-indigo-50 p-2">
          <Clock className="h-4 w-4 text-indigo-600 mt-0.5 shrink-0" />
          <p className="text-xs text-indigo-900">{j.plan.learningTip}</p>
        </div>
      </CardContent>
    </Card>
  )
}
