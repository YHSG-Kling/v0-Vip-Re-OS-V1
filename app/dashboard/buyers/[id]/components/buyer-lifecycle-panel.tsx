"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { useToast } from "@/hooks/use-toast"
import { Button } from "@/components/ui/button"
import {
  getCurrentBuyerState,
  getBuyerLifecycleHistory,
  getNextAllowedBuyerStates,
  canBuyerSearchProperties,
  executeBuyerStateTransition,
} from "@/app/actions/buyer-lifecycle-core"
import { getStateDefinition, getStateIndex, BUYER_LIFECYCLE_STATES } from "@/lib/buyer-lifecycle/lifecycle-definitions"
import type { BuyerState } from "@/lib/buyer-lifecycle/lifecycle-definitions"
import type { LifecycleHistoryEntry } from "@/lib/buyer-lifecycle/lifecycle-logger"
import type { GatingResult } from "@/lib/buyer-lifecycle"
import { CheckCircle2, Circle, Loader2, AlertTriangle, ChevronRight, Clock } from "lucide-react"

// ─── PIPELINE STAGES ────────────────────────────────────────────────────────
// The 7 milestone states shown in the visual pipeline (linear path only)
const PIPELINE_STAGES: BuyerState[] = [
  "BUYER_CONTACT_CREATED",
  "BUYER_FINANCIALLY_VERIFIED",
  "BUYER_SEARCHING",
  "BUYER_TOURING",
  "BUYER_OFFER_SUBMITTED",
  "BUYER_UNDER_CONTRACT",
  "BUYER_CLOSED",
  "BUYER_LIFETIME",
]

// Human-readable labels for next-step action buttons
const TRANSITION_BUTTON_LABELS: Partial<Record<BuyerState, string>> = {
  BUYER_FINANCIALLY_VERIFIED: "Mark Financially Verified",
  BUYER_SEARCH_CONFIGURED:    "Configure Search",
  BUYER_SEARCHING:            "Start Active Search",
  BUYER_TOUR_ELIGIBLE:        "Mark Tour Eligible",
  BUYER_TOURING:              "Begin Touring Phase",
  BUYER_OFFER_ELIGIBLE:       "Mark Offer Eligible",
  BUYER_OFFER_SUBMITTED:      "Record Offer Submitted",
  BUYER_UNDER_CONTRACT:       "Mark Under Contract",
  BUYER_ON_HOLD:              "Place On Hold",
  BUYER_DISENGAGED:           "Mark Disengaged",
  BUYER_CLOSED:               "Mark Closed",
  BUYER_LIFETIME:             "Move to Lifetime Customer",
}

function daysSince(date: Date | string): number {
  return Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000)
}

// ─── PROPS ───────────────────────────────────────────────────────────────────

interface BuyerLifecyclePanelProps {
  contactId:   string
  agentId:     string   // maps to agentUserId from parent
  brokerageId: string
  userRole:    string
}

// ─── TRANSITION SHEET ────────────────────────────────────────────────────────

interface TransitionSheetProps {
  toState:      BuyerState
  fromState:    BuyerState | null
  canOverride:  boolean
  onConfirm:    (notes: string, overrideReason?: string) => Promise<void>
  onClose:      () => void
  transitioning: boolean
}

function TransitionSheet({ toState, fromState, canOverride, onConfirm, onClose, transitioning }: TransitionSheetProps) {
  const [notes, setNotes] = useState("")
  const [showOverride, setShowOverride] = useState(false)
  const [overrideReason, setOverrideReason] = useState("")
  const def = getStateDefinition(toState)

  const overrideArmed = showOverride && overrideReason.trim().length >= 10
  const overrideTooShort = showOverride && overrideReason.trim().length > 0 && overrideReason.trim().length < 10

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-border bg-card shadow-xl p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Advance to {def?.label ?? toState}</h2>
          {fromState && (
            <p className="text-sm text-muted-foreground mt-0.5">
              From {getStateDefinition(fromState)?.label ?? fromState}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Notes (optional)</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Add context for this transition…"
            rows={3}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </div>

        {/* Manual override — only visible to broker / admin / compliance.
            The server (validateStateTransition) also enforces user_type; this
            is UX only. Required for moving past gates like financial
            verification when broker has verbal confirmation. */}
        {canOverride && (
          <div className="border-t pt-3 space-y-2">
            <button
              type="button"
              onClick={() => setShowOverride((s) => !s)}
              className="text-xs text-amber-700 hover:underline flex items-center gap-1.5"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              </svg>
              {showOverride ? "Cancel override" : "Force advance with override"}
            </button>
            {showOverride && (
              <>
                <label className="text-xs font-medium text-amber-700">
                  Override reason (required, min 10 characters)
                </label>
                <textarea
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="e.g. Buyer financial verification confirmed by phone with lender — documentation in transit"
                  rows={2}
                  className="w-full resize-none rounded-md border border-amber-300 bg-amber-50/40 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                />
                {overrideTooShort && (
                  <p className="text-[11px] text-red-600">Reason must be at least 10 characters.</p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Logged as <code className="text-[10px]">buyer.lifecycle_overridden</code> with your
                  user id + user_type for compliance audit.
                </p>
              </>
            )}
          </div>
        )}

        <div className="flex gap-3 pt-1">
          <Button
            className={overrideArmed ? "flex-1 bg-amber-600 hover:bg-amber-700 text-white" : "flex-1"}
            onClick={() => onConfirm(notes, overrideArmed ? overrideReason.trim() : undefined)}
            disabled={transitioning || (showOverride && !overrideArmed)}
          >
            {transitioning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {overrideArmed ? "Force Advance" : "Confirm"}
          </Button>
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={transitioning}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export function BuyerLifecyclePanel({ contactId, agentId, brokerageId, userRole }: BuyerLifecyclePanelProps) {
  const { toast } = useToast()

  const [currentState,    setCurrentState]    = useState<BuyerState | null>(null)
  const [history,         setHistory]         = useState<LifecycleHistoryEntry[]>([])
  const [nextStates,      setNextStates]      = useState<BuyerState[]>([])
  const [canSearch,       setCanSearch]       = useState<GatingResult | null>(null)
  const [loading,         setLoading]         = useState(true)
  const [transitioning,   setTransitioning]   = useState(false)
  const [selectedNext,    setSelectedNext]    = useState<BuyerState | null>(null)
  const [stateEnteredAt,  setStateEnteredAt]  = useState<Date | null>(null)

  // ── Load all data in parallel on mount ──────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      const [state, hist, nexts, gating] = await Promise.all([
        getCurrentBuyerState(contactId),
        getBuyerLifecycleHistory({ contactId, limit: 10 }),
        getNextAllowedBuyerStates({ contactId, userRole }),
        canBuyerSearchProperties(contactId),
      ])
      if (cancelled) return
      setCurrentState(state)
      setHistory(hist)
      setNextStates(nexts)
      setCanSearch(gating)
      // Derive when this state was entered from the most recent history entry
      if (hist.length > 0) setStateEnteredAt(hist[0].occurredAt)
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [contactId, userRole])

  // ── Refresh after a transition ───────────────────────────────────────────
  async function refresh() {
    const [state, hist, nexts, gating] = await Promise.all([
      getCurrentBuyerState(contactId),
      getBuyerLifecycleHistory({ contactId, limit: 10 }),
      getNextAllowedBuyerStates({ contactId, userRole }),
      canBuyerSearchProperties(contactId),
    ])
    setCurrentState(state)
    setHistory(hist)
    setNextStates(nexts)
    setCanSearch(gating)
    if (hist.length > 0) setStateEnteredAt(hist[0].occurredAt)
  }

  // ── Execute transition ───────────────────────────────────────────────────
  async function handleTransition(notes: string, overrideReason?: string) {
    if (!selectedNext) return
    setTransitioning(true)
    const result = await executeBuyerStateTransition({
      contactId,
      fromState:     currentState,
      toState:       selectedNext,
      triggeredBy:   "agent",
      authorityRole: userRole,
      userId:        agentId,
      sourceSystem:  "buyer-lifecycle-panel",
      brokerageId,
      overrideReason,  // server validates user_type + min length when present
      metadata:      notes.trim() ? { notes } : undefined,
    })
    setTransitioning(false)
    setSelectedNext(null)
    if (result.success) {
      const label = getStateDefinition(selectedNext)?.label ?? selectedNext
      toast({
        title: overrideReason
          ? `Buyer advanced to ${label} (overridden)`
          : `Buyer advanced to ${label}`,
      })
      await refresh()
    } else {
      toast({ title: "Transition failed", description: result.error, variant: "destructive" })
    }
  }

  // UI gate mirrors the server-side requireOverrideActor set. Server is the
  // real boundary — hiding this from a regular agent is UX only.
  const OVERRIDE_USER_TYPES = new Set([
    "broker", "broker_admin", "admin", "superadmin",
    "compliance_officer", "compliance_manager",
  ])
  const canOverrideLifecycle = OVERRIDE_USER_TYPES.has(userRole?.toLowerCase?.() ?? "")

  // ─── LOADING ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const currentDef    = currentState ? getStateDefinition(currentState) : null
  const currentIndex  = currentState ? getStateIndex(currentState) : -1
  const daysInStage   = stateEnteredAt ? daysSince(stateEnteredAt) : null

  // ─── RENDER ─────────────────────────────────────────────────────────────
  return (
    <>
      {selectedNext && (
        <TransitionSheet
          toState={selectedNext}
          fromState={currentState}
          canOverride={canOverrideLifecycle}
          onConfirm={handleTransition}
          onClose={() => setSelectedNext(null)}
          transitioning={transitioning}
        />
      )}

      <div className="space-y-6 py-2">

        {/* ═══ STATE PIPELINE ═══════════════════════════════════════════════ */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h3 className="text-sm font-semibold">Buyer Journey Pipeline</h3>

          {/* Horizontal step row */}
          <div className="flex items-center overflow-x-auto gap-0 pb-1">
            {PIPELINE_STAGES.map((stage, i) => {
              const def          = getStateDefinition(stage)
              const stageIndex   = getStateIndex(stage)
              const isPast       = stageIndex < currentIndex
              const isCurrent    = stage === currentState
              const isFuture     = stageIndex > currentIndex
              const isLast       = i === PIPELINE_STAGES.length - 1

              return (
                <div key={stage} className="flex items-center flex-shrink-0">
                  <div className="flex flex-col items-center gap-1.5">
                    {/* Circle */}
                    <div className={cn(
                      "flex items-center justify-center rounded-full border-2 transition-all",
                      isPast    && "w-7 h-7 border-green-500 bg-green-500",
                      isCurrent && "w-8 h-8 border-primary bg-primary ring-4 ring-primary/20",
                      isFuture  && "w-7 h-7 border-muted-foreground/30 bg-background",
                    )}>
                      {isPast    && <CheckCircle2 className="h-4 w-4 text-white" />}
                      {isCurrent && <Circle className="h-3 w-3 text-primary-foreground fill-primary-foreground animate-pulse" />}
                      {isFuture  && <Circle className="h-3 w-3 text-muted-foreground/30" />}
                    </div>
                    {/* Label */}
                    <span className={cn(
                      "text-[10px] text-center leading-tight max-w-[64px]",
                      isCurrent ? "font-bold text-foreground" : "text-muted-foreground",
                    )}>
                      {def?.label ?? stage.replace("BUYER_", "").replace(/_/g, " ")}
                    </span>
                  </div>
                  {/* Connector */}
                  {!isLast && (
                    <div className={cn(
                      "h-px w-8 flex-shrink-0 mx-1 mt-[-14px]",
                      isPast ? "bg-green-400" : "bg-muted-foreground/20",
                    )} />
                  )}
                </div>
              )
            })}
          </div>

          {/* Current state badge */}
          {currentDef && (
            <div className="flex items-center gap-3 pt-1">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                Currently: {currentDef.label}
              </span>
              {daysInStage !== null && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  {daysInStage} {daysInStage === 1 ? "day" : "days"} in this stage
                </span>
              )}
            </div>
          )}
        </section>

        {/* ═══ NEXT STEPS ═══════════════════════════════════════════════════ */}
        {nextStates.length > 0 && (
          <section className="rounded-lg border border-border bg-card p-5 space-y-3">
            <h3 className="text-sm font-semibold">What happens next</h3>
            <div className="space-y-2">
              {nextStates.map(state => {
                const def   = getStateDefinition(state)
                const label = TRANSITION_BUTTON_LABELS[state] ?? `Advance to ${def?.label ?? state}`
                const isLifetime = state === "BUYER_LIFETIME"

                return (
                  <div
                    key={state}
                    className={cn(
                      "flex items-center justify-between rounded-lg border p-3",
                      isLifetime
                        ? "border-amber-200 bg-amber-50"
                        : "border-border bg-muted/30",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {def?.label ?? state.replace("BUYER_", "").replace(/_/g, " ")}
                      </p>
                      {def?.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                          {def.description}
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant={isLifetime ? "default" : "outline"}
                      className={cn(
                        "ml-3 flex-shrink-0 gap-1",
                        isLifetime && "bg-amber-500 hover:bg-amber-600 text-white border-transparent",
                      )}
                      onClick={() => setSelectedNext(state)}
                    >
                      {label}
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* ═══ PROPERTY SEARCH ACCESS ═══════════════════════════════════════ */}
        {canSearch && (
          <section>
            {canSearch.allowed ? (
              <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3">
                <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
                <span className="text-sm font-medium text-green-800">Buyer can search properties</span>
              </div>
            ) : (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-1.5">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0" />
                  <p className="text-sm font-semibold text-amber-900">Property search restricted</p>
                </div>
                {!!canSearch.reason && (
                  <p className="text-sm text-amber-800 pl-6">{canSearch.reason}</p>
                )}
                {"requiredStep" in canSearch && !!canSearch.requiredStep && (
                  <p className="text-xs text-amber-700 pl-6">
                    Complete <span className="font-medium">{String(canSearch.requiredStep)}</span> first
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {/* ═══ LIFECYCLE HISTORY TIMELINE ═══════════════════════════════════ */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-3">
          <h3 className="text-sm font-semibold">Transition History</h3>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transitions recorded yet.</p>
          ) : (
            <div className="space-y-0 divide-y divide-border">
              {history.map((entry, i) => {
                const fromDef = entry.fromState ? getStateDefinition(entry.fromState) : null
                const toDef   = getStateDefinition(entry.toState)
                const daysAgo = daysSince(entry.occurredAt)

                return (
                  <div key={entry.id ?? i} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-col items-center">
                      <div className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                      {i < history.length - 1 && (
                        <div className="w-px flex-1 bg-border mt-1" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 pb-1">
                      <p className="text-sm">
                        {fromDef
                          ? <><span className="text-muted-foreground">{fromDef.label}</span>{" → "}<span className="font-medium">{toDef?.label ?? entry.toState}</span></>
                          : <span className="font-medium">{toDef?.label ?? entry.toState}</span>
                        }
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {daysAgo === 0 ? "Today" : `${daysAgo} ${daysAgo === 1 ? "day" : "days"} ago`}
                        {" · "}by {entry.triggeredBy === "agent" ? "agent" : entry.triggeredBy}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

      </div>
    </>
  )
}
