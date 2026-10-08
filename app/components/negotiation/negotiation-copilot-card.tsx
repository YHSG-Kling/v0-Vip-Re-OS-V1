"use client"

/**
 * <NegotiationCoPilotCard> — Sprint 8.
 *
 * Hides on empty (no open strategies). Otherwise renders the persisted
 * strategy from negotiation_strategies for each active offer the agent has
 * a recommendation on. Three-way disposition: did_now / did_already /
 * let_ai_do_it / dismiss. Customer-mirror panel is INLINE inside the same
 * card — the agent can see exactly what the customer would see and edit
 * the framing before publishing.
 */

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Handshake, Loader2, CheckSquare, PlayCircle, X, Sparkles, Eye } from "lucide-react"
import {
  acceptStrategyAction,
  dismissStrategyAction,
  listOpenNegotiationStrategiesForAgentAction,
  type NegotiationStrategyView,
} from "@/app/actions/negotiation-strategy"

export function NegotiationCoPilotCard() {
  const [strategies, setStrategies] = useState<NegotiationStrategyView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showMirror, setShowMirror] = useState<Record<string, boolean>>({})
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await listOpenNegotiationStrategiesForAgentAction()
      if (cancelled) return
      if (!result.ok) {
        setError(result.error)
        setStrategies([])
        return
      }
      setStrategies(result.strategies)
    })()
    return () => { cancelled = true }
  }, [])

  if (strategies === null) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading negotiation strategies...
        </CardContent>
      </Card>
    )
  }

  if (strategies.length === 0 && !error) return null

  function handleAccept(id: string, disposition: "did_now" | "did_already" | "let_ai_do_it"): void {
    startTransition(async () => {
      const result = await acceptStrategyAction(id, disposition)
      if (result.ok) {
        setStrategies(s => (s ?? []).filter(x => x.id !== id))
      }
    })
  }

  function handleDismiss(id: string): void {
    startTransition(async () => {
      const result = await dismissStrategyAction(id)
      if (result.ok) {
        setStrategies(s => (s ?? []).filter(x => x.id !== id))
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Handshake className="h-4 w-4" />
          Negotiation Co-Pilot
          <Badge variant="secondary" className="ml-auto text-xs">
            {strategies.length} open
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <div className="text-xs text-destructive">{error}</div>}

        {strategies.map(s => {
          const isOpen   = !!expanded[s.id]
          const mirrorOn = !!showMirror[s.id]
          const winPct   = s.winProbability != null ? Math.round(s.winProbability * 100) : null
          const confPct  = s.confidence    != null ? Math.round(s.confidence    * 100) : null

          return (
            <div key={s.id} className="rounded-md border p-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Sparkles className="h-3.5 w-3.5 text-purple-500 flex-shrink-0" />
                    <Badge variant={s.recommendedAction === "accept" ? "default" : s.recommendedAction === "walk" ? "destructive" : "secondary"}>
                      {s.recommendedAction.replace(/_/g, " ")}
                    </Badge>
                    <Badge variant="outline" className="text-xs">{s.side}-side</Badge>
                    {/* generated_by attribution — who authored this strategy. */}
                    {s.generatedBy && (
                      <Badge variant="outline" className="text-xs text-purple-700">
                        {s.generatedBy === "ai" ? "AI-generated" : s.generatedBy}
                      </Badge>
                    )}
                    {winPct != null && <Badge variant="outline" className="text-xs">win {winPct}%</Badge>}
                    {confPct != null && <Badge variant="outline" className="text-xs">conf {confPct}%</Badge>}
                    {s.recommendedCounterPrice != null && (
                      <Badge variant="outline" className="text-xs">
                        counter ${s.recommendedCounterPrice.toLocaleString()}
                      </Badge>
                    )}
                  </div>

                  {!isOpen && (
                    <p className="text-sm text-muted-foreground line-clamp-2 mt-2">
                      {s.agentStrategyMd.slice(0, 200)}{s.agentStrategyMd.length > 200 ? "..." : ""}
                    </p>
                  )}

                  {isOpen && (
                    <div className="mt-3 flex flex-col gap-3">
                      <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm">
                        {s.agentStrategyMd}
                      </div>

                      {/* WHY this strategy — curated rationale_signals (never the raw JSON;
                          see StrategyRationale in app/actions/negotiation-strategy.ts). */}
                      {s.rationale && (
                        <div className="rounded-md border bg-muted/30 p-2 text-xs space-y-1">
                          <p className="font-medium">Why this strategy</p>
                          {s.rationale.keyRisks.length > 0 && (
                            <ul className="list-disc pl-4 text-muted-foreground">
                              {s.rationale.keyRisks.map((risk, i) => <li key={i}>{risk}</li>)}
                            </ul>
                          )}
                          {s.rationale.agentTrackRecord && (
                            <p className="text-muted-foreground">Your track record: {s.rationale.agentTrackRecord}</p>
                          )}
                          {s.rationale.peerPatternKeys.length > 0 && (
                            <p className="text-muted-foreground">
                              Peer patterns: {s.rationale.peerPatternKeys.map(k => k.replace(/_/g, " ")).join(", ")}
                            </p>
                          )}
                          {s.rationale.priorRoundsCount != null && s.rationale.priorRoundsCount > 0 && (
                            <p className="text-muted-foreground">
                              {s.rationale.priorRoundsCount} prior negotiation round{s.rationale.priorRoundsCount === 1 ? "" : "s"} considered
                            </p>
                          )}
                        </div>
                      )}

                      {s.draftedCounterLanguage && (
                        <details className="rounded-md border bg-muted/30 p-2">
                          <summary className="cursor-pointer text-xs font-medium">
                            Drafted counter response (paste-ready)
                          </summary>
                          <pre className="text-xs whitespace-pre-wrap mt-2">{s.draftedCounterLanguage}</pre>
                        </details>
                      )}

                      {s.customerExplanationMd && (
                        <div className="rounded-md border-2 border-dashed border-blue-200 bg-blue-50/50 p-3">
                          <div className="flex items-center gap-2 mb-2">
                            <Eye className="h-3.5 w-3.5 text-blue-600" />
                            <span className="text-xs font-medium text-blue-700">
                              Customer sees this (mirror view)
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="ml-auto h-6 text-xs"
                              onClick={() => setShowMirror(m => ({ ...m, [s.id]: !mirrorOn }))}
                            >
                              {mirrorOn ? "hide" : "show"}
                            </Button>
                          </div>
                          {mirrorOn && (
                            <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm text-blue-900">
                              {s.customerExplanationMd}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="flex items-center gap-2 flex-wrap">
                        <Button size="sm" disabled={isPending} onClick={() => handleAccept(s.id, "did_now")}>
                          <CheckSquare className="h-3.5 w-3.5 mr-1" /> I did this
                        </Button>
                        <Button size="sm" variant="secondary" disabled={isPending} onClick={() => handleAccept(s.id, "did_already")}>
                          Already did
                        </Button>
                        <Button size="sm" variant="secondary" disabled={isPending} onClick={() => handleAccept(s.id, "let_ai_do_it")}>
                          <PlayCircle className="h-3.5 w-3.5 mr-1" /> Let AI handle
                        </Button>
                        <Button size="sm" variant="ghost" disabled={isPending} onClick={() => handleDismiss(s.id)}>
                          <X className="h-3.5 w-3.5 mr-1" /> Dismiss
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setExpanded(e => ({ ...e, [s.id]: !isOpen }))}
                  className="flex-shrink-0"
                >
                  {isOpen ? "Collapse" : "Open"}
                </Button>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
