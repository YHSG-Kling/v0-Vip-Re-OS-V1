"use client"

/**
 * AgentInsightsWidget — surfaces AI coaching insights from the agent's
 * deal history (lib/workflow/intelligence/agent-pattern-insights).
 *
 * Client component (the dashboard page is a client component, so we can't
 * use an async server component directly). Loads insights via the
 * loadMyAgentInsights() server action on mount.
 *
 * Renders nothing until insights resolve. Renders nothing if the agent has
 * fewer than 5 deals (no patterns yet) — keeps the dashboard clean for
 * brand-new agents.
 *
 * PURELY ADDITIVE — drop into any layout slot. No props.
 */

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Sparkles, TrendingUp, Target, Zap } from "lucide-react"
import { loadMyAgentInsights } from "@/app/actions/agent-insights"
import type { AgentInsights } from "@/lib/workflow/intelligence/agent-pattern-insights"

const SEVERITY_BADGE: Record<"tip" | "opportunity" | "warning", string> = {
  tip:         "bg-blue-100 text-blue-700",
  opportunity: "bg-emerald-100 text-emerald-700",
  warning:     "bg-amber-100 text-amber-700",
}

const CATEGORY_ICON: Record<string, React.ElementType> = {
  win_rate:    Target,
  speed:       Zap,
  pricing:     TrendingUp,
  addenda:     TrendingUp,
  negotiation: TrendingUp,
  follow_up:   TrendingUp,
}

export default function AgentInsightsWidget() {
  const [insights, setInsights] = useState<AgentInsights | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadMyAgentInsights()
      .then(result => { if (!cancelled) setInsights(result) })
      .catch(() => { /* silent — never break dashboard */ })
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])

  if (!loaded) return null
  if (!insights || insights.dealsAnalyzed < 5 || insights.insights.length === 0) return null

  return (
    <Card className="border-violet-200 dark:border-violet-900 bg-gradient-to-br from-violet-50/40 to-transparent dark:from-violet-950/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-violet-600" />
          AI Coaching Insights
          <Badge variant="outline" className="ml-1 text-xs">{insights.dealsAnalyzed} deals</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {insights.summary && (
          <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
            {insights.summary}
          </p>
        )}

        <ul className="space-y-3">
          {insights.insights.slice(0, 4).map((ins, i) => {
            const Icon = CATEGORY_ICON[ins.category] ?? Sparkles
            return (
              <li key={i} className="flex items-start gap-3 rounded-md border bg-white dark:bg-slate-900 p-3">
                <Icon className="h-4 w-4 text-violet-600 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <p className="text-sm font-medium">{ins.title}</p>
                    <Badge variant="outline" className={`${SEVERITY_BADGE[ins.severity]} text-[10px] uppercase tracking-wider`}>
                      {ins.severity}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mb-1.5">{ins.detail}</p>
                  <p className="text-xs text-violet-700 dark:text-violet-400 italic">
                    → {ins.recommendation}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>

        {insights.insights.length > 4 && (
          <p className="text-xs text-muted-foreground text-center">
            +{insights.insights.length - 4} more insights · view full coaching
          </p>
        )}
      </CardContent>
    </Card>
  )
}
