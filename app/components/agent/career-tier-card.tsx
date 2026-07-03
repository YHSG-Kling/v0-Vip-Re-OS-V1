"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Trophy } from "lucide-react"
import { getAgentCareerProgress, type AgentCareerProgress } from "@/app/actions/career-tier"

/**
 * <AgentCareerTierCard> — the agent's career progression: current tier, the ladder, and progress to the
 * next tier with the exact remaining gap. Real production/tenure/team stats via a server action.
 */
export function AgentCareerTierCard({ agentId }: { agentId: string }) {
  const [data, setData] = useState<AgentCareerProgress | null>(null)
  useEffect(() => {
    let alive = true
    if (agentId) getAgentCareerProgress(agentId).then((d) => { if (alive) setData(d) }).catch(() => {})
    return () => { alive = false }
  }, [agentId])

  if (!data) return null
  const { progress: prog } = data

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Trophy className="h-5 w-5 text-amber-500" /> Career Tier
          <Badge className="capitalize">{data.currentLabel}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-1">
          {data.ladder.map((t) => (
            <div key={t.tier} className={`flex-1 h-1.5 rounded ${t.reached ? "bg-amber-500" : "bg-muted"}`} title={t.label} />
          ))}
        </div>
        {data.nextLabel && prog.nextTier ? (
          <>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Next: <span className="font-medium text-foreground">{data.nextLabel}</span></span>
              <span className="font-semibold">{prog.pctToNext}%</span>
            </div>
            <div className="h-2 w-full rounded bg-muted overflow-hidden">
              <div className="h-full bg-amber-500" style={{ width: `${prog.pctToNext}%` }} />
            </div>
            {prog.gap && (
              <p className="text-xs text-muted-foreground">
                {Math.max(0, prog.gap.need - prog.gap.have)} more {prog.gap.metric} to reach {data.nextLabel}
                {data.nextRequiresApproval ? " (plus broker approval)" : ""}.
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">You&apos;ve reached the top of the ladder. 🎉</p>
        )}
      </CardContent>
    </Card>
  )
}
