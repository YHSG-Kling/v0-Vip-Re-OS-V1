"use client"

/**
 * SYSTEM GATES + THE STAGE AUDIT TRAIL.
 *
 * The lifecycle defines nine SYSTEM GATES — named capabilities a listing unlocks by
 * reaching a stage (marketing_execution, offers_system, seller_showings, …). Four
 * complete, exported, caller-less actions describe them and the listing's history:
 *
 *   getLifecycleStages           the stage catalogue, and which stage opens which gate
 *   getEnabledGates              the gates THIS listing's stage has opened
 *   checkSystemGate              a single named gate, re-asked of the server
 *   getListingLifecycleHistory   every stage transition recorded, including refusals
 *
 * The stage pipeline in the left rail already draws grey/green gate chips, but it
 * derives them CLIENT-SIDE from the static stage table. That tells you what the
 * rulebook says a stage unlocks. It cannot tell you what the SERVER thinks is open
 * for this listing right now — and until this pass those two disagreed for every
 * listing in the system, because the server resolved the current stage from an
 * `activities` row nothing has ever written and therefore answered "no lifecycle
 * stage" for a listing plainly sitting at MLS_ACTIVE.
 *
 * This panel asks the server. Every verdict on screen came back from the action
 * named beside it; a gate whose stage could not be READ renders as unknown, never
 * as closed and never as open.
 */

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Loader2,
  LockKeyhole,
  LockKeyholeOpen,
  TriangleAlert,
  History,
  CircleHelp,
  ChevronDown,
  ChevronUp,
} from "lucide-react"
import {
  getEnabledGates,
  checkSystemGate,
  getLifecycleStages,
  getListingLifecycleHistory,
} from "@/app/actions/listing-lifecycle-core"

interface Props {
  listingId: string
}

type GateCatalogueEntry = { gate: string; openedByStage: string; openedByLabel: string }

type HistoryRow = {
  id: string
  timestamp: string
  fromStage: string | null
  toStage: string | null
  isOverride: boolean
  notes: string | null
  failed: boolean
}

const pretty = (s: string) => s.replace(/_/g, " ")

export function ListingGatesPanel({ listingId }: Props) {
  const [, startTransition] = useTransition()
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const [currentStage, setCurrentStage] = useState<string | null>(null)
  const [enabled, setEnabled] = useState<string[] | null>(null)
  const [catalogue, setCatalogue] = useState<GateCatalogueEntry[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])

  const [gatesError, setGatesError] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const [recheck, setRecheck] = useState<Record<string, string>>({})
  const [rechecking, setRechecking] = useState<string | null>(null)

  useEffect(() => {
    if (!expanded || loaded || loading) return
    let cancelled = false
    setLoading(true)
    setGatesError(null)
    setHistoryError(null)

    Promise.all([
      getLifecycleStages(),
      getEnabledGates(listingId),
      getListingLifecycleHistory(listingId),
    ])
      .then(([stagesRes, gatesRes, historyRes]) => {
        if (cancelled) return

        // ── the catalogue: which stage opens which gate ──────────────────────
        // getLifecycleStages already returns StageDefinition[]. Casting it down to
        // Record<string, unknown>[] does not typecheck (StageDefinition has no index
        // signature) and would throw away the field names anyway — use the type the
        // action actually returns.
        const stages = stagesRes.stages ?? []
        const entries: GateCatalogueEntry[] = []
        for (const s of stages) {
          for (const g of s.enablesSystemGates ?? []) {
            entries.push({
              gate: g,
              openedByStage: s.stage,
              openedByLabel: s.label ?? s.stage,
            })
          }
        }
        setCatalogue(entries)

        // ── what the SERVER says is open for this listing ────────────────────
        const g = gatesRes as {
          success: boolean
          error?: string
          currentStage?: string | null
          enabledGates?: string[]
          reason?: string
        }
        if (!g.success) {
          // A gate read that could not RUN is not "no gates open". Say which.
          setGatesError(g.error ?? "The system gates could not be read.")
          setEnabled(null)
        } else {
          setEnabled(g.enabledGates ?? [])
          setCurrentStage(g.currentStage ?? null)
          if (g.reason) setGatesError(null)
        }

        // ── the audit trail ──────────────────────────────────────────────────
        const h = historyRes as {
          success: boolean
          error?: string
          history?: HistoryRow[]
          currentStage?: string | null
        }
        if (!h.success) {
          setHistoryError(h.error ?? "The stage history could not be read.")
        } else {
          setHistory(h.history ?? [])
          if (h.currentStage && !g.success) setCurrentStage(h.currentStage)
        }

        setLoaded(true)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : "Lifecycle governance could not be loaded."
        setGatesError(msg)
        setHistoryError(msg)
        setLoaded(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [expanded, loaded, loading, listingId])

  function reask(gate: string) {
    setRechecking(gate)
    startTransition(async () => {
      try {
        const res = (await checkSystemGate({ listingId, gateName: gate })) as {
          success: boolean
          error?: string
          enabled?: boolean
          currentStage?: string | null
          reason?: string
        }
        setRecheck((prev) => ({
          ...prev,
          [gate]: !res.success
            ? `could not be checked — ${res.error ?? "unknown error"}`
            : res.enabled
              ? `open at ${res.currentStage ?? "this stage"}`
              : `closed${res.reason ? ` — ${res.reason}` : ` at ${res.currentStage ?? "this stage"}`}`,
        }))
      } finally {
        setRechecking(null)
      }
    })
  }

  // Unique gate names, in lifecycle order.
  const gateNames = catalogue
    .map((c) => c.gate)
    .filter((g, i, arr) => arr.indexOf(g) === i)

  const openCount = enabled?.length ?? 0

  return (
    <Card className="mb-6">
      <CardHeader className="pb-2 cursor-pointer select-none" onClick={() => setExpanded((v) => !v)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <LockKeyholeOpen className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm">Lifecycle gates &amp; history</CardTitle>
            {loaded && enabled !== null && (
              <Badge variant="secondary" className="text-xs">
                {openCount} of {gateNames.length} open
              </Badge>
            )}
            {loaded && (gatesError || historyError) && (
              <Badge variant="outline" className="text-xs border-red-300 text-red-700">
                unreadable
              </Badge>
            )}
          </div>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        {!expanded && (
          <CardDescription className="text-xs mt-0.5">
            Which capabilities this listing&apos;s stage has unlocked, and every stage change on record.
          </CardDescription>
        )}
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0 space-y-6">
          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Asking the server…</span>
            </div>
          )}

          {!loading && (
            <>
              {/* ── SYSTEM GATES ──────────────────────────────────────────── */}
              <section className="space-y-3">
                <div>
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    <LockKeyhole className="h-4 w-4" />
                    System gates
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {currentStage
                      ? `Resolved against this listing's current stage — ${pretty(currentStage)}.`
                      : "This listing has no lifecycle stage on record yet."}
                  </p>
                </div>

                {gatesError && (
                  <p className="text-xs text-red-700 border border-red-200 bg-red-50 rounded px-3 py-2 flex items-start gap-1.5">
                    <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-px" />
                    <span>
                      {gatesError} — treat every gate below as UNKNOWN rather than closed.
                    </span>
                  </p>
                )}

                <ul className="space-y-1.5">
                  {gateNames.map((gate) => {
                    const opensAt = catalogue.find((c) => c.gate === gate)
                    const isOpen = enabled === null ? null : enabled.includes(gate)
                    return (
                      <li
                        key={gate}
                        className="flex items-center justify-between gap-3 rounded border px-3 py-2 text-xs"
                      >
                        <div className="min-w-0">
                          <p className="font-medium capitalize flex items-center gap-1.5">
                            {isOpen === null ? (
                              <CircleHelp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            ) : isOpen ? (
                              <LockKeyholeOpen className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                            ) : (
                              <LockKeyhole className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            )}
                            {pretty(gate)}
                          </p>
                          <p className="text-muted-foreground mt-0.5">
                            {isOpen
                              ? "Open."
                              : isOpen === null
                                ? "Unknown — the stage could not be read."
                                : `Opens at ${opensAt?.openedByLabel ?? "a later stage"}.`}
                            {recheck[gate] && <span className="ml-1 italic">Re-checked: {recheck[gate]}</span>}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-[11px] shrink-0"
                          onClick={() => reask(gate)}
                          disabled={rechecking === gate}
                        >
                          {rechecking === gate && <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />}
                          Re-check
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              </section>

              {/* ── STAGE HISTORY ─────────────────────────────────────────── */}
              <section className="space-y-3 border-t pt-5">
                <div>
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    <History className="h-4 w-4" />
                    Stage history
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Every recorded stage change on this listing, including attempts the engine refused.
                  </p>
                </div>

                {historyError && (
                  <p className="text-xs text-red-700 border border-red-200 bg-red-50 rounded px-3 py-2 flex items-start gap-1.5">
                    <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-px" />
                    <span>
                      {historyError} — this is a FAILED READ, not an empty history. Do not read it as
                      &ldquo;nothing has happened&rdquo;.
                    </span>
                  </p>
                )}

                {!historyError && history.length === 0 && (
                  <p className="text-xs text-muted-foreground border rounded px-3 py-2 bg-muted/30">
                    No stage changes recorded for this listing yet.
                  </p>
                )}

                {history.length > 0 && (
                  <ul className="space-y-1.5">
                    {history.map((h) => (
                      <li key={h.id} className="rounded border px-3 py-2 text-xs">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">
                            {h.fromStage ? `${pretty(h.fromStage)} → ` : ""}
                            {h.toStage ? pretty(h.toStage) : "unknown"}
                          </span>
                          {h.failed && (
                            <Badge variant="outline" className="border-red-300 text-red-700 text-[10px]">
                              refused
                            </Badge>
                          )}
                          {h.isOverride && (
                            <Badge variant="outline" className="border-amber-300 text-amber-700 text-[10px]">
                              override
                            </Badge>
                          )}
                          <span className="text-muted-foreground ml-auto">
                            {new Date(h.timestamp).toLocaleString()}
                          </span>
                        </div>
                        {h.notes && <p className="text-muted-foreground mt-1">{h.notes}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}
