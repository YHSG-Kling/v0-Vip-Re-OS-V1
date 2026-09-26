"use client"

import { useEffect, useState, useTransition } from "react"
import { Check, Star, ChevronRight, Loader2, Eye, EyeOff, ShieldAlert } from "lucide-react"
import { cn } from "@/lib/utils"
import type { StageDefinition, ListingStage } from "@/lib/listing-lifecycle/lifecycle-definitions"
import { advanceListingStage, setMilestonePortalVisibility } from "@/app/actions/listing-lifecycle"
import { getListingNextStages } from "@/app/actions/listing-lifecycle-core"
import { StageAdvanceModal } from "./stage-advance-modal"

const MILESTONE_STAGES = new Set([
  "LISTING_AGREEMENT_SIGNED",
  "MLS_ACTIVE",
  "UNDER_CONTRACT",
  "CLOSED",
  "LIFETIME_CUSTOMER",
])

interface LifecycleEvent {
  id: string
  event_type: string
  metadata: Record<string, any> | null
  actor_user_id: string | null
  created_at: string
}

interface Props {
  listingId: string
  currentStage: ListingStage
  completedStages: Set<string>
  validNextStages: string[]
  allStages: StageDefinition[]
  enabledGates: string[]
  lifecycleEvents: LifecycleEvent[]
  canOverride: boolean
  userId: string
  brokerageId: string
}

export function StagePipeline({
  listingId,
  currentStage,
  completedStages,
  validNextStages,
  allStages,
  enabledGates,
  lifecycleEvents,
  canOverride,
  userId,
  brokerageId,
}: Props) {
  const [selectedStage, setSelectedStage] = useState<StageDefinition | null>(null)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // ── WHAT THIS CALLER MAY ACTUALLY DO ────────────────────────────────────────
  //
  // `validNextStages` arrives from the page computed purely from the stage graph:
  //
  //   allStages.filter(s => s.allowedFrom.includes(currentStage))
  //
  // with NO role filter. Every user is therefore offered every structurally
  // reachable stage, whatever their authority — the pipeline lights a stage amber,
  // the agent clicks it, and the server refuses on role. getListingNextStages
  // returns the same list intersected with the caller's REAL authority, using the
  // normalised role (so a broker_owner / superadmin gets their full set instead of
  // the empty set their raw user_type produced against the engine's four-role
  // vocabulary).
  //
  // Until it answers, the page's unfiltered list stands — narrowing the UI on a
  // read that has not returned would hide stages the user can legitimately reach.
  // If the read FAILS we keep the unfiltered list and say so, rather than
  // presenting an empty pipeline as though nothing were permitted.
  const [authorizedNextStages, setAuthorizedNextStages] = useState<string[] | null>(null)
  const [authorityNote, setAuthorityNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getListingNextStages(listingId)
      .then((res) => {
        if (cancelled) return
        const r = res as {
          success: boolean
          error?: string
          nextStages?: string[]
          unauthorizedReason?: string
        }
        if (!r.success) {
          setAuthorityNote(
            `Your stage authority could not be confirmed (${r.error ?? "unknown error"}) — the list below is unfiltered and the server may still refuse.`,
          )
          return
        }
        setAuthorizedNextStages(r.nextStages ?? [])
        if (r.unauthorizedReason) setAuthorityNote(r.unauthorizedReason)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setAuthorityNote(
          `Your stage authority could not be confirmed (${e instanceof Error ? e.message : "unknown error"}) — the list below is unfiltered.`,
        )
      })
    return () => {
      cancelled = true
    }
  }, [listingId, currentStage])

  // Intersect: a stage must be BOTH structurally reachable and within authority.
  const effectiveNextStages =
    authorizedNextStages === null
      ? validNextStages
      : validNextStages.filter((s) => authorizedNextStages.includes(s))

  // Portal visibility state per milestone stage
  // Derived from the most recent lifecycle event for each milestone stage
  const [portalVisibility, setPortalVisibility] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {}
    for (const stage of MILESTONE_STAGES) {
      const events = lifecycleEvents
        .filter(e => e.metadata?.to_state === stage)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      if (events.length > 0) {
        map[stage] = events[0].metadata?.portal_visible === true
      }
    }
    return map
  })
  const [togglingStage, setTogglingStage] = useState<string | null>(null)

  async function handlePortalToggle(stage: string) {
    const newVisible = !portalVisibility[stage]
    setTogglingStage(stage)
    setError(null)
    const result = await setMilestonePortalVisibility(listingId, stage, newVisible)
    if (result.success) {
      setPortalVisibility((prev: Record<string, boolean>) => ({ ...prev, [stage]: newVisible }))
    } else {
      // The refusal used to be dropped on the floor: the switch snapped back and
      // the agent was told nothing, so a milestone that never became visible to
      // the client looked like a UI glitch rather than a server verdict. Show
      // what the server actually said.
      setError(result.error ?? "Could not change portal visibility for this milestone")
    }
    setTogglingStage(null)
  }

  function handleStageClick(stage: StageDefinition) {
    if (!effectiveNextStages.includes(stage.stage)) return
    setSelectedStage(stage)
    setError(null)
  }

  function handleConfirm(notes: string, isOverride: boolean, overrideReason: string) {
    if (!selectedStage) return
    setError(null)
    startTransition(async () => {
      try {
        // When override toggled on, pass the reason through. The server
        // action validates the user_type via requireOverrideActor and writes
        // a 'listing.stage_overridden' lifecycle_event audit row.
        const res = await advanceListingStage(
          listingId,
          selectedStage.stage,
          userId,
          notes || undefined,
          isOverride && overrideReason ? overrideReason : undefined,
        )
        // READ THE OUTCOME. This used to `await` and discard: a service that
        // reports a refusal by returning { success:false } (rather than throwing)
        // closed the modal and looked exactly like a successful advance.
        if (res && typeof res === "object" && "success" in res && (res as { success?: boolean }).success === false) {
          setError((res as { error?: string }).error ?? "The stage was not advanced")
          return
        }
        setSelectedStage(null)
        // Page will revalidate via server action
      } catch (e: any) {
        setError(e?.message ?? "Failed to advance stage")
      }
    })
  }

  // Build a map of stage → transition events for history rows
  const stageHistoryMap: Record<string, LifecycleEvent[]> = {}
  for (const evt of lifecycleEvents) {
    const toState = evt.metadata?.to_state as string | undefined
    if (toState) {
      if (!stageHistoryMap[toState]) stageHistoryMap[toState] = []
      stageHistoryMap[toState].push(evt)
    }
  }

  return (
    <>
      <div className="p-4 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground">Stage Pipeline</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{allStages.length} stages</p>
      </div>

      {error && (
        <div className="mx-3 mt-3 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* The server's word on this caller's authority. Rendered whenever the
          engine has no seat for their role, or the authority read itself failed —
          so a pipeline with nothing clickable always explains WHY rather than
          just looking inert. */}
      {authorityNote && (
        <div className="mx-3 mt-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900 flex items-start gap-1.5">
          <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>{authorityNote}</span>
        </div>
      )}

      {!authorityNote &&
        authorizedNextStages !== null &&
        validNextStages.length > 0 &&
        effectiveNextStages.length === 0 && (
          <div className="mx-3 mt-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900 flex items-start gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>
              This listing can move on from here, but not by you — the next stages require a higher
              role. Ask a broker or admin to advance it.
            </span>
          </div>
        )}

      <ol className="p-3 space-y-1">
        {allStages.map((stage) => {
          const isCompleted = completedStages.has(stage.stage)
          const isCurrent = stage.stage === currentStage
          const isValidNext = effectiveNextStages.includes(stage.stage)
          const isMilestone = MILESTONE_STAGES.has(stage.stage)
          const historyEvents = stageHistoryMap[stage.stage] ?? []

          return (
            <li key={stage.stage}>
              {/* Stage row */}
              <button
                type="button"
                disabled={!isValidNext || isPending}
                onClick={() => handleStageClick(stage)}
                className={cn(
                  "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors text-xs",
                  isCurrent && "bg-blue-50 text-blue-900 ring-1 ring-blue-200",
                  isCompleted && !isCurrent && "text-muted-foreground",
                  isValidNext && !isCurrent && "hover:bg-amber-50 cursor-pointer text-amber-900",
                  !isCompleted && !isCurrent && !isValidNext && "text-muted-foreground/50 cursor-default",
                )}
              >
                {/* Status dot */}
                <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
                  {isCompleted ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                  ) : isCurrent ? (
                    <span className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
                  ) : isValidNext ? (
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                  ) : (
                    <span className="w-2 h-2 rounded-full bg-muted-foreground/20" />
                  )}
                </span>

                {/* Label */}
                <span className="flex-1 font-medium leading-tight">{stage.label}</span>

                {/* Milestone badge */}
                {isMilestone && (
                  <Star className="w-3 h-3 text-amber-500 flex-shrink-0 fill-amber-400" />
                )}

                {/* Arrow for valid next */}
                {isValidNext && (
                  <ChevronRight className="w-3 h-3 flex-shrink-0 text-amber-500" />
                )}

                {isPending && isValidNext && (
                  <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
                )}
              </button>

              {/* Portal visibility toggle for completed milestones */}
              {isMilestone && isCompleted && (
                <div className="ml-7 mt-0.5 mb-1">
                  <button
                    type="button"
                    disabled={togglingStage === stage.stage}
                    onClick={() => handlePortalToggle(stage.stage)}
                    className={cn(
                      "flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border transition-colors",
                      portalVisibility[stage.stage]
                        ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
                        : "bg-muted text-muted-foreground border-border hover:bg-muted/70"
                    )}
                    title={portalVisibility[stage.stage] ? "Hide from client portal" : "Share with client portal"}
                  >
                    {togglingStage === stage.stage ? (
                      <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    ) : portalVisibility[stage.stage] ? (
                      <Eye className="w-2.5 h-2.5" />
                    ) : (
                      <EyeOff className="w-2.5 h-2.5" />
                    )}
                    {portalVisibility[stage.stage] ? "Shared with client" : "Share with client"}
                  </button>
                </div>
              )}

              {/* Stage history rows */}
              {historyEvents.map((evt) => {
                const isOverride = evt.metadata?.is_override === true
                const isFailed = evt.event_type?.includes("FAILED")
                const from = evt.metadata?.from_state as string | undefined
                const enteredAt = new Date(evt.created_at)
                let duration: string | null = null
                const laterIdx = lifecycleEvents.findIndex(
                  (e) => e.metadata?.from_state === stage.stage && new Date(e.created_at) > enteredAt
                )
                if (laterIdx !== -1) {
                  const ms = new Date(lifecycleEvents[laterIdx].created_at).getTime() - enteredAt.getTime()
                  const days = Math.floor(ms / 86400000)
                  duration = days === 0 ? "< 1 day" : `${days}d`
                }

                return (
                  <div
                    key={evt.id}
                    className="ml-7 mt-0.5 mb-1 px-2 py-1 rounded bg-muted/40 text-xs flex items-center gap-1.5"
                  >
                    {from && (
                      <span className="text-muted-foreground truncate">from {from.replace(/_/g, " ").toLowerCase()}</span>
                    )}
                    {duration && (
                      <span className="text-muted-foreground">· {duration}</span>
                    )}
                    {isOverride && (
                      <span className="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800">
                        OVERRIDE
                      </span>
                    )}
                    {isFailed && (
                      <span className="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-destructive/10 text-destructive">
                        FAILED
                      </span>
                    )}
                  </div>
                )
              })}

              {/* System gate chips */}
              {stage.enablesSystemGates?.map((gate) => (
                <div
                  key={gate}
                  className={cn(
                    "ml-7 mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium mr-1",
                    completedStages.has(stage.stage) || isCurrent
                      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                      : "bg-muted text-muted-foreground border border-border"
                  )}
                >
                  {gate.replace(/_/g, " ")} unlocked
                </div>
              ))}
            </li>
          )
        })}
      </ol>

      {/* Stage advance modal */}
      {selectedStage && (
        <StageAdvanceModal
          stage={selectedStage}
          listingId={listingId}
          canOverride={canOverride}
          isPending={isPending}
          onConfirm={handleConfirm}
          onClose={() => setSelectedStage(null)}
        />
      )}
    </>
  )
}
