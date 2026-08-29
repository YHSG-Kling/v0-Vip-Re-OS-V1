"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  Loader2,
  RefreshCw,
  Sparkles,
  Users,
  X,
  CheckCheck,
  ChevronDown,
  ChevronUp,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  adoptInsightAction,
  dismissInsightAction,
  rescanBrokerageIntelligenceAction,
  type BrokerageInsight,
} from "@/app/actions/brokerage-intelligence"

interface AgentOption { id: string; name: string }

interface Props {
  open:      BrokerageInsight[]
  dismissed: BrokerageInsight[]
  agents:    AgentOption[]
}

const PATTERN_LABEL: Record<string, string> = {
  response_time:      "Lead response time",
  ai_isa_lift:        "AI ISA enablement",
  touchpoint_cadence: "Sphere touchpoint cadence",
  drip_engagement:    "Drip enrollment",
}

const SEVERITY_BG: Record<string, string> = {
  critical: "bg-red-500 text-white",
  high:     "bg-orange-500 text-white",
  medium:   "bg-amber-500 text-white",
  low:      "bg-gray-300 text-gray-800",
}

function formatMetric(label: string | null, value: number | null | undefined): string {
  if (label == null || value == null) return "—"
  if (label.includes("minute")) return `${Math.round(value)} min`
  if (label.includes("day"))    return `${Math.round(value)}d`
  if (label.includes("%"))      return `${Math.round(value)}%`
  return `${Math.round(value)}`
}

export function IntelligenceMeshClient({ open, dismissed, agents }: Props) {
  const router = useRouter()
  const [mining, setMining] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [adoptingId, setAdoptingId] = useState<string | null>(null)
  const [dismissingId, setDismissingId] = useState<string | null>(null)
  const [selectedAgents, setSelectedAgents] = useState<Record<string, Set<string>>>({})

  function toggleAgent(insightId: string, agentId: string) {
    setSelectedAgents((prev) => {
      const next = { ...prev }
      const set = new Set(next[insightId] ?? [])
      if (set.has(agentId)) set.delete(agentId)
      else set.add(agentId)
      next[insightId] = set
      return next
    })
  }

  function selectAll(insightId: string) {
    setSelectedAgents((prev) => ({ ...prev, [insightId]: new Set(agents.map((a) => a.id)) }))
  }

  function clearSelected(insightId: string) {
    setSelectedAgents((prev) => ({ ...prev, [insightId]: new Set() }))
  }

  async function handleMine() {
    if (mining) return
    setMining(true)
    try {
      const r = await rescanBrokerageIntelligenceAction()
      if (r.success) {
        toast.success(r.written && r.written > 0
          ? `Mining complete — ${r.written} new insight${r.written === 1 ? "" : "s"}`
          : "Mining complete — no new patterns this run"
        )
        router.refresh()
      } else {
        toast.error(r.error ?? "Mining failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Mining failed")
    } finally {
      setMining(false)
    }
  }

  async function handleAdopt(insight: BrokerageInsight) {
    const agentIds = Array.from(selectedAgents[insight.id] ?? new Set<string>())
    setAdoptingId(insight.id)
    try {
      const r = await adoptInsightAction({
        insightId: insight.id,
        agentIds:  agentIds.length > 0 ? agentIds : undefined,
      })
      if (r.success) {
        toast.success(`Playbook adopted by ${r.adopted ?? 0} agent${r.adopted === 1 ? "" : "s"}`)
        setExpanded(null)
        router.refresh()
      } else {
        toast.error(r.error ?? "Adoption failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Adoption failed")
    } finally {
      setAdoptingId(null)
    }
  }

  async function handleDismiss(insight: BrokerageInsight) {
    setDismissingId(insight.id)
    try {
      const r = await dismissInsightAction({ insightId: insight.id })
      if (r.success) {
        toast.success("Insight dismissed")
        router.refresh()
      } else {
        toast.error(r.error ?? "Dismissal failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Dismissal failed")
    } finally {
      setDismissingId(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* Header strip */}
      <div className="rounded-lg border bg-card p-4 flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground">Open insights</p>
          <p className="text-2xl font-semibold">{open.length}</p>
        </div>
        <Button size="sm" variant="outline" disabled={mining} onClick={handleMine} className="gap-1.5">
          {mining ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Run mining now
        </Button>
      </div>

      {/* Open insights */}
      <div className="rounded-lg border bg-card">
        <div className="p-3 border-b">
          <p className="text-sm font-semibold">Open</p>
        </div>
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground p-6 text-center">
            No open patterns yet. Click <strong>Run mining now</strong> to score your brokerage&apos;s current data — the cron also runs weekly.
          </p>
        ) : (
          <ul className="divide-y">
            {open.map((i) => {
              const isExpanded = expanded === i.id
              const selectedSet = selectedAgents[i.id] ?? new Set<string>()
              return (
                <li key={i.id} className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className={cn("text-[10px] uppercase px-1.5 py-0.5 rounded-full font-medium", SEVERITY_BG[i.severity])}>
                          {i.severity}
                        </span>
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase font-medium px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                          <Sparkles className="h-2.5 w-2.5" /> {Math.round(i.liftPct)}% lift
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {PATTERN_LABEL[i.patternKey] ?? i.patternKey}
                        </span>
                      </div>
                      <p className="text-sm font-medium leading-snug">{i.headline}</p>

                      <div className="grid grid-cols-3 gap-3 mt-2 text-[11px]">
                        <div>
                          <p className="text-muted-foreground uppercase">Top quartile</p>
                          <p className="font-medium">{formatMetric(i.metricLabel, i.topQuartileValue)}</p>
                          {i.outcomeLabel && i.topQuartileOutcome != null && (
                            <p className="text-[10px] text-emerald-700">
                              {formatMetric(i.outcomeLabel, i.topQuartileOutcome)}
                            </p>
                          )}
                        </div>
                        <div>
                          <p className="text-muted-foreground uppercase">Median</p>
                          <p>{formatMetric(i.metricLabel, i.medianValue)}</p>
                          {i.outcomeLabel && i.medianOutcome != null && (
                            <p className="text-[10px] text-muted-foreground">
                              {formatMetric(i.outcomeLabel, i.medianOutcome)}
                            </p>
                          )}
                        </div>
                        <div>
                          <p className="text-muted-foreground uppercase">Bottom quartile</p>
                          <p>{formatMetric(i.metricLabel, i.bottomQuartileValue)}</p>
                          {i.outcomeLabel && i.bottomQuartileOutcome != null && (
                            <p className="text-[10px] text-red-700">
                              {formatMetric(i.outcomeLabel, i.bottomQuartileOutcome)}
                            </p>
                          )}
                        </div>
                      </div>

                      {i.playbook && (
                        <p className="text-[11px] text-foreground mt-2 italic">&ldquo;{i.playbook}&rdquo;</p>
                      )}
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {i.supportingAgentCount} top-quartile agent{i.supportingAgentCount === 1 ? "" : "s"} · {i.sampleSize} observations · mined {new Date(i.computedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1"
                        onClick={() => setExpanded(isExpanded ? null : i.id)}
                      >
                        {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        Adopt
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs gap-1 text-muted-foreground"
                        disabled={dismissingId === i.id}
                        onClick={() => handleDismiss(i)}
                      >
                        {dismissingId === i.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                        Dismiss
                      </Button>
                    </div>
                  </div>

                  {/* Expand panel: agent picker + playbook actions */}
                  {isExpanded && (
                    <div className="rounded-md border bg-muted/20 p-3 space-y-2 mt-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold">Apply playbook to selected agents</p>
                        <div className="flex items-center gap-2 text-[11px]">
                          <button onClick={() => selectAll(i.id)} className="text-violet-700 hover:underline">Select all ({agents.length})</button>
                          <button onClick={() => clearSelected(i.id)} className="text-muted-foreground hover:underline">Clear</button>
                        </div>
                      </div>
                      <div className="max-h-48 overflow-y-auto grid grid-cols-2 gap-1.5">
                        {agents.length === 0 ? (
                          <p className="text-xs text-muted-foreground col-span-2">No agents in this brokerage.</p>
                        ) : (
                          agents.map((a) => {
                            const selected = selectedSet.has(a.id)
                            return (
                              <label
                                key={a.id}
                                className={cn(
                                  "flex items-center gap-1.5 text-xs px-2 py-1 rounded-md cursor-pointer border",
                                  selected ? "bg-violet-100 border-violet-300" : "bg-white border-input"
                                )}
                              >
                                <input
                                  type="checkbox"
                                  className="h-3 w-3"
                                  checked={selected}
                                  onChange={() => toggleAgent(i.id, a.id)}
                                />
                                {a.name}
                              </label>
                            )
                          })
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        <p className="font-medium mb-1">Actions that will be applied:</p>
                        <ul className="list-disc list-inside space-y-0.5">
                          {i.playbookActions.length === 0 ? (
                            <li>(none configured)</li>
                          ) : (
                            i.playbookActions.map((act, idx) => (
                              <li key={idx}><code className="bg-muted px-1 py-0.5 rounded">{act.type}</code></li>
                            ))
                          )}
                        </ul>
                      </div>
                      <div className="flex items-center justify-end gap-2">
                        <p className="text-[11px] text-muted-foreground mr-auto">
                          {selectedSet.size > 0
                            ? `${selectedSet.size} of ${agents.length} agents selected`
                            : `No agents selected — Adopt will broadcast to all ${agents.length}`}
                        </p>
                        <Button
                          size="sm"
                          variant="default"
                          className="h-7 text-xs gap-1"
                          disabled={adoptingId === i.id}
                          onClick={() => handleAdopt(i)}
                        >
                          {adoptingId === i.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCheck className="h-3 w-3" />}
                          Adopt playbook
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Recently dismissed */}
      {dismissed.length > 0 && (
        <details className="rounded-lg border bg-card">
          <summary className="p-3 border-b cursor-pointer text-sm font-semibold flex items-center gap-1.5">
            <Users className="h-4 w-4 text-muted-foreground" />
            Recently dismissed · {dismissed.length}
          </summary>
          <ul className="divide-y">
            {dismissed.map((i) => (
              <li key={i.id} className="p-3 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-muted-foreground">{PATTERN_LABEL[i.patternKey] ?? i.patternKey}:</span>
                  <span className="font-medium">{i.headline}</span>
                </div>
                {/* WHO WAVED IT AWAY, AND ON WHAT GROUNDS. All three were written
                    by dismissInsightAction and read by nothing, so this list could
                    say a brokerage-wide pattern had been dismissed without naming
                    the decision — which is exactly what a second reviewer needs
                    before reopening it. */}
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {i.dismissedByName ? `dismissed by ${i.dismissedByName}` : "dismissed"}
                  {i.dismissedAt ? ` · ${new Date(i.dismissedAt).toLocaleDateString()}` : ""}
                  {i.dismissalReason ? ` — ${i.dismissalReason}` : " — no reason recorded"}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
