"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Loader2, Sparkles, Target, TrendingUp, CheckCircle2, AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import {
  upsertAgentGoal,
  aiRecommendGoals,
  aiCoachGoalProgress,
  syncGoalCurrentValues,
} from "@/app/actions/ai-agent-goals"
import { AGENT_GOAL_LABELS, AGENT_GOAL_TYPES } from "@/lib/goals/goal-types"

// DERIVED, not hand-written. This list used to name six goal types of which
// FOUR were refused by agent_goals_goal_type_check — every save of those four
// failed with 23514 while the page reported nothing wrong. The labels now come
// from the same constant the server validates against.
const GOAL_LABELS: Record<string, string> = AGENT_GOAL_LABELS

const STATUS_CONFIG = {
  on_track: { label: "On Track", color: "bg-green-100 text-green-700" },
  ahead: { label: "Ahead", color: "bg-emerald-100 text-emerald-700" },
  slightly_behind: { label: "Slightly Behind", color: "bg-amber-100 text-amber-700" },
  behind: { label: "Behind", color: "bg-orange-100 text-orange-700" },
  at_risk: { label: "At Risk", color: "bg-red-100 text-red-700" },
}

interface Goal {
  id: string
  goal_type: string
  target_value: number
  current_value: number
  notes?: string | null
}

interface GoalsClientProps {
  agentId: string
  brokerageId: string
  initialGoals: Goal[]
  year: number
}

export function GoalsClient({ agentId, brokerageId, initialGoals, year }: GoalsClientProps) {
  const [goals, setGoals] = useState<Goal[]>(initialGoals)
  const [coaching, setCoaching] = useState<any>(null)
  const [recommendations, setRecommendations] = useState<any>(null)
  const [editTarget, setEditTarget] = useState<Record<string, string>>({})
  const [isPending, startTransition] = useTransition()
  const [coachLoading, setCoachLoading] = useState(false)
  const [recLoading, setRecLoading] = useState(false)

  const handleSaveTarget = (goalType: string) => {
    const val = parseFloat(editTarget[goalType] ?? "")
    if (isNaN(val) || val <= 0) { toast.error("Enter a valid number"); return }
    startTransition(async () => {
      const result = await upsertAgentGoal({ agentId, brokerageId, goalType, targetValue: val, year })
      if (result.success) {
        setGoals(prev => {
          const existing = prev.find(g => g.goal_type === goalType)
          if (existing) return prev.map(g => g.goal_type === goalType ? { ...g, target_value: val } : g)
          return [...prev, { id: Date.now().toString(), goal_type: goalType, target_value: val, current_value: 0 }]
        })
        setEditTarget(prev => { const n = { ...prev }; delete n[goalType]; return n })
        toast.success("Goal saved")
      } else {
        toast.error((result as any).error ?? "Failed to save goal")
      }
    })
  }

  const handleSync = () => {
    startTransition(async () => {
      const result = await syncGoalCurrentValues({ agentId, brokerageId, year })
      if (result.success) {
        const fresh = await import("@/app/actions/ai-agent-goals").then(m =>
          m.getAgentGoals({ agentId, brokerageId, year })
        )
        if (fresh.data) setGoals(fresh.data as Goal[])
        toast.success("Progress synced from live data")
      } else {
        toast.error("Sync failed")
      }
    })
  }

  const handleCoach = async () => {
    setCoachLoading(true)
    try {
      const result = await aiCoachGoalProgress({ agentId, brokerageId, year })
      if (result.success) setCoaching((result as any).data)
      else toast.error((result as any).error ?? "Coaching unavailable")
    } finally {
      setCoachLoading(false)
    }
  }

  const handleRecommend = async () => {
    setRecLoading(true)
    try {
      const result = await aiRecommendGoals({ agentId, brokerageId, year })
      if (result.success) setRecommendations((result as any).data)
      else toast.error("Could not generate recommendations")
    } finally {
      setRecLoading(false)
    }
  }

  const allGoalTypes = Array.from(new Set([
    ...Object.keys(GOAL_LABELS),
    ...goals.map(g => g.goal_type),
  ]))

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{year} Goals</h1>
          <p className="text-muted-foreground text-sm mt-1">Set targets and track your progress</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleSync} disabled={isPending}>
            {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <TrendingUp className="h-4 w-4 mr-1" />}
            Sync Progress
          </Button>
          <Button variant="outline" size="sm" onClick={handleRecommend} disabled={recLoading}>
            {recLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}
            AI Recommendations
          </Button>
          <Button size="sm" onClick={handleCoach} disabled={coachLoading || goals.length === 0}>
            {coachLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Target className="h-4 w-4 mr-1" />}
            Coach Me
          </Button>
        </div>
      </div>

      {/* Goals grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {allGoalTypes.map(goalType => {
          const goal = goals.find(g => g.goal_type === goalType)
          const pct = goal && goal.target_value > 0
            ? Math.min(100, Math.round((goal.current_value / goal.target_value) * 100))
            : 0
          const isEditing = goalType in editTarget

          return (
            <Card key={goalType}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium">
                    {GOAL_LABELS[goalType] ?? goalType.replace(/_/g, " ")}
                  </CardTitle>
                  {goal && (
                    <span className="text-xs text-muted-foreground">
                      {pct}%
                    </span>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {goal ? (
                  <>
                    <Progress value={pct} className="h-2" />
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        Current: <span className="font-medium text-foreground">
                          {goalType === "gci"
                            ? `$${goal.current_value.toLocaleString()}`
                            : goal.current_value}
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        Target: <span className="font-medium text-foreground">
                          {goalType === "gci"
                            ? `$${goal.target_value.toLocaleString()}`
                            : goal.target_value}
                        </span>
                      </span>
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">No target set</p>
                )}
                {isEditing ? (
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      placeholder="Target value"
                      className="h-8 text-sm"
                      value={editTarget[goalType]}
                      onChange={e => setEditTarget(prev => ({ ...prev, [goalType]: e.target.value }))}
                    />
                    <Button size="sm" className="h-8" onClick={() => handleSaveTarget(goalType)} disabled={isPending}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8" onClick={() => setEditTarget(prev => { const n = { ...prev }; delete n[goalType]; return n })}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs w-full"
                    onClick={() => setEditTarget(prev => ({ ...prev, [goalType]: goal?.target_value.toString() ?? "" }))}
                  >
                    {goal ? "Edit Target" : "Set Target"}
                  </Button>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* AI Coach response */}
      {coaching && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Target className="h-4 w-4 text-primary" />
              AI Coaching Report
              {STATUS_CONFIG[coaching.overallStatus as keyof typeof STATUS_CONFIG] && (
                <Badge className={`text-xs ${STATUS_CONFIG[coaching.overallStatus as keyof typeof STATUS_CONFIG].color}`}>
                  {STATUS_CONFIG[coaching.overallStatus as keyof typeof STATUS_CONFIG].label}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm italic text-muted-foreground">"{coaching.motivationalMessage}"</p>
            <Separator />
            <div>
              <p className="text-sm font-medium mb-2">Top Priority</p>
              <p className="text-sm text-muted-foreground">{coaching.topPriority}</p>
            </div>
            <div>
              <p className="text-sm font-medium mb-2">This Week's Actions</p>
              <ul className="space-y-1">
                {coaching.weeklyActions?.map((action: string, i: number) => (
                  <li key={i} className="text-sm flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                    {action}
                  </li>
                ))}
              </ul>
            </div>
            {coaching.byGoal?.some((g: any) => g.status === "at_risk" || g.status === "behind") && (
              <div>
                <p className="text-sm font-medium mb-2 flex items-center gap-1">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  Needs Attention
                </p>
                {coaching.byGoal
                  ?.filter((g: any) => g.status === "at_risk" || g.status === "behind")
                  .map((g: any) => (
                    <div key={g.goal_type} className="text-sm p-2 rounded bg-amber-50 border border-amber-200 mb-2">
                      <p className="font-medium">{GOAL_LABELS[g.goal_type] ?? g.goal_type}</p>
                      <p className="text-muted-foreground">{g.coaching}</p>
                    </div>
                  ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* AI Recommendations */}
      {recommendations && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              AI Goal Recommendations for {year}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{recommendations.overallStrategy}</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {recommendations.goals?.map((rec: any) => (
                <div key={rec.goal_type} className="p-3 border rounded-lg space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">{GOAL_LABELS[rec.goal_type] ?? rec.goal_type}</p>
                    <Badge variant="outline" className="text-xs">
                      Target: {rec.goal_type === "gci" ? `$${rec.target_value.toLocaleString()}` : rec.target_value}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{rec.rationale}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs w-full"
                    onClick={() => {
                      startTransition(async () => {
                        const result = await upsertAgentGoal({
                          agentId,
                          brokerageId,
                          goalType: rec.goal_type,
                          targetValue: rec.target_value,
                          year,
                          notes: rec.rationale,
                        })
                        if (result.success) {
                          setGoals(prev => {
                            const existing = prev.find(g => g.goal_type === rec.goal_type)
                            if (existing) return prev.map(g => g.goal_type === rec.goal_type ? { ...g, target_value: rec.target_value } : g)
                            return [...prev, { id: Date.now().toString(), goal_type: rec.goal_type, target_value: rec.target_value, current_value: 0 }]
                          })
                          toast.success(`${GOAL_LABELS[rec.goal_type] ?? rec.goal_type} goal set`)
                        }
                      })
                    }}
                    disabled={isPending}
                  >
                    Apply This Target
                  </Button>
                </div>
              ))}
            </div>
            {recommendations.quickWins?.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-1">Quick Wins</p>
                <ul className="space-y-1">
                  {recommendations.quickWins.map((w: string, i: number) => (
                    <li key={i} className="text-xs text-muted-foreground flex items-center gap-2">
                      <CheckCircle2 className="h-3 w-3 text-green-500" />
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
