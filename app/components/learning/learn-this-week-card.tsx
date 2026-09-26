"use client"

/**
 * <LearnThisWeekCard> — Sprint 7.
 *
 * Single card that surfaces the next 1–3 learning modules picked by the
 * Knowledge & Growth Router for the current actor (agent / TC /
 * compliance_officer / team_lead). The picks are produced by
 * pickLearningModulesForActor() in lib/learning-router/composer.ts —
 * audience tags ∩ persona/generation/stage/gap → priority rank.
 *
 * Each row shows:
 *   - title + summary
 *   - signalSource chip (why this was picked — drives explainer)
 *   - estimated minutes
 *   - "Start" deep-link
 *
 * Hides on empty (no flash).
 */

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2, GraduationCap, ArrowRight } from "lucide-react"
import {
  getLearningAssignmentsForActorAction,
} from "@/app/actions/learning-modules"
import type { LearningActorKind, LearningModulePick } from "@/lib/learning-router/composer"

interface Props {
  actorKind: LearningActorKind
  actorId:   string
  limit?:    number
}

export function LearnThisWeekCard({ actorKind, actorId, limit = 3 }: Props) {
  const [picks, setPicks] = useState<LearningModulePick[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await getLearningAssignmentsForActorAction({ actorKind, actorId, limit })
      if (cancelled) return
      if (!result.ok) {
        setError(result.error)
        setPicks([])
        return
      }
      setPicks(result.picks)
    })()
    return () => { cancelled = true }
  }, [actorKind, actorId, limit])

  if (picks === null) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading recommended learning...
        </CardContent>
      </Card>
    )
  }

  // Hide on inbox zero — no flash, no "nothing to show" copy
  if (picks.length === 0 && !error) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <GraduationCap className="h-4 w-4" />
          Learn this week
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && (
          <div className="text-xs text-destructive">Couldn&apos;t load: {error}</div>
        )}

        {picks.map((p: LearningModulePick) => (
          // REPOINTED (dangling-link sweep, 2026-09-02): was `/learn/${id}` —
          // app/learn does not exist. `p.id` is a learning_modules.id
          // (lib/learning-router/composer.ts:314) and the in-app module reader
          // by that id is app/academy/module/[id]/page.tsx, gated by
          // getModuleForLearner (authenticated + brokerage isolation + published).
          <Link
            key={p.id}
            href={`/academy/module/${p.id}`}
            className="rounded-md border p-3 hover:bg-muted/40 transition-colors flex items-start gap-3"
          >
            {p.coverImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.coverImageUrl} alt="" className="h-14 w-14 rounded-md object-cover flex-shrink-0" />
            ) : (
              <div className="h-14 w-14 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                <GraduationCap className="h-6 w-6 text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium truncate">{p.title}</span>
              </div>
              {p.summary && (
                <p className="text-sm text-muted-foreground line-clamp-2 mt-0.5">{p.summary}</p>
              )}
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                <Badge variant="secondary" className="text-xs">{p.signalSource}</Badge>
                {p.estimatedMinutes != null && p.estimatedMinutes > 0 && (
                  <Badge variant="outline" className="text-xs">{p.estimatedMinutes} min</Badge>
                )}
                {p.channels.slice(0, 2).map((c: string) => (
                  <Badge key={c} variant="outline" className="text-xs">{c}</Badge>
                ))}
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-1" />
          </Link>
        ))}
      </CardContent>
    </Card>
  )
}
