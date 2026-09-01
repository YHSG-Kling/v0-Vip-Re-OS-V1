"use client"

import { useState, useEffect } from "react"
import { Clock, ChevronDown, ChevronUp, User, Cpu, CheckCircle2, Circle, RefreshCw } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  getSellerDecisionHistory,
  getSellerDecisionStates,
  getMilestoneDecisionStates,
  getDecisionStateDefinition,
} from "@/app/actions/seller-decision-governance"
import type { SellerDecisionState } from "@/lib/seller-decision-governance/decision-state-definitions"
import { formatDistanceToNow } from "date-fns"

interface DecisionHistoryPanelProps {
  listingId: string
}

// TOMBSTONE (orphan doctrine §1.1, 2026-09-01): the duplicate
// app/dashboard/listings/[id]/offers/components/decision-history-panel.tsx was
// deleted — an earlier, poorer twin of THIS panel (no state-catalog labels, no
// milestone ladder, wrong response field: it read `.decisions` where the action
// returns `.data`) that nothing imported; both its render sites import this
// file. The one capability it had that this survivor lacked — a manual Refresh
// button — was merged here (the reloadKey state + header button below) before
// the twin was deleted.

/**
 * The rows come back from queryDecisionHistory as raw activity rows —
 * { event_type: activity_type, metadata, created_at } — so the label this panel
 * used to render was the literal string "seller.decision.transition" for every
 * transition, and the STATE the listing actually entered (metadata.to_state) was
 * never shown at all. The state catalog knows the human label, the description,
 * the SLA and who may override each state; it was exported and called from
 * nowhere. Loading it here turns the timeline from event plumbing into the
 * decision ladder the agent is actually walking.
 */
interface StateDef {
  state: SellerDecisionState
  label: string
  description: string
  isMilestone: boolean
  slaExpectationHours?: number
  allowsOverride: boolean
  overrideRequiredRole?: string
  allowsReversal: boolean
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
  /** The whole 8-state catalog, keyed by state — the labels for the timeline. */
  const [stateDefs, setStateDefs] = useState<Record<string, StateDef>>({})
  /** The milestone subset, in canonical order — the ladder strip. */
  const [milestones, setMilestones] = useState<StateDef[]>([])
  /** The definition of the state this listing is CURRENTLY in. */
  const [currentDef, setCurrentDef] = useState<StateDef | null>(null)
  /** Bumped by the Refresh button — re-runs the load effect (merged from the deleted twin). */
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function load() {
      const [historyRes, statesRes, milestoneRes] = await Promise.all([
        getSellerDecisionHistory(listingId, 20).catch(() => null),
        getSellerDecisionStates().catch(() => null),
        getMilestoneDecisionStates().catch(() => null),
      ])
      if (cancelled) return

      const rows: any[] = (historyRes as any)?.data ?? []
      setHistory(rows)

      const defs = ((statesRes as any)?.data ?? []) as StateDef[]
      setStateDefs(Object.fromEntries(defs.map((d) => [d.state, d])))
      setMilestones((((milestoneRes as any)?.data ?? []) as StateDef[]))

      // The current decision state is the to_state of the newest transition row
      // (queryDecisionHistory returns newest-first).
      const latestTransition = rows.find(
        (r: any) => r?.event_type === "seller.decision.transition" && r?.metadata?.to_state
      )
      const current = latestTransition?.metadata?.to_state as SellerDecisionState | undefined
      if (current) {
        const defRes = await getDecisionStateDefinition(current).catch(() => null)
        if (!cancelled) setCurrentDef(((defRes as any)?.data ?? null) as StateDef | null)
      }

      if (!cancelled) setLoading(false)
    }

    setLoading(true)
    load().catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [listingId, reloadKey])

  const visible = expanded ? history : history.slice(0, 10)
  const hasMore = history.length > 10

  /** Which milestones this listing has already passed through. */
  const reachedStates = new Set<string>(
    history
      .filter((r: any) => r?.event_type === "seller.decision.transition")
      .map((r: any) => r?.metadata?.to_state)
      .filter(Boolean)
  )

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Decision History
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
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
          <div className="space-y-4">
            {/* ═══ CURRENT DECISION STATE ═══════════════════════════════════
                Straight from the state catalog — label, what the state means,
                its SLA, and who is allowed to override or reverse it. */}
            {currentDef && (
              <div className="rounded-md border bg-muted/30 p-3 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground">Current decision state</span>
                  <Badge variant="secondary" className="text-[10px]">{currentDef.label}</Badge>
                  {currentDef.slaExpectationHours != null && (
                    <span className="text-[10px] text-muted-foreground">
                      SLA {currentDef.slaExpectationHours}h
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{currentDef.description}</p>
                <p className="text-[10px] text-muted-foreground">
                  {currentDef.allowsOverride
                    ? `Override allowed${currentDef.overrideRequiredRole ? ` (${currentDef.overrideRequiredRole})` : ""}`
                    : "No override permitted"}
                  {" · "}
                  {currentDef.allowsReversal ? "Reversible" : "Not reversible"}
                </p>
              </div>
            )}

            {/* ═══ MILESTONE LADDER ═════════════════════════════════════════
                The milestone subset of the catalog, marked against the states
                this listing has actually entered. */}
            {milestones.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {milestones.map((m) => {
                  const reached = reachedStates.has(m.state)
                  return (
                    <span
                      key={m.state}
                      title={m.description}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${
                        reached
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-border bg-muted/40 text-muted-foreground"
                      }`}
                    >
                      {reached ? <CheckCircle2 className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
                      {m.label}
                    </span>
                  )
                })}
              </div>
            )}

          <div className="relative">
            {/* Vertical timeline line */}
            <div className="absolute left-[5px] top-2 bottom-2 w-px bg-border" aria-hidden />

            <ul className="space-y-4 pl-5">
              {visible.map((event: any, i: number) => {
                const ts = event.created_at ?? event.timestamp ?? event.decided_at
                const rawLabel =
                  event.decision_type ??
                  event.event_type ??
                  event.state_label ??
                  event.type ??
                  "Event"

                // A transition row names the states it moved between; render the
                // catalog's human labels rather than the activity_type string.
                const toDef = stateDefs[event.metadata?.to_state]
                const fromDef = stateDefs[event.metadata?.from_state]
                const label = toDef
                  ? fromDef
                    ? `${fromDef.label} → ${toDef.label}`
                    : toDef.label
                  : rawLabel

                const notes =
                  event.notes ??
                  event.reason ??
                  event.metadata?.reason ??
                  event.metadata?.override_reason ??
                  event.metadata?.reversal_reason ??
                  toDef?.description
                const triggeredBy =
                  event.triggered_by ?? event.actor ?? event.metadata?.actor ?? event.metadata?.authority_role
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
          </div>
        )}
      </CardContent>
    </Card>
  )
}
